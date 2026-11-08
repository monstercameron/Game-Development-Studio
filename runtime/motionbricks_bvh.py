"""Convert SOMA BVH pose windows to MotionBricks tensors and back to BVH.

BVH positions are interpreted and exported in centimeters, Y up. This is a
SOMA-only conversion; it does not retarget other skeletons or correct endpoints.
"""

import io
import re
from dataclasses import dataclass

import numpy as np
from scipy.spatial.transform import Rotation

JOINTS = (
    "Hips",
    "Spine1",
    "Spine2",
    "Chest",
    "Neck1",
    "Neck2",
    "Head",
    "Jaw",
    "LeftEye",
    "RightEye",
    "LeftShoulder",
    "LeftArm",
    "LeftForeArm",
    "LeftHand",
    "LeftHandThumbEnd",
    "LeftHandMiddleEnd",
    "RightShoulder",
    "RightArm",
    "RightForeArm",
    "RightHand",
    "RightHandThumbEnd",
    "RightHandMiddleEnd",
    "LeftLeg",
    "LeftShin",
    "LeftFoot",
    "LeftToeBase",
    "RightLeg",
    "RightShin",
    "RightFoot",
    "RightToeBase",
)


# Parsed BVH. Offsets are in centimeters. Each frames row holds the channel values of one
# sampled frame in BVH column order, and stride converts 30 fps pose indices to frame rows.
@dataclass
class Clip:
    names: list
    parents: list
    offsets: np.ndarray
    channels: list
    frames: np.ndarray
    stride: int


def parse_bvh(text):
    """Parse a SOMA BVH string into a Clip.

    Raises ValueError with a user-facing message for an oversized, malformed or incomplete file,
    including a missing SOMA joint and a frame rate other than 30, 60 or 120 fps.
    """
    if not isinstance(text, str) or not text or len(text.encode("utf-8")) > 10 * 1024**2:
        raise ValueError("Provide a BVH file of at most 10 MiB.")
    source = io.StringIO(text)
    names = []
    parents = []
    offsets = []
    channels = []
    stack = []
    end = False
    started = False
    for line in source:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "MOTION":
            if stack or end:
                raise ValueError("BVH hierarchy is not closed.")
            break
        if parts[0] == "HIERARCHY":
            started = True
        elif parts[0] in ("ROOT", "JOINT"):
            if (
                not started
                or len(parts) != 2
                or len(names) >= 300
                or (parts[0] == "ROOT") != (len(names) == 0)
                or (parts[0] == "JOINT" and not stack)
            ):
                raise ValueError("Invalid BVH hierarchy.")
            name = parts[1].rsplit(":", 1)[-1]
            if not re.fullmatch(r"[A-Za-z0-9_]+", name):
                raise ValueError("Invalid BVH joint name.")
            names.append(name)
            parents.append(stack[-1] if stack else -1)
            stack.append(len(names) - 1)
            offsets.append([0.0, 0.0, 0.0])
            channels.append([])
        elif parts[:2] == ["End", "Site"]:
            if not stack or end:
                raise ValueError("Invalid BVH end site.")
            end = True
        elif parts[0] == "OFFSET" and not end:
            if not stack or len(parts) != 4:
                raise ValueError("Invalid BVH offset.")
            try:
                offsets[stack[-1]] = [float(value) for value in parts[1:]]
            except ValueError as error:
                raise ValueError("Invalid BVH offset.") from error
        elif parts[0] == "CHANNELS":
            if not stack or end or len(parts) < 3:
                raise ValueError("Invalid BVH channels.")
            try:
                count = int(parts[1])
            except ValueError as error:
                raise ValueError("Invalid BVH channel count.") from error
            values = parts[2:]
            if (
                count != len(values)
                or count not in (3, 6)
                or channels[stack[-1]]
                or any(
                    value
                    not in (
                        "Xposition",
                        "Yposition",
                        "Zposition",
                        "Xrotation",
                        "Yrotation",
                        "Zrotation",
                    )
                    for value in values
                )
                or len(set(values)) != count
            ):
                raise ValueError("Unsupported BVH channels.")
            rotations = [value[0] for value in values if value.endswith("rotation")]
            if sorted(rotations) != ["X", "Y", "Z"]:
                raise ValueError("Each BVH joint needs three rotation channels.")
            if count == 6 and {v for v in values if v.endswith("position")} != {
                "Xposition",
                "Yposition",
                "Zposition",
            }:
                raise ValueError("Position channels must include X, Y and Z.")
            channels[stack[-1]] = values
        elif parts[0] == "}":
            if end:
                end = False
            elif stack:
                stack.pop()
            else:
                raise ValueError("Invalid BVH closing brace.")
        elif parts[0] not in ("{", "OFFSET"):
            raise ValueError("Unsupported BVH hierarchy entry.")
    else:
        raise ValueError("BVH motion section is missing.")
    if (
        not names
        or any(not item for item in channels)
        or sum(map(len, channels)) > 1800
        or not np.isfinite(offsets).all()
    ):
        raise ValueError("BVH skeleton is incomplete.")
    if any(names.count(name) != 1 for name in JOINTS):
        raise ValueError("The BVH must contain each of the 30 SOMA joints exactly once.")
    try:
        frames_line = next(source).split()
        time_line = next(source).split()
        if (
            len(frames_line) != 2
            or frames_line[0] != "Frames:"
            or time_line[:2] != ["Frame", "Time:"]
            or len(time_line) != 3
        ):
            raise ValueError("BVH frame header is invalid.")
        count = int(frames_line[1])
        frame_time = float(time_line[2])
        if not 1 <= count <= 20000 or not np.isfinite(frame_time) or frame_time <= 0:
            raise ValueError("Invalid BVH frame count or frame time.")
        rate = 1 / frame_time
        stride = round(rate / 30)
        if stride not in (1, 2, 4) or abs(rate - 30 * stride) > 0.1:
            raise ValueError("Use a BVH sampled at 30, 60, or 120 fps.")
        data = np.loadtxt(source, dtype=np.float64, ndmin=2)
    except (StopIteration, ValueError, OverflowError) as error:
        raise ValueError(f"Invalid BVH motion: {error}") from error
    if data.shape != (count, sum(map(len, channels))) or not np.isfinite(data).all():
        raise ValueError("BVH motion rows are incomplete or non-finite.")
    return Clip(names, parents, np.asarray(offsets, dtype=np.float64), channels, data, stride)


