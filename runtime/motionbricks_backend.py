"""MotionBricks' documented raw tensor interface.

This module does not manage workers, resource admission, pose alignment,
endpoint correction, or project assets; those are the caller's responsibility.
"""

import gc
import importlib
import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

MODELS = {"soma": "mmm_v6_soma_fp32.onnx", "g1": "mmm_v6_g1_fp32.onnx"}
MASKS = {
    "has_global_root_values": (1, 8),
    "has_local_root_values": (1, 8),
    "has_local_poses": (1, 8),
    "allowed_pred_num_tokens": (1, 11),
}
FLOATS = {
    "soma": {
        "global_root_values": (1, 8, 5),
        "local_root_values": (1, 8, 4),
        "local_poses": (1, 8, 267),
    },
    "g1": {"context_qpos": (1, 4, 36), "target_qpos": (1, 4, 36)},
}


def prepare_inputs(rig, values):
    """Validate the raw tensors for one rig and return them as NumPy arrays.

    Masks become int32 0/1 arrays and float tensors become float32. Raises
    ValueError for an unknown rig, a wrong key set, a shape or dtype mismatch,
    non-finite values, or a request that allows no token count.
    """
    if rig not in MODELS or not isinstance(values, dict):
        raise ValueError("Choose the SOMA or G1 model and provide its input tensors.")
    specs = {**FLOATS[rig], **MASKS}
    if set(values) != set(specs):
        raise ValueError(f"Expected exactly these tensors: {', '.join(specs)}.")
    result = {}
    for name, shape in specs.items():
        try:
            data = np.asarray(values[name])
        except (TypeError, ValueError) as error:
            raise ValueError(f"{name} must be a rectangular numeric array.") from error
        if data.shape != shape or data.dtype.kind not in "iuf":
            raise ValueError(f"{name} must be a numeric array of shape {shape}.")
        if not np.isfinite(data).all():
            raise ValueError(f"{name} must contain only finite values.")
        if name in MASKS:
            if not np.logical_or(data == 0, data == 1).all():
                raise ValueError(f"{name} must contain only 0 or 1.")
            result[name] = data.astype(np.int32)
        else:
            result[name] = data.astype(np.float32)
            if not np.isfinite(result[name]).all():
                raise ValueError(f"{name} contains values outside the FP32 range.")
    if not result["allowed_pred_num_tokens"].any():
        raise ValueError("Allow at least one motion token count.")
    if rig == "g1":
        for name in ("context_qpos", "target_qpos"):
            quaternions = result[name][..., 3:7].astype(np.float64)
            if np.any(np.linalg.norm(quaternions, axis=-1) < 1e-6):
                raise ValueError(f"{name} requires nonzero root quaternions in every slot.")
    return result


def load_model(model_dir, rig, *, threads=4):
    """Load the released SOMA graph onto CUDA and return a CudaSomaSession.

    Raises ValueError for an unsupported rig or thread count, and RuntimeError
    when CUDA is missing, fewer than 8 GiB of GPU memory is free, the model
    source or checkpoints are missing, or parameters did not reach the GPU.
    """
    if (
        rig not in MODELS
        or not isinstance(threads, int)
        or isinstance(threads, bool)
        or not 1 <= threads <= 8
    ):
        raise ValueError("Choose a supported model and 1–8 host threads.")
    if rig != "soma":
        raise RuntimeError("Only the SOMA CUDA model is connected. CPU fallback is disabled.")
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is unavailable. CPU fallback is disabled.")
    torch.set_num_threads(threads)
    free, _ = torch.cuda.mem_get_info()
    # Bytes. A fixed admission floor for this model, not a measured peak.
    if free < 8 * 1024**3:
        raise RuntimeError("At least 8 GiB of free GPU memory is required to load MotionBricks.")

    source = Path(
        os.environ.get(
            "FORGE_MOTIONBRICKS_SOURCE",
            Path(__file__).resolve().parent.parent / ".forge-runtime" / "motionbricks-src",
        )
    )
    package_dir = source / "tools" / "onnx"
    package_name = "forge_motionbricks_exporter"
    if package_name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            package_name, package_dir / "__init__.py", submodule_search_locations=[str(package_dir)]
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("The MotionBricks model source is missing.")
        package = importlib.util.module_from_spec(spec)
        sys.modules[package_name] = package
        try:
            spec.loader.exec_module(package)
        except Exception:
            sys.modules.pop(package_name, None)
            raise
    checksums = importlib.import_module(package_name + ".checksums")
    checkpoints = importlib.import_module(package_name + ".checkpoints")
    soma = importlib.import_module(package_name + ".models.soma")
    release = checksums.CHECKPOINTS["soma"]
    folder = checkpoints.checkpoint_root(Path(model_dir) / "checkpoints" / "soma", release)
    sources = checkpoints.load_sources(folder, release)
    try:
        model = soma.build_soma(sources)
    finally:
        del sources
        gc.collect()
    model = model.to("cuda").eval()
    model.model._device = "cuda"
    if any(parameter.device.type != "cuda" for parameter in model.parameters()):
        raise RuntimeError("MotionBricks model parameters are not on the GPU.")
    return CudaSomaSession(model, soma.INPUT_NAMES, soma.OUTPUT_NAMES, torch)


class CudaSomaSession:
    """Use the released PyTorch graph with CUDA; no CPU inference fallback."""

    def __init__(self, model, input_names, output_names, torch):
        self.model, self.input_names, self.output_names, self.torch = (
            model,
            input_names,
            output_names,
            torch,
        )

    def get_outputs(self):
        return [SimpleNamespace(name=name) for name in self.output_names]

    def run(self, output_names, inputs):
        torch = self.torch
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU is unavailable.")
        tensors = [torch.from_numpy(inputs[name]).to("cuda") for name in self.input_names]
        with torch.inference_mode():
            outputs = self.model(*tensors)
        torch.cuda.synchronize()
        if any(output.device.type != "cuda" for output in outputs):
            raise RuntimeError("MotionBricks output was not produced on the GPU.")
        result = {
            name: output.detach().cpu().numpy()
            for name, output in zip(self.output_names, outputs, strict=False)
        }
        return [result[name] for name in (output_names or self.output_names)]


def infer(session, rig, values):
    """Run one validated MotionBricks step and return the checked output dict.

    Raises ValueError for invalid inputs (see prepare_inputs) and RuntimeError
    when the session returns unexpected outputs, non-finite values, or a token
    count the request did not allow.
    """
    inputs = prepare_inputs(rig, values)
    output = dict(
        zip((item.name for item in session.get_outputs()), session.run(None, inputs), strict=False)
    )
    expected = {
        "soma": {"pred_global_motions": (1, 64, 366), "pred_num_tokens": (1,)},
        "g1": {"pred_qpos": (1, 64, 36), "pred_foot_contacts": (1, 64, 4), "pred_num_tokens": (1,)},
    }[rig]
    if set(output) != set(expected):
        raise RuntimeError("MotionBricks returned unexpected outputs.")
    for name, shape in expected.items():
        if output[name].shape != shape or not np.isfinite(output[name]).all():
            raise RuntimeError(f"MotionBricks returned invalid {name}.")
    token = output["pred_num_tokens"][0]
    # Token counts 6 to 16 map to columns 0 to 10 of allowed_pred_num_tokens.
    if (
        token != int(token)
        or not 6 <= int(token) <= 16
        or not inputs["allowed_pred_num_tokens"][0, int(token) - 6]
    ):
        raise RuntimeError("MotionBricks returned an invalid token count.")
    return output
