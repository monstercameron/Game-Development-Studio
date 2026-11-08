"""HY-World views must share one shape; skipped scenes must be explained."""

import io
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from world_views import Tee, normalize_views, skip_reason  # noqa: E402 - runtime is added above.


def save(directory, name, size, color):
    path = Path(directory) / name
    Image.new("RGB", size, color).save(path)
    return path


class WorldViewTests(unittest.TestCase):
    def test_views_of_other_proportions_are_cropped_to_the_first(self):
        with tempfile.TemporaryDirectory() as directory:
            first = save(directory, "a.png", (800, 1312), "red")
            narrow = save(directory, "b.png", (384, 640), "green")
            wide = save(directory, "c.png", (1000, 500), "blue")
            same = save(directory, "d.png", (400, 656), "white")
            out = Path(directory) / "views"
            cropped = normalize_views([first, narrow, wide, same], out)
            # 384x640 is 1.6 % off the first view's ratio, so it is cropped as well.
            self.assertEqual(cropped, [1, 2])
            sizes = set()
            for index in range(4):
                with Image.open(out / f"{index:03d}.png") as view:
                    sizes.add(view.size)
            self.assertEqual(sizes, {(800, 1312)})

    def test_a_very_large_first_view_sets_a_bounded_common_size(self):
        with tempfile.TemporaryDirectory() as directory:
            first = save(directory, "a.png", (4000, 3000), "red")
            second = save(directory, "b.png", (800, 600), "green")
            out = Path(directory) / "views"
            self.assertEqual(normalize_views([first, second], out), [])
            with Image.open(out / "001.png") as view:
                self.assertEqual(view.size, (1536, 1152))

    def test_the_reason_a_scene_was_skipped_is_found_in_the_log(self):
        log = (
            "[Input] Loaded 3 images\n"
            "[Pipeline] Skipping 'C:\work\views': Inconsistent resolutions after "
            "preprocessing: {(518, 308), (518, 322)}. All input images must have the same "
            "aspect ratio.\n"
        )
        self.assertIn("Inconsistent resolutions", skip_reason(log))
        self.assertTrue(skip_reason(log).endswith("same aspect ratio."))
        self.assertIsNone(skip_reason("[Inference] Done in 1.2s"))

    def test_tee_passes_output_through_and_keeps_a_copy(self):
        stream = io.StringIO()
        tee = Tee(stream)
        tee.write("hello ")
        tee.write("world")
        tee.flush()
        self.assertEqual(stream.getvalue(), "hello world")
        self.assertEqual(tee.text, "hello world")


if __name__ == "__main__":
    unittest.main()
