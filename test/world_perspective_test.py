"""Perspective reference coordinates should cover a view, not a full sphere."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from world_perspective import install_perspective_projection, perspective_rays


class PerspectiveTests(unittest.TestCase):
    def test_center_and_corners_are_forward_facing_unit_rays(self):
        rays = perspective_rays(5, 9, device="cpu", torch_module=torch)
        self.assertTrue(torch.allclose(rays.norm(dim=-1), torch.ones(5, 9), atol=1e-6))
        self.assertTrue(torch.allclose(rays[2, 4], torch.tensor([0.0, 0.0, 1.0])))
        self.assertLess(rays[2, 0, 0], 0)
        self.assertGreater(rays[2, -1, 0], 0)
        self.assertGreater(rays[..., 2].min().item(), 0)

    def test_adapter_limits_the_longest_edge_and_replaces_rays(self):
        module = SimpleNamespace(
            pred_depth=lambda model, image: {"rgb": torch.zeros((5, 9, 3)), "rays": None}
        )
        install_perspective_projection(module, torch)
        self.assertEqual(module.resize_img(Image.new("RGB", (1600, 800))).size, (1024, 512))
        self.assertEqual(module.resize_img(Image.new("RGB", (800, 400))).size, (800, 400))
        self.assertEqual(module.pred_depth(None, None)["rays"].shape, (5, 9, 3))


if __name__ == "__main__":
    unittest.main()
