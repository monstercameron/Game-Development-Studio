import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from motionbricks_bvh import (
    JOINTS,
    condition_masks,
    decode_bvh,
    encode_pose_windows,
    parse_bvh,
)


# A 30-joint skeleton in JOINTS order, written as BVH text. The two legs (joints 22 and 26)
# are offset to opposite sides so that the left and right legs are not interchangeable.
def fixture():
    parents = [
        -1,
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        6,
        6,
        3,
        10,
        11,
        12,
        13,
        13,
        3,
        16,
        17,
        18,
        19,
        19,
        0,
        22,
        23,
        24,
        0,
        26,
        27,
        28,
    ]
    children = [[] for _ in JOINTS]
    for i, p in enumerate(parents[1:], 1):
        children[p].append(i)
    lines = ["HIERARCHY"]
    order = []

    # Depth-first order. Each motion row has 6 root channels and 3 channels per other joint,
    # so the row width below is taken from len(order).
    def emit(i):
        order.append(i)
        offset = (0, 5, 0)
        if i == 22:
            offset = (-10, -5, 0)
        elif i == 26:
            offset = (10, -5, 0)
        lines.extend(
            [
                f"{'ROOT' if i == 0 else 'JOINT'} {JOINTS[i]}",
                "{",
                "OFFSET " + " ".join(map(str, offset)),
                "CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation"
                if i == 0
                else "CHANNELS 3 Xrotation Yrotation Zrotation",
            ]
        )
        for child in children[i]:
            emit(child)
        if not children[i]:
            lines.extend(["End Site", "{", "OFFSET 0 0 0", "}"])
        lines.append("}")

    emit(0)
    lines.extend(["MOTION", "Frames: 12", "Frame Time: 0.033333333"])
    # Root Xposition carries the frame index and Yposition stays at 100, so a test can follow
    # the root channels through the encode and decode round trip.
    for frame in range(12):
        lines.append(" ".join(map(str, [frame, 100, 0, 0, 0, 0] + [0] * (3 * (len(order) - 1)))))
    return "\n".join(lines) + "\n"


class MotionBricksBvhTests(unittest.TestCase):
    def test_encode_and_decode_pose_windows(self):
        clip = parse_bvh(fixture())
        inputs, align = encode_pose_windows(clip, 0, 6, min_tokens=8, max_tokens=10)
        self.assertEqual(inputs["local_poses"].shape, (1, 8, 267))
        self.assertEqual(
            inputs["allowed_pred_num_tokens"].tolist(), [[0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]]
        )
        raw = np.zeros((1, 64, 366))
        raw[0, :, :3] = inputs["global_root_values"][0, 3, :3]
        raw[0, :, 92:272] = inputs["local_poses"][0, 3, 87:]
        decoded_bvh = decode_bvh(
            clip, {"pred_global_motions": raw, "pred_num_tokens": np.array([8])}, align
        )
        saved = parse_bvh(decoded_bvh)
        self.assertEqual(len(saved.frames), 26)
        self.assertEqual(saved.stride, 1)
        np.testing.assert_allclose(saved.frames[:, 0], 3.0, atol=1e-5)
        np.testing.assert_allclose(saved.frames[:, 1], 100.0, atol=1e-5)

    def test_condition_masks_follow_upstream_slots(self):
        clip = parse_bvh(fixture())
        inputs, _ = encode_pose_windows(clip, 0, 6, min_tokens=8, max_tokens=10)
        self.assertEqual(inputs["has_global_root_values"].tolist(), [[1] * 8])
        self.assertEqual(inputs["has_local_root_values"].tolist(), [[1, 1, 1, 0, 1, 1, 1, 0]])
        for count in (1, 2, 3):
            with self.subTest(num_target_poses=count):
                given, local_root = condition_masks(count)
                self.assertEqual(given[0].tolist(), [1, 1, 1, 1] + [1] * count + [0] * (4 - count))
                last_target = 4 + count - 1
                self.assertEqual(local_root[0, last_target], 0)
                self.assertEqual(local_root[0, 3], 0)
        inputs, _ = encode_pose_windows(clip, 0, 6, min_tokens=8, max_tokens=10, num_target_poses=1)
        self.assertEqual(inputs["has_local_poses"].tolist(), [[1, 1, 1, 1, 1, 0, 0, 0]])
        self.assertEqual(inputs["has_local_root_values"].tolist(), [[1, 1, 1, 0, 0, 0, 0, 0]])
        for invalid in (0, 5, True, 1.0):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                encode_pose_windows(clip, 0, 6, num_target_poses=invalid)

    def test_rejects_incompatible_and_malformed_input(self):
        bvh_text = fixture()
        for invalid in [
            bvh_text.replace("LeftEye", "MissingEye"),
            bvh_text.replace("Frame Time: 0.033333333", "Frame Time: 0.04"),
            bvh_text.replace("Frames: 12", "Frames: 99999"),
            bvh_text.replace("Xrotation Yrotation Zrotation", "Xrotation Xrotation Zrotation", 1),
        ]:
            with self.subTest(invalid=invalid[:80]), self.assertRaises(ValueError):
                parse_bvh(invalid)
        clip = parse_bvh(bvh_text)
        for args in [(-1, 1), (0, 10)]:
            with self.assertRaises(ValueError):
                encode_pose_windows(clip, *args)
        with self.assertRaises(ValueError):
            encode_pose_windows(clip, 0, 6, min_tokens=5)
        with self.assertRaises(ValueError):
            decode_bvh(
                clip,
                {"pred_global_motions": np.zeros((1, 64, 366)), "pred_num_tokens": np.array([8])},
                {"alignment": np.eye(3), "origin": np.zeros(3)},
            )


if __name__ == "__main__":
    unittest.main()
