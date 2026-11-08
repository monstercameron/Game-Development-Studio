"""Experimental SAM 3.1 still-image detector for an isolated Forge worker.

The detector architecture is the same one assembled by Meta's SAM 3.1
multiplex predictor. This module does not start a service or perform resource
admission. A caller must check both host and GPU memory before loading it.
"""

import re
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

OUTPUTS = ("transparent", "mask", "outline", "cropped")
# all: every match combined. best: the highest-scoring match. largest: the match with the most
# pixels. top: the max_instances highest-scoring matches.
SELECTIONS = ("all", "best", "largest", "top")
MAX_INSTANCES = 50
# The job status lists at most this many matches (best score first) to keep it small.
MAX_REPORTED_MATCHES = 20
OUTLINE_COLOR = (255, 45, 149, 255)

_DERIVED_ROPE = re.compile(
    r"^backbone\.vision_backbone\.trunk\.blocks\.\d+\.attn\.freqs_cis_(real|imag)$"
)


def _check_compatibility(model, state):
    expected = model.state_dict()
    missing = sorted(set(expected) - set(state))
    unexpected = sorted(set(state) - set(expected))
    incompatible = sorted(
        key for key in set(expected) & set(state) if expected[key].shape != state[key].shape
    )
    derived = [key for key in missing if _DERIVED_ROPE.fullmatch(key)]
    missing = [key for key in missing if key not in derived]
    return {
        "missing": missing,
        "unexpected": unexpected,
        "incompatible": incompatible,
        "derived_buffers": derived,
    }


def _restore_derived_buffers(model, names):
    for name in names:
        parent_name, field = name.rsplit(".", 1)
        parent = model.get_submodule(parent_name)
        value = parent.freqs_cis.real if field.endswith("_real") else parent.freqs_cis.imag
        setattr(parent, field, value.clone())


def _build_detector():
    from sam3 import model_builder as builder
    from sam3.model.sam3_multiplex_detector import Sam3MultiplexDetector
    from sam3.model.vl_combiner import SAM3VLBackboneTri

    bpe_path = str(Path(builder.__file__).parent / "assets" / "bpe_simple_vocab_16e6.txt.gz")
    tri_neck = builder._create_multiplex_tri_backbone(
        compile_mode=None, use_fa3=False, use_rope_real=True
    )
    backbone = SAM3VLBackboneTri(
        scalp=0, visual=tri_neck, text=builder._create_text_encoder(bpe_path)
    )
    return Sam3MultiplexDetector(
        num_feature_levels=1,
        backbone=backbone,
        transformer=builder._create_sam3_transformer(use_fa3=False),
        segmentation_head=builder._create_segmentation_head(use_fa3=False),
        semantic_segmentation_head=None,
        input_geometry_encoder=builder._create_geometry_encoder(),
        use_early_fusion=True,
        use_dot_prod_scoring=True,
        dot_prod_scoring=builder._create_dot_product_scoring(),
        supervise_joint_box_scores=True,
        is_multiplex=True,
    )


def inspect_checkpoint(checkpoint_path):
    """Check architecture and checkpoint compatibility without loading GPU weights."""
    from accelerate import init_empty_weights

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True, mmap=True)
    checkpoint = checkpoint.get("model", checkpoint)
    state = {
        key.removeprefix("detector."): value
        for key, value in checkpoint.items()
        if key.startswith("detector.")
    }
    if not state:
        raise RuntimeError("The SAM 3.1 checkpoint contains no detector weights.")
    with init_empty_weights():
        model = _build_detector()
    return {
        **_check_compatibility(model, state),
        "tensors": len(state),
        "bytes": sum(v.numel() * v.element_size() for v in state.values()),
    }


