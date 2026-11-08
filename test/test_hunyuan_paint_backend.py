import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

from runtime import hunyuan_paint_backend as paint


def glb_json(data):
    length = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20 : 20 + length])


class HunyuanPaintBackendTest(unittest.TestCase):
    def test_texture_files_ready_requires_every_listed_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertFalse(paint.texture_files_ready(root))
            for item in paint.REQUIRED_FILES:
                path = root / item
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x")
            self.assertTrue(paint.texture_files_ready(root))
            (root / paint.REQUIRED_FILES[-1]).unlink()
            self.assertFalse(paint.texture_files_ready(root))

    def test_vertex_normals_are_unit_length_and_face_outward(self):
        vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float64)
        normals = paint._vertex_normals(vertices, np.array([[0, 1, 2]]))
        np.testing.assert_allclose(normals, [[0, 0, 1]] * 3, atol=1e-6)
        degenerate = paint._vertex_normals(vertices, np.array([[0, 0, 0]]))
        self.assertTrue(np.isfinite(degenerate).all())

    def test_upscaler_network_matches_the_x4plus_layout(self):
        network = paint._RRDBNet(num_feat=8, num_block=2, num_grow_ch=4).eval()
        keys = set(network.state_dict())
        self.assertIn("conv_first.weight", keys)
        self.assertIn("body.1.rdb3.conv5.bias", keys)
        self.assertIn("conv_last.weight", keys)
        with torch.no_grad():
            output = network(torch.zeros(1, 3, 8, 8))
        self.assertEqual(tuple(output.shape), (1, 3, 32, 32))

    def test_glb_carries_uvs_normals_and_both_pbr_textures(self):
        vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
        faces = np.array([[0, 1, 2]], dtype=np.int32)
        uv = np.array([[0, 0], [1, 0], [0, 1]], dtype=np.float32)
        normals = np.array([[0, 0, 1]] * 3, dtype=np.float32)
        albedo = np.zeros((4, 4, 3), dtype=np.uint8)
        albedo[..., 0] = 200
        flat = np.full((4, 4), 128, dtype=np.uint8)
        mesh = paint._glb_from_arrays(vertices, normals, faces, uv, albedo, flat, flat)
        document = glb_json(mesh.export(file_type="glb"))
        primitive = document["meshes"][0]["primitives"][0]
        self.assertIn("TEXCOORD_0", primitive["attributes"])
        self.assertIn("NORMAL", primitive["attributes"])
        material = document["materials"][0]["pbrMetallicRoughness"]
        self.assertIn("baseColorTexture", material)
        self.assertIn("metallicRoughnessTexture", material)
        self.assertEqual(len(document["images"]), 2)

    def test_invalid_texture_size_is_rejected_before_any_work(self):
        with self.assertRaisesRegex(ValueError, "texture size"):
            paint.generate_texture(None, None, None, texture_size=512)


if __name__ == "__main__":
    unittest.main()
