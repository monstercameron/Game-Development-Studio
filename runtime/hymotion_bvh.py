"""Export HY-Motion's local joint rotations and translation as a BVH clip.

The output uses the upstream wooden model's rest skeleton and 30 fps by
default. It is a skeletal animation; applying it to another rig requires
retargeting. This module does not load or run a model.
"""
import re

import numpy as np
from scipy.spatial.transform import Rotation


def motion_to_bvh(rot6d, translation, rest_joints, parents, names, fps=30):
    rotations = np.asarray(rot6d, dtype=np.float64)
    translation = np.asarray(translation, dtype=np.float64)
    rest = np.asarray(rest_joints, dtype=np.float64)
    parents = np.asarray(parents)
    if rotations.ndim != 3 or rotations.shape[2] != 6 or not 1 <= rotations.shape[0] <= 5000:
        raise ValueError('Expected 1–5000 frames of six-dimensional joint rotations.')
    frames, count, _ = rotations.shape
    if count < 1 or rest.ndim != 2 or rest.shape[0] < count or rest.shape[1] != 3 or translation.shape != (frames, 3):
        raise ValueError('Motion and rest-skeleton dimensions do not match.')
    if parents.ndim != 1 or len(parents) < count or len(names) < count:
        raise ValueError('The skeleton is incomplete.')
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not np.isfinite(fps) or fps <= 0 or fps > 240:
        raise ValueError('Frame rate must be greater than 0 and at most 240.')
    if not np.isfinite(rotations).all() or not np.isfinite(translation).all() or not np.isfinite(rest[:count]).all():
        raise ValueError('Motion contains non-finite values.')
    if not np.issubdtype(parents.dtype, np.integer) or parents[0] not in (-1, 0) or any(parent < 0 or parent >= i for i, parent in enumerate(parents[1:count], 1)):
        raise ValueError('The skeleton must have one root and parents before children.')
    labels = [re.sub(r'[^A-Za-z0-9_]', '_', str(name)) for name in names[:count]]
    if any(not name for name in labels) or len(set(labels)) != count:
        raise ValueError('Skeleton joint names must be non-empty and unique.')

    # This is the same 6D column convention used in the upstream geometry.py.
    pairs = rotations.reshape(frames, count, 3, 2)
    a, b = pairs[..., 0], pairs[..., 1]
    length_a = np.linalg.norm(a, axis=-1, keepdims=True)
    if (length_a < 1e-8).any():
        raise ValueError('Motion contains a degenerate rotation.')
    x = a / length_a
    b = b - (x * b).sum(axis=-1, keepdims=True) * x
    length_b = np.linalg.norm(b, axis=-1, keepdims=True)
    if (length_b < 1e-8).any():
        raise ValueError('Motion contains a degenerate rotation.')
    y = b / length_b
    matrices = np.stack((x, y, np.cross(x, y)), axis=-1)
    euler = Rotation.from_matrix(matrices.reshape(-1, 3, 3)).as_euler('XYZ').reshape(frames, count, 3)
    euler = np.rad2deg(np.unwrap(euler, axis=0))

    children = [[] for _ in range(count)]
    for index in range(1, count):
        children[int(parents[index])].append(index)
    lines = ['HIERARCHY']
    order = []
    def emit(index, depth):
        order.append(index)
        indent = '  ' * depth
        offset = rest[index] if index == 0 else rest[index] - rest[int(parents[index])]
        lines.append(f'{indent}{"ROOT" if index == 0 else "JOINT"} {labels[index]}')
        lines.append(indent + '{')
        lines.append(indent + '  OFFSET ' + ' '.join(f'{value:.7f}' for value in offset))
        lines.append(indent + ('  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation' if index == 0 else '  CHANNELS 3 Xrotation Yrotation Zrotation'))
        for child in children[index]:
            emit(child, depth + 1)
        if not children[index]:
            lines.extend([indent + '  End Site', indent + '  {', indent + '    OFFSET 0.0000000 0.0000000 0.0000000', indent + '  }'])
        lines.append(indent + '}')
    emit(0, 0)
    lines.extend(['MOTION', f'Frames: {frames}', f'Frame Time: {1 / fps:.9f}'])
    for frame in range(frames):
        values = [*translation[frame], *euler[frame, 0]]
        for index in order[1:]:
            values.extend(euler[frame, index])
        lines.append(' '.join(f'{value:.7f}' for value in values))
    return '\n'.join(lines) + '\n'
