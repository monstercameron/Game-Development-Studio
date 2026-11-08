"""Test the fused img_mlp.gate_up split used when Qwen Image Studio loads the camera-angle LoRA.

The conversion lives in the external Qwen Image Studio app.py (outside this repository), so the
test loads that file by path. It needs that app's .venv (torch, safetensors, fastapi), for example:

    .\\..\\Qwen Image Studio\\.venv\\Scripts\\python.exe -I test\\qwen_lora_gate_up_test.py

It uses tiny CPU tensors and reads only the safetensors header of the real LoRA file. It never
loads the Qwen model and never uses the GPU.
"""

import importlib.util
import os
import unittest
from pathlib import Path

import torch
from safetensors import safe_open

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_DIR = Path.home() / "Desktop" / "Qwen Image Studio"
APP_DIR = Path(os.environ.get("FORGE_QWEN_IMAGE_STUDIO_DIR", str(DEFAULT_APP_DIR)))
REAL_LORA = REPO_ROOT / "models" / "Qwen-Image-2.1-LoRA" / "angles_v2_step1500.safetensors"


def load_app_module():
    spec = importlib.util.spec_from_file_location("qwen_app_under_test", APP_DIR / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


app_module = load_app_module()
split_fused_gate_up = app_module.split_fused_gate_up
has_fused_gate_up = app_module.has_fused_gate_up
PREFIX = "diffusion_model.transformer_blocks.0.img_mlp"
RANK = 2
IN_FEATURES = 3
HALF_OUT = 3


def fused_state_dict(seed=0, with_alpha=False):
    generator = torch.Generator().manual_seed(seed)
    state = {
        f"{PREFIX}.gate_up.lora_A.weight": torch.randn(RANK, IN_FEATURES, generator=generator),
        f"{PREFIX}.gate_up.lora_B.weight": torch.randn(2 * HALF_OUT, RANK, generator=generator),
        f"{PREFIX}.out.lora_A.weight": torch.randn(RANK, 2 * HALF_OUT, generator=generator),
        f"{PREFIX}.out.lora_B.weight": torch.randn(IN_FEATURES, RANK, generator=generator),
    }
    if with_alpha:
        state[f"{PREFIX}.gate_up.alpha"] = torch.tensor(float(RANK))
    return state


class SplitFusedGateUpTest(unittest.TestCase):
    def test_gate_first_puts_first_half_on_gate_layer(self):
        source = fused_state_dict()
        converted = split_fused_gate_up(source, "gate_first")
        fused_b = source[f"{PREFIX}.gate_up.lora_B.weight"]
        lora_a = source[f"{PREFIX}.gate_up.lora_A.weight"]
        self.assertTrue(
            torch.equal(converted[f"{PREFIX}.gate_layer.lora_B.weight"], fused_b[:HALF_OUT])
        )
        self.assertTrue(torch.equal(converted[f"{PREFIX}.proj.lora_B.weight"], fused_b[HALF_OUT:]))
        self.assertTrue(torch.equal(converted[f"{PREFIX}.gate_layer.lora_A.weight"], lora_a))
        self.assertTrue(torch.equal(converted[f"{PREFIX}.proj.lora_A.weight"], lora_a))

    def test_proj_first_reverses_the_halves(self):
        source = fused_state_dict()
        converted = split_fused_gate_up(source, "proj_first")
        fused_b = source[f"{PREFIX}.gate_up.lora_B.weight"]
        self.assertTrue(torch.equal(converted[f"{PREFIX}.proj.lora_B.weight"], fused_b[:HALF_OUT]))
        self.assertTrue(
            torch.equal(converted[f"{PREFIX}.gate_layer.lora_B.weight"], fused_b[HALF_OUT:])
        )

    def test_split_matches_fused_delta_rows_for_both_orders(self):
        source = fused_state_dict(seed=3)
        fused_delta = (
            source[f"{PREFIX}.gate_up.lora_B.weight"] @ source[f"{PREFIX}.gate_up.lora_A.weight"]
        )
        hidden = torch.randn(IN_FEATURES, generator=torch.Generator().manual_seed(9))
        for order, first_target in (("gate_first", "gate_layer"), ("proj_first", "proj")):
            converted = split_fused_gate_up(source, order)
            first_delta = (
                converted[f"{PREFIX}.{first_target}.lora_B.weight"]
                @ converted[f"{PREFIX}.{first_target}.lora_A.weight"]
            )
            self.assertTrue(torch.allclose(first_delta @ hidden, (fused_delta @ hidden)[:HALF_OUT]))

    def test_alpha_is_copied_to_both_targets(self):
        converted = split_fused_gate_up(fused_state_dict(with_alpha=True), "gate_first")
        self.assertEqual(float(converted[f"{PREFIX}.gate_layer.alpha"]), float(RANK))
        self.assertEqual(float(converted[f"{PREFIX}.proj.alpha"]), float(RANK))
        self.assertNotIn(f"{PREFIX}.gate_up.alpha", converted)

    def test_unrelated_keys_are_kept_and_fused_keys_removed(self):
        source = fused_state_dict()
        converted = split_fused_gate_up(source, "gate_first")
        self.assertTrue(
            torch.equal(
                converted[f"{PREFIX}.out.lora_A.weight"], source[f"{PREFIX}.out.lora_A.weight"]
            )
        )
        self.assertTrue(
            torch.equal(
                converted[f"{PREFIX}.out.lora_B.weight"], source[f"{PREFIX}.out.lora_B.weight"]
            )
        )
        self.assertFalse(any("gate_up" in key for key in converted))
        self.assertEqual(len(converted), 6)

    def test_state_without_fused_keys_is_unchanged(self):
        source = {f"{PREFIX}.out.lora_A.weight": torch.zeros(RANK, 4)}
        self.assertFalse(has_fused_gate_up(source))
        self.assertEqual(set(split_fused_gate_up(source, "gate_first")), set(source))

    def test_detection_only_matches_mlp_gate_up(self):
        self.assertTrue(has_fused_gate_up([f"{PREFIX}.gate_up.lora_A.weight"]))
        self.assertTrue(has_fused_gate_up(["transformer_blocks.3.txt_mlp.gate_up.lora_B.weight"]))
        self.assertFalse(has_fused_gate_up(["transformer_blocks.3.attn.gate_up.lora_B.weight"]))
        self.assertFalse(has_fused_gate_up([f"{PREFIX}.gate_layer.lora_B.weight"]))

    def test_rejects_unknown_order(self):
        with self.assertRaises(ValueError):
            split_fused_gate_up(fused_state_dict(), "skip")
        with self.assertRaises(ValueError):
            split_fused_gate_up(fused_state_dict(), "both")

    def test_rejects_odd_row_count(self):
        source = fused_state_dict()
        source[f"{PREFIX}.gate_up.lora_B.weight"] = torch.zeros(2 * HALF_OUT + 1, RANK)
        with self.assertRaises(ValueError):
            split_fused_gate_up(source, "gate_first")

    def test_rejects_rank_mismatch(self):
        source = fused_state_dict()
        source[f"{PREFIX}.gate_up.lora_A.weight"] = torch.zeros(RANK + 1, IN_FEATURES)
        with self.assertRaises(ValueError):
            split_fused_gate_up(source, "gate_first")

    def test_rejects_incomplete_pair(self):
        source = fused_state_dict()
        del source[f"{PREFIX}.gate_up.lora_A.weight"]
        with self.assertRaises(ValueError):
            split_fused_gate_up(source, "gate_first")

    def test_rejects_existing_target_key(self):
        source = fused_state_dict()
        source[f"{PREFIX}.proj.lora_A.weight"] = torch.zeros(RANK, IN_FEATURES)
        with self.assertRaises(ValueError):
            split_fused_gate_up(source, "gate_first")

    def test_real_lora_header_splits_to_2_1_layer_shapes(self):
        if not REAL_LORA.exists():
            self.skipTest("the camera-angle LoRA file is not present")
        with safe_open(str(REAL_LORA), framework="pt") as handle:
            shapes = {key: tuple(handle.get_slice(key).get_shape()) for key in handle.keys()}
        # Only block 0 is needed; the split is per block and the shapes are identical in every block.
        block_zero = {
            key: torch.empty(shape, dtype=torch.float16)
            for key, shape in shapes.items()
            if "transformer_blocks.0." in key
        }
        self.assertTrue(has_fused_gate_up(block_zero))
        converted = split_fused_gate_up(block_zero, "gate_first")
        self.assertEqual(tuple(converted[f"{PREFIX}.gate_layer.lora_B.weight"].shape), (12288, 64))
        self.assertEqual(tuple(converted[f"{PREFIX}.proj.lora_B.weight"].shape), (12288, 64))
        self.assertEqual(tuple(converted[f"{PREFIX}.gate_layer.lora_A.weight"].shape), (64, 4096))
        self.assertFalse(any("gate_up" in key for key in converted))


if __name__ == "__main__":
    unittest.main()
