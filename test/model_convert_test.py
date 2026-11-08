"""Tests for runtime/model_convert.py using tiny generated meshes. No GPU and no models.

Run with the Hunyuan3D environment (it ships trimesh and Pillow):
.forge-runtime\\hunyuan3d-venv\\Scripts\\python.exe test\\model_convert_test.py
"""

import base64
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "runtime"))
import model_convert as converter  # noqa: E402 - the runtime folder is added just above.


def textured_box(extents=(1, 2, 3), shift=0.0):
    box = trimesh.creation.box(extents=extents)
    box.apply_translation((shift, 0, 0))
    uv = np.zeros((len(box.vertices), 2))
    uv[:, 0] = (box.vertices[:, 0] - shift) / extents[0] + 0.5
    uv[:, 1] = box.vertices[:, 1] / extents[1] + 0.5
    image = Image.new("RGB", (4, 4))
    for x in range(4):
        for y in range(4):
            image.putpixel((x, y), (x * 60, y * 60, 128))
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=image, metallicFactor=0.1, roughnessFactor=0.8
    )
    box.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    return box


def webp_glb(glb):
    """A GLB the way TRELLIS.2 writes it: a WebP image reached only through EXT_texture_webp."""
    document, binary = converter.read_glb(glb)
    image_view = document["images"][0]["bufferView"]
    view = document["bufferViews"][image_view]
    png = binary[view["byteOffset"] : view["byteOffset"] + view["byteLength"]]
    out = io.BytesIO()
    Image.open(io.BytesIO(png)).save(out, format="WEBP", lossless=True)
    webp = out.getvalue()
    # Append the WebP bytes as a new buffer view and point the texture extension at it.
    padded = binary + b"\0" * (-len(binary) % 4)
    document["bufferViews"].append(
        {"buffer": 0, "byteOffset": len(padded), "byteLength": len(webp)}
    )
    document["images"][0] = {
        "bufferView": len(document["bufferViews"]) - 1,
        "mimeType": "image/webp",
    }
    for texture in document["textures"]:
        texture["extensions"] = {"EXT_texture_webp": {"source": texture.pop("source")}}
    document["extensionsUsed"] = ["EXT_texture_webp"]
    document["buffers"][0]["byteLength"] = len(padded) + len(webp)
    return converter.write_glb(document, padded + webp)


class ConvertTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.output = self.folder / "out"
        self.output.mkdir()
        self.glb = self.folder / "box.glb"
        self.glb.write_bytes(trimesh.Scene(textured_box()).export(file_type="glb"))

    def run_convert(self, source, target, stem="box-converted"):
        return converter.convert(str(source), self.output, stem, target)

    def names(self, result):
        return {item["name"]: item["role"] for item in result["files"]}

    def test_glb_and_gltf_repackage_without_losing_anything(self):
        result = self.run_convert(self.glb, "gltf")
        self.assertEqual(self.names(result), {"box-converted.gltf": "main"})
        gltf = self.output / "box-converted.gltf"
        document = json.loads(gltf.read_text(encoding="utf-8"))
        self.assertTrue(document["buffers"][0]["uri"].startswith("data:application/octet-stream"))
        # The embedded gltf reads back as the same mesh.
        loaded = trimesh.load(str(gltf), process=False).dump(concatenate=True)
        self.assertEqual(loaded.faces.shape, (12, 3))
        # And back to a GLB: the binary payload is identical to the original's.
        again = self.run_convert(gltf, "glb", stem="box-again")
        self.assertEqual(self.names(again), {"box-again.glb": "main"})
        original_doc, original_bin = converter.read_glb(self.glb.read_bytes())
        again_doc, again_bin = converter.read_glb((self.output / "box-again.glb").read_bytes())
        self.assertEqual(original_bin, again_bin[: len(original_bin)])
        self.assertEqual(
            [m["name"] for m in original_doc.get("meshes", [])],
            [m["name"] for m in again_doc.get("meshes", [])],
        )

    def test_gltf_with_external_files_folds_into_one_glb(self):
        mesh = textured_box()
        files = trimesh.Scene(mesh).export(file_type="gltf")
        folder = self.folder / "external"
        folder.mkdir()
        for name, data in files.items():
            (folder / name).write_bytes(data)
        self.assertTrue(any(name.endswith(".bin") for name in files))
        self.run_convert(folder / "model.gltf", "glb", stem="folded")
        document, binary = converter.read_glb((self.output / "folded.glb").read_bytes())
        self.assertEqual(len(document["buffers"]), 1)
        self.assertNotIn("uri", document["buffers"][0])
        self.assertTrue(all("uri" not in image for image in document.get("images", [])))
        loaded = trimesh.load(
            io.BytesIO((self.output / "folded.glb").read_bytes()), file_type="glb"
        )
        self.assertEqual(loaded.dump(concatenate=True).faces.shape, (12, 3))

    def test_obj_has_material_and_renamed_texture(self):
        result = self.run_convert(self.glb, "obj")
        self.assertEqual(
            self.names(result),
            {
                "box-converted.obj": "main",
                "box-converted.mtl": "material",
                "box-converted-texture-0.png": "texture",
            },
        )
        obj = (self.output / "box-converted.obj").read_text(encoding="utf-8")
        mtl = (self.output / "box-converted.mtl").read_text(encoding="utf-8")
        self.assertIn("mtllib box-converted.mtl", obj)
        self.assertIn("map_Kd box-converted-texture-0.png", mtl)
        self.assertNotIn("material_0.png", mtl)
        with Image.open(self.output / "box-converted-texture-0.png") as texture:
            self.assertEqual(texture.size, (4, 4))
        loaded = trimesh.load(str(self.output / "box-converted.obj"), process=False)
        self.assertEqual(loaded.faces.shape, (12, 3))
        self.assertTrue(any("metallic" in note for note in result["notes"]))

    def test_ply_bakes_the_texture_into_vertex_colours(self):
        result = self.run_convert(self.glb, "ply")
        self.assertEqual(self.names(result), {"box-converted.ply": "main"})
        loaded = trimesh.load(str(self.output / "box-converted.ply"), process=False)
        self.assertEqual(loaded.visual.kind, "vertex")
        self.assertEqual(loaded.faces.shape, (12, 3))
        self.assertTrue(any("vertex colours" in note for note in result["notes"]))

    def test_stl_is_geometry_only(self):
        result = self.run_convert(self.glb, "stl")
        loaded = trimesh.load(str(self.output / "box-converted.stl"))
        self.assertEqual(loaded.faces.shape, (12, 3))
        self.assertTrue(any("geometry only" in note for note in result["notes"]))

    def test_mesh_formats_convert_back_to_glb_and_gltf(self):
        self.run_convert(self.glb, "stl")
        self.run_convert(self.output / "box-converted.stl", "glb", stem="from-stl")
        self.run_convert(self.output / "box-converted.stl", "gltf", stem="from-stl-gltf")
        for name in ("from-stl.glb", "from-stl-gltf.gltf"):
            loaded = trimesh.load(str(self.output / name), process=False)
            self.assertEqual(loaded.dump(concatenate=True).faces.shape[1], 3)
        self.run_convert(self.glb, "ply")
        self.run_convert(self.output / "box-converted.ply", "obj", stem="from-ply")
        self.assertTrue((self.output / "from-ply.obj").is_file())

    def test_webp_textures_from_trellis_are_read(self):
        source = self.folder / "trellis.glb"
        source.write_bytes(webp_glb(self.glb.read_bytes()))
        self.run_convert(source, "obj", stem="webp")
        with Image.open(self.output / "webp-texture-0.png") as texture:
            self.assertEqual(texture.size, (4, 4))

    def test_several_meshes_become_one(self):
        scene = trimesh.Scene()
        scene.add_geometry(textured_box(), geom_name="a")
        scene.add_geometry(textured_box(shift=3.0), geom_name="b")
        source = self.folder / "two.glb"
        source.write_bytes(scene.export(file_type="glb"))
        self.run_convert(source, "stl", stem="two")
        loaded = trimesh.load(str(self.output / "two.stl"))
        self.assertEqual(loaded.faces.shape, (24, 3))

    def test_clear_errors(self):
        with self.assertRaisesRegex(converter.ConversionError, "already in that format"):
            self.run_convert(self.glb, "glb")
        with self.assertRaisesRegex(converter.ConversionError, "supported 3D format"):
            self.run_convert(self.glb, "fbx")
        cloud = self.folder / "cloud.ply"
        cloud.write_bytes(trimesh.PointCloud(np.random.rand(20, 3)).export(file_type="ply"))
        with self.assertRaisesRegex(converter.ConversionError, "points or a splat"):
            self.run_convert(cloud, "glb")
        bad = self.folder / "bad.glb"
        bad.write_bytes(b"not a model at all, definitely")
        with self.assertRaises(converter.ConversionError):
            self.run_convert(bad, "gltf")

    def test_gltf_cannot_read_outside_its_folder(self):
        outside = self.folder / "secret.bin"
        outside.write_bytes(b"secret")
        folder = self.folder / "inner"
        folder.mkdir()
        document = {
            "asset": {"version": "2.0"},
            "buffers": [{"byteLength": 6, "uri": "../secret.bin"}],
        }
        (folder / "evil.gltf").write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(converter.ConversionError, "outside its own folder"):
            self.run_convert(folder / "evil.gltf", "glb")
        data_uri = "data:application/octet-stream;base64," + base64.b64encode(b"abcd").decode()
        self.assertEqual(converter.read_uri(data_uri, folder), b"abcd")


if __name__ == "__main__":
    unittest.main()