def load_detector(checkpoint_path, device="cuda"):
    """Load only detector weights, avoiding a duplicate in-memory checkpoint."""
    from accelerate import init_empty_weights
    from sam3.model.sam3_image_processor import Sam3Processor

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable in the SAM 3.1 runtime.")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True, mmap=True)
    checkpoint = checkpoint.get("model", checkpoint)
    state = {
        key.removeprefix("detector."): value
        for key, value in checkpoint.items()
        if key.startswith("detector.")
    }
    if not state:
        raise RuntimeError("The SAM 3.1 checkpoint contains no detector weights.")
    with init_empty_weights():
        model = _build_detector()
    compatibility = _check_compatibility(model, state)
    if compatibility["missing"] or compatibility["unexpected"] or compatibility["incompatible"]:
        raise RuntimeError(f"SAM 3.1 detector checkpoint does not match: {compatibility}")
    model.load_state_dict(state, strict=False, assign=True)
    # These optional real-valued RoPE buffers are not in Meta's checkpoint;
    # derive them from the loaded complex frequencies, not random weights.
    _restore_derived_buffers(model, compatibility["derived_buffers"])
    model = model.to(device=device).eval()
    return Sam3Processor(model, device=device)


def _mask_boxes(masks):
    """Return (x0, y0, x1, y1) with exclusive ends for each (N, H, W) mask, or None if empty."""
    rows = masks.any(dim=2).cpu().numpy()
    columns = masks.any(dim=1).cpu().numpy()
    boxes = []
    for row, column in zip(rows, columns, strict=True):
        ys = np.flatnonzero(row)
        xs = np.flatnonzero(column)
        if ys.size == 0 or xs.size == 0:
            boxes.append(None)
        else:
            boxes.append((int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1))
    return boxes


def _select_matches(select, max_instances, scores, areas):
    """Pick which non-empty matches to keep; the result is ordered best score first."""
    candidates = [index for index, area in enumerate(areas) if area > 0]
    if not candidates:
        return []
    by_score = sorted(candidates, key=lambda i: (-scores[i], -areas[i], i))
    if select == "best":
        return by_score[:1]
    if select == "largest":
        return [max(candidates, key=lambda i: (areas[i], scores[i], -i))]
    if select == "top":
        return by_score[:max_instances]
    return by_score


def _outline(mask, thickness):
    """Return the inner border of a boolean mask; the image edge itself is not outlined."""
    inner = mask
    for _ in range(thickness):
        padded = np.pad(inner, 1, mode="edge")
        inner = (
            padded[1:-1, 1:-1]
            & padded[:-2, 1:-1]
            & padded[2:, 1:-1]
            & padded[1:-1, :-2]
            & padded[1:-1, 2:]
        )
    return mask & ~inner