def _heading(positions):
    """Return the facing angle in radians about the Y axis.

    The angle comes from the horizontal line between SOMA joints 22 (LeftLeg) and 26 (RightLeg).
    Raises ValueError when those joints coincide horizontally.
    """
    across = positions[26] - positions[22]
    across = across.copy()
    across[1] = 0
    length = np.linalg.norm(across)
    if length < 1e-6:
        raise ValueError("SOMA hip positions cannot define a heading.")
    forward = np.cross([0.0, 1.0, 0.0], across / length)
    return np.arctan2(forward[0], forward[2])


# Each MotionBricks token covers four consecutive 30 fps poses.
POSES_PER_TOKEN = 4


def condition_masks(num_target_poses):
    """Return the slot masks that MotionBricks' conditions kernel writes for SOMA.

    Eight slots hold four context poses and four target poses. The first num_target_poses target
    slots count as given. Local root values stay unknown at the last context slot and at the last
    given target slot, because their velocities need a neighbouring pose.
    """
    given = np.zeros((1, 2 * POSES_PER_TOKEN), np.int32)
    given[0, : POSES_PER_TOKEN + num_target_poses] = 1
    local_root = given.copy()
    local_root[0, POSES_PER_TOKEN - 1] = 0
    local_root[0, POSES_PER_TOKEN + num_target_poses - 1] = 0
    return given, local_root


