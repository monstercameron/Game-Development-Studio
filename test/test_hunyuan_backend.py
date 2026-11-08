import unittest

import numpy as np
from PIL import Image

from runtime.hunyuan_backend import PillowImageProcessor, generate_shape


class HunyuanPreprocessorTest(unittest.TestCase):
    def test_rgba_is_centered_and_returns_model_tensors(self):
        rgba = np.zeros((80, 120, 4), dtype=np.uint8)
        rgba[15:65, 35:85, :] = (220, 40, 20, 255)
        result = PillowImageProcessor(size=64)(Image.fromarray(rgba))
        self.assertEqual(tuple(result["image"].shape), (1, 3, 64, 64))
        self.assertEqual(tuple(result["mask"].shape), (1, 1, 64, 64))
        self.assertEqual(result["mask"][0, 0, 0, 0].item(), -1.0)
        self.assertEqual(result["mask"][0, 0, 32, 32].item(), 1.0)

    def test_faint_alpha_haze_is_background(self):
        rgba = np.zeros((80, 80, 4), dtype=np.uint8)
        rgba[:, :, 3] = 20
        rgba[20:60, 30:50, :] = (200, 120, 60, 255)
        result = PillowImageProcessor(size=64)(Image.fromarray(rgba))
        # Without the cut the haze would make the foreground box the whole frame.
        self.assertEqual(result["mask"][0, 0, 0, 0].item(), -1.0)
        self.assertEqual(result["mask"][0, 0, 32, 2].item(), -1.0)
        self.assertEqual(result["mask"][0, 0, 32, 32].item(), 1.0)
        with self.assertRaisesRegex(ValueError, "no visible foreground"):
            PillowImageProcessor()(Image.fromarray(np.full((16, 16, 4), 20, dtype=np.uint8)))

    def test_empty_foreground_and_invalid_render_settings_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "no visible foreground"):
            PillowImageProcessor()(Image.new("RGBA", (16, 16)))
        with self.assertRaisesRegex(ValueError, "Steps"):
            generate_shape(None, None, steps=0)
        with self.assertRaisesRegex(ValueError, "resolution"):
            generate_shape(None, None, resolution=7)


if __name__ == "__main__":
    unittest.main()