def segment_image(
    processor,
    image,
    prompt,
    *,
    output="transparent",
    confidence=0.5,
    select="all",
    max_instances=None,
):
    """Generate a mask, cutout, outline overlay or cropped cutout using a loaded detector.

    output is transparent (cutout on the full image), mask (white on black), outline (the
    original with each kept match outlined) or cropped (cutout trimmed to the kept matches
    plus padding). select chooses which matches are kept; see SELECTIONS. The metadata lists
    every match found (up to MAX_REPORTED_MATCHES) with its model score.

    Results from real SAM 3.1 inference have not yet been validated on this
    platform. Callers must serialize access to a processor and admit its GPU
    working memory before invoking this function.
    """
    if not isinstance(image, Image.Image):
        raise TypeError("The reference must be a Pillow image.")
    if image.width <= 0 or image.height <= 0 or image.width * image.height > 20_000_000:
        raise ValueError("The reference image dimensions are too large.")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 1000:
        raise ValueError("Describe what to isolate in 1–1000 characters.")
    if output not in OUTPUTS:
        raise ValueError(f"Output must be one of: {', '.join(OUTPUTS)}.")
    if select not in SELECTIONS:
        raise ValueError(f"Select must be one of: {', '.join(SELECTIONS)}.")
    if select == "top":
        if (
            isinstance(max_instances, bool)
            or not isinstance(max_instances, int)
            or not 1 <= max_instances <= MAX_INSTANCES
        ):
            raise ValueError(f"max_instances must be a whole number from 1 to {MAX_INSTANCES}.")
    elif max_instances is not None:
        raise ValueError("max_instances only applies when select is top.")
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not 0 <= confidence <= 1
    ):
        raise ValueError("Confidence must be between 0 and 1.")
    source = ImageOps.exif_transpose(image).convert("RGBA")
    processor.set_confidence_threshold(float(confidence))
    # Meta's predictor runs inference using bfloat16 autocast on CUDA. The
    # explicit context is essential when this function runs in a worker thread.
    with torch.inference_mode():
        with torch.autocast(
            device_type="cuda",
            dtype=torch.bfloat16,
            enabled=str(processor.device).startswith("cuda"),
        ):
            state = processor.set_image(source.convert("RGB"))
            state = processor.set_text_prompt(prompt.strip(), state)
    masks = state.get("masks")
    scores = state.get("scores")
    if (
        not isinstance(masks, torch.Tensor)
        or masks.dtype != torch.bool
        or masks.ndim != 4
        or masks.shape[1] != 1
        or tuple(masks.shape[2:]) != (source.height, source.width)
    ):
        raise RuntimeError("The segmentation model returned invalid masks.")
    if (
        not isinstance(scores, torch.Tensor)
        or scores.ndim != 1
        or scores.shape[0] != masks.shape[0]
    ):
        raise RuntimeError("The segmentation model returned invalid confidence scores.")
    if masks.shape[0] == 0:
        raise ValueError(
            "No matching objects were found. Try another description or confidence threshold."
        )
    instance_masks = masks[:, 0]
    areas = [int(value) for value in instance_masks.flatten(1).sum(dim=1).cpu().tolist()]
    # A non-finite score is reported as 0 so the job status stays valid JSON.
    score_values = [value if np.isfinite(value) else 0.0 for value in scores.float().cpu().tolist()]
    chosen = _select_matches(select, max_instances, score_values, areas)
    if not chosen:
        raise ValueError("The selected objects have empty masks. Try another description.")
    union = (
        instance_masks[torch.as_tensor(chosen, device=instance_masks.device)]
        .any(dim=0)
        .cpu()
        .numpy()
    )
    metadata = {"instances": int(masks.shape[0]), "used": len(chosen), "select": select}
    if output == "mask":
        result = Image.fromarray(union.astype(np.uint8) * 255)
    elif output == "outline":
        rgba = np.array(source, dtype=np.uint8, copy=True)
        thickness = min(8, max(2, round(min(source.width, source.height) / 250)))
        border = np.zeros(union.shape, dtype=bool)
        for index in chosen:
            border |= _outline(instance_masks[index].cpu().numpy(), thickness)
        rgba[border] = OUTLINE_COLOR
        result = Image.fromarray(rgba)
    else:
        rgba = np.array(source, dtype=np.uint8, copy=True)
        rgba[:, :, 3] = np.where(union, rgba[:, :, 3], 0)
        if output == "cropped":
            ys = np.flatnonzero(union.any(axis=1))
            xs = np.flatnonzero(union.any(axis=0))
            x0, y0, x1, y1 = int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1
            padding = max(4, round(0.05 * max(x1 - x0, y1 - y0)))
            x0, y0 = max(0, x0 - padding), max(0, y0 - padding)
            x1, y1 = min(source.width, x1 + padding), min(source.height, y1 + padding)
            rgba = rgba[y0:y1, x0:x1]
            metadata["cropBox"] = [x0, y0, x1, y1]
        result = Image.fromarray(rgba)
    reported = sorted(range(len(score_values)), key=lambda i: (-score_values[i], -areas[i], i))
    reported = reported[:MAX_REPORTED_MATCHES]
    boxes = _mask_boxes(instance_masks[torch.as_tensor(reported, device=masks.device)])
    metadata["selectedPixels"] = int(union.sum())
    metadata["matches"] = [
        {
            "score": round(score_values[index], 4),
            "area": areas[index],
            "box": list(box) if box is not None else None,
            "selected": index in chosen,
        }
        for index, box in zip(reported, boxes, strict=True)
    ]
    return result, metadata