def encode_pose_windows(
    clip, context_frame, target_frame, *, min_tokens=8, max_tokens=14, num_target_poses=4
):
    """Encode one context window and one target window as MotionBricks input tensors.

    context_frame and target_frame are indices of the first of four consecutive poses at 30 fps.
    Returns (tensors, alignment), where alignment holds the matrix and origin that decode_bvh
    needs to place the predicted motion back in the source BVH space. Raises ValueError for
    invalid frame indices, token limits or a window that runs past the clip.
    """
    if (
        isinstance(num_target_poses, bool)
        or not isinstance(num_target_poses, int)
        or not 1 <= num_target_poses <= POSES_PER_TOKEN
    ):
        raise ValueError("Target poses to use must be a whole number from 1 to 4.")
    if any(
        isinstance(v, bool) or not isinstance(v, int) or v < 0
        for v in (context_frame, target_frame)
    ):
        raise ValueError("Context and target frames must be non-negative integers at 30 fps.")
    if (
        any(isinstance(v, bool) or not isinstance(v, int) for v in (min_tokens, max_tokens))
        or not 6 <= min_tokens <= max_tokens <= 16
    ):
        raise ValueError("Token limits must be between 6 and 16.")
    indices = [
        (start + i) * clip.stride for start in (context_frame, target_frame) for i in range(4)
    ]
    if max(indices) >= len(clip.frames):
        raise ValueError("Each pose window needs four frames within the clip.")
    rows = clip.frames[indices]
    pos = np.zeros((8, len(clip.names), 3))
    rot = np.zeros((8, len(clip.names), 3, 3))
    column = 0
    for j, joint_channels in enumerate(clip.channels):
        local = np.broadcast_to(clip.offsets[j] * 0.01, (8, 3)).copy()
        axes = []
        angles = []
        for channel in joint_channels:
            if channel.endswith("position"):
                local[:, "XYZ".index(channel[0])] = rows[:, column] * 0.01
            else:
                axes.append(channel[0])
                angles.append(rows[:, column])
            column += 1
        matrix = Rotation.from_euler("".join(axes), np.asarray(angles).T, degrees=True).as_matrix()
        parent = clip.parents[j]
        if parent < 0:
            pos[:, j] = local
            rot[:, j] = matrix
        else:
            pos[:, j] = pos[:, parent] + np.einsum("fij,fj->fi", rot[:, parent], local)
            rot[:, j] = rot[:, parent] @ matrix
    model_indices = [clip.names.index(name) for name in JOINTS]
    positions = pos[:, model_indices]
    rotations = rot[:, model_indices]
    align = Rotation.from_euler("y", _heading(positions[3]) - np.pi / 2)
    origin = np.array([positions[3, 0, 0], 0.0, positions[3, 0, 2]])
    aligned = align.inv().apply((positions - origin).reshape(-1, 3)).reshape(8, 30, 3)
    aligned_rotations = align.inv().as_matrix() @ rotations
    global_root = np.zeros((1, 8, 5), np.float32)
    local_root = np.zeros((1, 8, 4), np.float32)
    local_pose = np.zeros((1, 8, 267), np.float32)
    for i in range(8):
        # Slots 3 and 7 end a window with no following pose, so they are compared with themselves
        # and get zero root velocity.
        next_index = i if i in (3, 7) else i + 1
        angle = _heading(aligned[i])
        angle_next = _heading(aligned[next_index])
        delta = np.arctan2(np.sin(angle_next - angle), np.cos(angle_next - angle))
        global_root[0, i] = [*aligned[i, 0], np.cos(angle), np.sin(angle)]
        local_root[0, i] = [
            delta * 30,
            (aligned[next_index, 0, 0] - aligned[i, 0, 0]) * 30,
            (aligned[next_index, 0, 2] - aligned[i, 0, 2]) * 30,
            aligned[i, 0, 1],
        ]
        local_pose[0, i, :87] = (aligned[i, 1:] - [aligned[i, 0, 0], 0, aligned[i, 0, 2]]).reshape(
            -1
        )
        local_pose[0, i, 87:] = np.concatenate(
            [aligned_rotations[i, :, :, 0], aligned_rotations[i, :, :, 1]], axis=1
        ).reshape(-1)
    allowed = np.zeros((1, 11), np.int32)
    allowed[0, min_tokens - 6 : max_tokens - 5] = 1
    given, local_root_known = condition_masks(num_target_poses)
    tensors = {
        "global_root_values": global_root,
        "local_root_values": local_root,
        "local_poses": local_pose,
        "has_global_root_values": given,
        "has_local_root_values": local_root_known,
        "has_local_poses": given.copy(),
        "allowed_pred_num_tokens": allowed,
    }
    return tensors, {"alignment": align.as_matrix(), "origin": origin}


