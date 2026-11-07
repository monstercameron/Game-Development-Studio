import sys
import unittest
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from hymotion_bvh import motion_to_bvh


def six(matrices):
    return np.asarray(matrices)[..., :2].reshape(*np.asarray(matrices).shape[:-2], 6)


class BvhExportTests(unittest.TestCase):
    def test_depth_first_channels_preserve_rotations_and_translation(self):
        parents = np.array([-1, 0, 0, 1])
        rest = np.array([[0, 1, 0], [1, 1, 0], [-1, 1, 0], [2, 1, 0]], dtype=float)
        angles = np.array([[0, 0, 90], [45, 0, 0], [0, 0, -20], [0, 30, 0]], dtype=float)
        matrices = Rotation.from_euler("XYZ", angles, degrees=True).as_matrix()
        motion = six(matrices)[None, ...]
        result = motion_to_bvh(
            motion, [[1, 2, 3]], rest, parents, ["root", "left", "right", "hand"]
        )
        self.assertLess(result.index("JOINT left"), result.index("JOINT hand"))
        self.assertLess(result.index("JOINT hand"), result.index("JOINT right"))
        self.assertIn("OFFSET 1.0000000 0.0000000 0.0000000", result)
        self.assertIn("Frames: 1\nFrame Time: 0.033333333", result)
        values = np.array([float(x) for x in result.strip().splitlines()[-1].split()])
        np.testing.assert_allclose(values[:3], [1, 2, 3], atol=1e-6)
        observed = Rotation.from_euler("XYZ", values[3:].reshape(4, 3), degrees=True).as_matrix()
        np.testing.assert_allclose(observed, matrices[[0, 1, 3, 2]], atol=1e-6)

    def test_rejects_invalid_or_degenerate_motion(self):
        identity = six(np.eye(3))[None, None, :]
        args = (identity, np.zeros((1, 3)), np.zeros((1, 3)), np.array([-1]), ["root"])
        with self.assertRaisesRegex(ValueError, "degenerate"):
            motion_to_bvh(np.zeros_like(identity), *args[1:])
        with self.assertRaisesRegex(ValueError, "non-finite"):
            motion_to_bvh(identity, [[0, float("nan"), 0]], *args[2:])
        with self.assertRaisesRegex(ValueError, "Frame rate"):
            motion_to_bvh(*args, fps=0)
        with self.assertRaisesRegex(ValueError, "dimensions"):
            motion_to_bvh(identity, [[0, 0]], *args[2:])

    def test_upstream_skeleton_is_a_valid_hierarchy(self):
        root = (
            Path(__file__).resolve().parents[1]
            / ".forge-runtime"
            / "hy-motion-src"
            / "scripts"
            / "gradio"
            / "static"
            / "assets"
            / "dump_wooden"
        )
        if not (root / "kintree.bin").exists():
            self.skipTest("Upstream HY-Motion source is not installed.")
        import json

        parents = np.fromfile(root / "kintree.bin", dtype=np.int32)
        rest = np.fromfile(root / "j_template.bin", dtype=np.float32).reshape(-1, 3)
        names = json.loads((root / "joint_names.json").read_text())
        self.assertEqual(len(parents), 52)
        rotations = np.tile(six(np.eye(3)), (2, 22, 1))
        result = motion_to_bvh(rotations, np.zeros((2, 3)), rest, parents, names)
        self.assertEqual(result.count("JOINT "), 21)
        self.assertIn("ROOT Pelvis", result)


if __name__ == "__main__":
    unittest.main()
