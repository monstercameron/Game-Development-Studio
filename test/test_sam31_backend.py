"""Run with the Forge SAM Python runtime; the full checkpoint test is opt-in."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import torch
from PIL import Image
from sam31_backend import (
    MAX_REPORTED_MATCHES,
    OUTLINE_COLOR,
    _check_compatibility,
    _restore_derived_buffers,
    inspect_checkpoint,
    load_detector,
    segment_image,
)


class FakeDetector(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = torch.nn.Module()
        self.backbone.vision_backbone = torch.nn.Module()
        self.backbone.vision_backbone.trunk = torch.nn.Module()
        block = torch.nn.Module()
        block.attn = torch.nn.Module()
        block.attn.register_buffer("freqs_cis", torch.tensor([2 + 3j]))
        block.attn.register_buffer("freqs_cis_real", torch.tensor([0.0]))
        block.attn.register_buffer("freqs_cis_imag", torch.tensor([0.0]))
        block.attn.weight = torch.nn.Parameter(torch.ones(2))
        self.backbone.vision_backbone.trunk.blocks = torch.nn.ModuleList([block])


class Sam31LoaderTests(unittest.TestCase):
    def test_checkpoint_checks_and_rebuilds_only_known_derived_buffers(self):
        model = FakeDetector()
        state = {
            k: v.clone()
            for k, v in model.state_dict().items()
            if not (k.endswith("freqs_cis_real") or k.endswith("freqs_cis_imag"))
        }
        prefix = "backbone.vision_backbone.trunk.blocks.0.attn."
        state[prefix + "freqs_cis"] = torch.tensor([7 + 11j])
        compatibility = _check_compatibility(model, state)
        self.assertEqual(compatibility["missing"], [])
        self.assertEqual(compatibility["unexpected"], [])
        self.assertEqual(compatibility["incompatible"], [])
        self.assertEqual(len(compatibility["derived_buffers"]), 2)
        model.load_state_dict(state, strict=False, assign=True)
        _restore_derived_buffers(model, compatibility["derived_buffers"])
        self.assertEqual(
            model.backbone.vision_backbone.trunk.blocks[0].attn.freqs_cis_real.item(), 7
        )
        self.assertEqual(
            model.backbone.vision_backbone.trunk.blocks[0].attn.freqs_cis_imag.item(), 11
        )

    def test_missing_unexpected_and_wrong_shape_are_rejected(self):
        model = FakeDetector()
        state = dict(model.state_dict())
        prefix = "backbone.vision_backbone.trunk.blocks.0.attn."
        del state[prefix + "weight"]
        state[prefix + "freqs_cis"] = torch.zeros(2, dtype=torch.complex64)
        state["unknown"] = torch.zeros(1)
        result = _check_compatibility(model, state)
        self.assertEqual(result["missing"], [prefix + "weight"])
        self.assertEqual(result["incompatible"], [prefix + "freqs_cis"])
        self.assertEqual(result["unexpected"], ["unknown"])

    def test_loader_assigns_mapped_checkpoint_and_rebuilds_buffers_on_cpu(self):
        source = FakeDetector()
        state = {
            "detector." + k: v.clone()
            for k, v in source.state_dict().items()
            if not (k.endswith("freqs_cis_real") or k.endswith("freqs_cis_imag"))
        }
        prefix = "detector.backbone.vision_backbone.trunk.blocks.0.attn."
        state[prefix + "freqs_cis"] = torch.tensor([7 + 11j])
        state[prefix + "weight"] = torch.tensor([4.0, 5.0])
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / "model.pt"
            torch.save({"model": state}, checkpoint)
            with patch("sam31_backend._build_detector", FakeDetector):
                processor = load_detector(checkpoint, device="cpu")
        attn = processor.model.backbone.vision_backbone.trunk.blocks[0].attn
        self.assertEqual(attn.weight.tolist(), [4.0, 5.0])
        self.assertEqual(attn.freqs_cis_real.item(), 7)
        self.assertEqual(attn.freqs_cis_imag.item(), 11)
        self.assertFalse(processor.model.training)

    @unittest.skipUnless(
        os.environ.get("FORGE_TEST_SAM31_CHECKPOINT"), "checkpoint test not enabled"
    )
    def test_downloaded_checkpoint_matches_detector(self):
        result = inspect_checkpoint(os.environ["FORGE_TEST_SAM31_CHECKPOINT"])
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["unexpected"], [])
        self.assertEqual(result["incompatible"], [])
        self.assertGreater(result["tensors"], 1000)
        self.assertGreater(result["bytes"], 3 * 1024**3)


class FakeProcessor:
    device = "cpu"

    def __init__(self, masks, scores):
        self.masks = masks
        self.scores = scores

    def set_confidence_threshold(self, value):
        self.confidence = value

    def set_image(self, image):
        self.image = image
        return {"image": True}

    def set_text_prompt(self, prompt, state):
        self.prompt = prompt
        return {**state, "masks": self.masks, "scores": self.scores}


class Sam31OutputTests(unittest.TestCase):
    def test_union_mask_preserves_existing_alpha_and_produces_mask_export(self):
        source = Image.new("RGBA", (2, 2))
        source.putdata([(20, 30, 40, 80), (10, 20, 30, 255), (90, 80, 70, 120), (1, 2, 3, 255)])
        masks = torch.tensor([[[[1, 0], [0, 0]]], [[[0, 0], [1, 0]]]], dtype=torch.bool)
        processor = FakeProcessor(masks, torch.tensor([0.8, 0.7]))
        cutout, metadata = segment_image(processor, source, "  tree  ", confidence=0.4)
        self.assertEqual(list(cutout.getchannel("A").getdata()), [80, 0, 120, 0])
        self.assertEqual(metadata["instances"], 2)
        self.assertEqual(metadata["used"], 2)
        self.assertEqual(metadata["selectedPixels"], 2)
        self.assertEqual(processor.prompt, "tree")
        self.assertEqual(processor.confidence, 0.4)
        self.assertEqual(processor.image.mode, "RGB")
        mask, _ = segment_image(processor, source, "tree", output="mask")
        self.assertEqual(mask.mode, "L")
        self.assertEqual(list(mask.getdata()), [255, 0, 255, 0])

    def test_empty_or_malformed_model_results_fail_without_creating_a_blank_asset(self):
        source = Image.new("RGB", (2, 2))
        with self.assertRaisesRegex(ValueError, "No matching objects"):
            segment_image(
                FakeProcessor(torch.zeros((0, 1, 2, 2), dtype=torch.bool), torch.zeros(0)),
                source,
                "tree",
            )
        with self.assertRaisesRegex(ValueError, "empty masks"):
            segment_image(
                FakeProcessor(torch.zeros((1, 1, 2, 2), dtype=torch.bool), torch.ones(1)),
                source,
                "tree",
            )
        with self.assertRaisesRegex(RuntimeError, "invalid masks"):
            segment_image(
                FakeProcessor(torch.ones((1, 2, 2), dtype=torch.bool), torch.ones(1)),
                source,
                "tree",
            )
        with self.assertRaisesRegex(RuntimeError, "invalid confidence scores"):
            segment_image(
                FakeProcessor(torch.ones((1, 1, 2, 2), dtype=torch.bool), torch.ones(2)),
                source,
                "tree",
            )

    def test_rejects_invalid_match_selection(self):
        processor = FakeProcessor(torch.ones((1, 1, 2, 2), dtype=torch.bool), torch.ones(1))
        source = Image.new("RGB", (2, 2))
        for select, max_instances in [
            ("some", None),
            ("top", None),
            ("top", 0),
            ("top", 51),
            ("top", True),
            ("top", 1.5),
            ("best", 2),
            ("all", 1),
        ]:
            with self.subTest(select=select, max_instances=max_instances):
                with self.assertRaises(ValueError):
                    segment_image(
                        processor, source, "tree", select=select, max_instances=max_instances
                    )

    def test_rejects_invalid_prompts_output_and_confidence(self):
        processor = FakeProcessor(torch.ones((1, 1, 2, 2), dtype=torch.bool), torch.ones(1))
        source = Image.new("RGB", (2, 2))
        for prompt, output, confidence in [
            ("", "mask", 0.5),
            ("tree", "jpg", 0.5),
            ("tree", "mask", float("nan")),
            ("tree", "mask", True),
        ]:
            with self.subTest(prompt=prompt, output=output, confidence=confidence):
                with self.assertRaises(ValueError):
                    segment_image(processor, source, prompt, output=output, confidence=confidence)


def three_matches():
    """Three 4x4 matches: a 1-pixel high-score dot, a 4-pixel mid-score square, a 6-pixel
    low-score bar. Scores are deliberately not sorted."""
    masks = torch.zeros((3, 1, 4, 4), dtype=torch.bool)
    masks[0, 0, 0, 0] = True
    masks[1, 0, 1:3, 1:3] = True
    masks[2, 0, 3, 0:4] = True
    masks[2, 0, 2, 0:2] = True
    return FakeProcessor(masks, torch.tensor([0.9, 0.6, 0.7]))


def solid_source():
    return Image.new("RGBA", (4, 4), (10, 20, 30, 255))


def alpha_pixels(image):
    return list(image.getchannel("A").getdata())


class Sam31MatchSelectionTests(unittest.TestCase):
    def test_all_matches_are_combined_by_default(self):
        cutout, metadata = segment_image(three_matches(), solid_source(), "tree")
        self.assertEqual(sum(1 for value in alpha_pixels(cutout) if value), 10)
        self.assertEqual(metadata["instances"], 3)
        self.assertEqual(metadata["used"], 3)
        self.assertEqual(metadata["select"], "all")
        self.assertEqual(metadata["selectedPixels"], 10)

    def test_best_keeps_only_the_highest_score_even_when_unsorted(self):
        cutout, metadata = segment_image(three_matches(), solid_source(), "tree", select="best")
        self.assertEqual(sum(1 for value in alpha_pixels(cutout) if value), 1)
        self.assertEqual(alpha_pixels(cutout)[0], 255)
        self.assertEqual(metadata["used"], 1)
        self.assertEqual(metadata["instances"], 3)

    def test_largest_keeps_the_biggest_mask_not_the_best_score(self):
        _, metadata = segment_image(
            three_matches(), solid_source(), "tree", output="mask", select="largest"
        )
        self.assertEqual(metadata["selectedPixels"], 6)
        selected = [match for match in metadata["matches"] if match["selected"]]
        self.assertEqual([match["area"] for match in selected], [6])
        self.assertEqual(selected[0]["score"], 0.7)

    def test_top_keeps_n_best_scores_and_all_when_n_is_larger(self):
        _, metadata = segment_image(
            three_matches(), solid_source(), "tree", output="mask", select="top", max_instances=2
        )
        self.assertEqual(metadata["used"], 2)
        self.assertEqual(metadata["selectedPixels"], 1 + 6)
        _, everything = segment_image(
            three_matches(), solid_source(), "tree", select="top", max_instances=50
        )
        self.assertEqual(everything["used"], 3)

    def test_matches_are_reported_best_score_first_with_mask_boxes(self):
        _, metadata = segment_image(three_matches(), solid_source(), "tree", select="best")
        self.assertEqual([match["score"] for match in metadata["matches"]], [0.9, 0.7, 0.6])
        self.assertEqual([match["selected"] for match in metadata["matches"]], [True, False, False])
        self.assertEqual(metadata["matches"][0]["box"], [0, 0, 1, 1])
        self.assertEqual(metadata["matches"][1]["box"], [0, 2, 4, 4])
        self.assertEqual(metadata["matches"][2]["box"], [1, 1, 3, 3])

    def test_empty_masks_are_never_selected_and_non_finite_scores_report_as_zero(self):
        masks = torch.zeros((2, 1, 2, 2), dtype=torch.bool)
        masks[1, 0, 0, 0] = True
        processor = FakeProcessor(masks, torch.tensor([0.99, float("nan")]))
        _, metadata = segment_image(
            processor, Image.new("RGB", (2, 2)), "tree", output="mask", select="best"
        )
        self.assertEqual(metadata["used"], 1)
        self.assertEqual(metadata["selectedPixels"], 1)
        self.assertEqual([match["score"] for match in metadata["matches"]], [0.99, 0.0])
        for match in metadata["matches"]:
            json.dumps(match, allow_nan=False)

    def test_reported_matches_are_capped(self):
        count = MAX_REPORTED_MATCHES + 5
        masks = torch.ones((count, 1, 2, 2), dtype=torch.bool)
        processor = FakeProcessor(masks, torch.linspace(0.5, 0.9, count))
        _, metadata = segment_image(processor, Image.new("RGB", (2, 2)), "tree")
        self.assertEqual(metadata["instances"], count)
        self.assertEqual(len(metadata["matches"]), MAX_REPORTED_MATCHES)


class Sam31ExtraOutputTests(unittest.TestCase):
    def test_outline_draws_only_the_border_and_keeps_the_picture(self):
        masks = torch.zeros((1, 1, 12, 12), dtype=torch.bool)
        masks[0, 0, 3:9, 3:9] = True
        source = Image.new("RGBA", (12, 12), (10, 20, 30, 255))
        overlay, metadata = segment_image(
            FakeProcessor(masks, torch.ones(1)), source, "tree", output="outline"
        )
        self.assertEqual(overlay.size, (12, 12))
        self.assertEqual(overlay.getpixel((3, 3)), OUTLINE_COLOR)
        self.assertEqual(overlay.getpixel((8, 8)), OUTLINE_COLOR)
        self.assertEqual(overlay.getpixel((5, 5)), (10, 20, 30, 255))
        self.assertEqual(overlay.getpixel((0, 0)), (10, 20, 30, 255))
        self.assertEqual(metadata["selectedPixels"], 36)

    def test_outline_does_not_draw_along_the_image_edge(self):
        masks = torch.ones((1, 1, 6, 6), dtype=torch.bool)
        overlay, _ = segment_image(
            FakeProcessor(masks, torch.ones(1)),
            Image.new("RGBA", (6, 6), (1, 2, 3, 255)),
            "tree",
            output="outline",
        )
        self.assertEqual(set(overlay.getdata()), {(1, 2, 3, 255)})

    def test_cropped_cutout_trims_to_the_kept_matches_with_padding(self):
        masks = torch.zeros((2, 1, 40, 40), dtype=torch.bool)
        masks[0, 0, 10:20, 10:20] = True
        masks[1, 0, 30:35, 30:35] = True
        processor = FakeProcessor(masks, torch.tensor([0.9, 0.5]))
        source = Image.new("RGBA", (40, 40), (10, 20, 30, 255))
        cropped, metadata = segment_image(
            processor, source, "tree", output="cropped", select="best"
        )
        # A 10 px object gets max(4, round(0.5)) = 4 px of padding on each side.
        self.assertEqual(metadata["cropBox"], [6, 6, 24, 24])
        self.assertEqual(cropped.size, (18, 18))
        self.assertEqual(cropped.getpixel((0, 0))[3], 0)
        self.assertEqual(cropped.getpixel((4, 4)), (10, 20, 30, 255))
        everything, wide = segment_image(processor, source, "tree", output="cropped")
        self.assertEqual(wide["cropBox"], [6, 6, 39, 39])
        self.assertEqual(everything.size, (33, 33))

    def test_cropped_cutout_padding_stays_inside_the_image(self):
        masks = torch.zeros((1, 1, 8, 8), dtype=torch.bool)
        masks[0, 0, 0:3, 5:8] = True
        cropped, metadata = segment_image(
            FakeProcessor(masks, torch.ones(1)),
            Image.new("RGBA", (8, 8), (9, 9, 9, 255)),
            "tree",
            output="cropped",
        )
        self.assertEqual(metadata["cropBox"], [1, 0, 8, 7])
        self.assertEqual(cropped.size, (7, 7))


if __name__ == "__main__":
    unittest.main()