def decode_bvh(clip, output, alignment):
    """Convert MotionBricks output back to BVH text in the source clip's skeleton layout.

    output holds pred_global_motions (1 x 64 x 366) and pred_num_tokens (1). alignment comes from
    encode_pose_windows. Positions are written in centimeters and rotations in degrees.
    Raises ValueError for a wrong shape, non-finite values or a degenerate rotation.
    """
    values = np.asarray(output["pred_global_motions"], dtype=np.float64)
    tokens = np.asarray(output["pred_num_tokens"])
    if (
        values.shape != (1, 64, 366)
        or tokens.shape != (1,)
        or not np.isfinite(values).all()
        or not 6 <= int(tokens[0]) <= 16
        or tokens[0] != int(tokens[0])
    ):
        raise ValueError("Invalid MotionBricks output.")
    frames = values[0, 3 : int(tokens[0]) * 4 - 3]
    n = len(frames)
    axes = frames[:, 92:272].reshape(n, 30, 6)
    x_raw = axes[..., :3]
    y_raw = axes[..., 3:]
    length = np.linalg.norm(x_raw, axis=-1, keepdims=True)
    if (length < 1e-8).any():
        raise ValueError("Motion contains a degenerate rotation.")
    x = x_raw / length
    # Gram-Schmidt: make the second axis orthogonal to the first before normalizing it.
    y_raw = y_raw - (y_raw * x).sum(axis=-1, keepdims=True) * x
    length = np.linalg.norm(y_raw, axis=-1, keepdims=True)
    if (length < 1e-8).any():
        raise ValueError("Motion contains a degenerate rotation.")
    y = y_raw / length
    matrices = np.stack((x, y, np.cross(x, y)), axis=-1)
    align = np.asarray(alignment["alignment"], dtype=np.float64)
    origin = np.asarray(alignment["origin"], dtype=np.float64)
    if (
        align.shape != (3, 3)
        or origin.shape != (3,)
        or not np.isfinite(align).all()
        or not np.isfinite(origin).all()
    ):
        raise ValueError("Invalid motion alignment.")
    matrices = align @ matrices
    positions = np.einsum("ij,fj->fi", align, frames[:, :3]) + origin
    model_indices = [clip.names.index(name) for name in JOINTS]
    index_by_source = {value: index for index, value in enumerate(model_indices)}
    parents = [-1]
    offsets = [np.zeros(3)]
    for i, source_index in enumerate(model_indices[1:], 1):
        current = source_index
        offset = np.zeros(3)
        while current not in index_by_source or current == source_index:
            offset += clip.offsets[current]
            current = clip.parents[current]
            if current < 0:
                raise ValueError("SOMA joints do not descend from Hips.")
        parent = index_by_source[current]
        if parent >= i:
            raise ValueError("SOMA skeleton hierarchy is incompatible.")
        parents.append(parent)
        offsets.append(offset)
    local = matrices.copy()
    for i in range(1, 30):
        local[:, i] = np.swapaxes(matrices[:, parents[i]], -1, -2) @ matrices[:, i]
    euler = Rotation.from_matrix(local.reshape(-1, 3, 3)).as_euler("XYZ").reshape(n, 30, 3)
    # Unwrap across frames so a joint does not jump by a full turn in the exported channels.
    euler = np.rad2deg(np.unwrap(euler, axis=0))
    children = [[] for _ in JOINTS]
    for i, parent in enumerate(parents[1:], 1):
        children[parent].append(i)
    lines = ["HIERARCHY"]
    order = []

    def emit(i, depth):
        order.append(i)
        indent = "  " * depth
        lines.extend(
            [
                f"{indent}{'ROOT' if i == 0 else 'JOINT'} {JOINTS[i]}",
                indent + "{",
                indent + "  OFFSET " + " ".join(f"{v:.7f}" for v in offsets[i]),
                indent
                + (
                    "  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation"
                    if i == 0
                    else "  CHANNELS 3 Xrotation Yrotation Zrotation"
                ),
            ]
        )
        for child in children[i]:
            emit(child, depth + 1)
        if not children[i]:
            lines.extend(
                [indent + "  End Site", indent + "  {", indent + "    OFFSET 0 0 0", indent + "  }"]
            )
        lines.append(indent + "}")

    emit(0, 0)
    lines.extend(["MOTION", f"Frames: {n}", "Frame Time: 0.033333333"])
    for frame in range(n):
        row = [*(positions[frame] * 100), *euler[frame, 0]]
        for i in order[1:]:
            row.extend(euler[frame, i])
        lines.append(" ".join(f"{value:.7f}" for value in row))
    return "\n".join(lines) + "\n"
