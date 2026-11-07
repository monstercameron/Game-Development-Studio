"""Test transparent-input validation and render parameter forwarding."""

import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

from PIL import Image

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "runtime"))
import trellis_backend as backend  # noqa: E402 - runtime path is added immediately above.


def rejects(image):
    try:
        backend.validate_transparent(image)
    except ValueError:
        return
    raise AssertionError("Invalid foreground was accepted.")


rejects(Image.new("RGB", (8, 8)))
rejects(Image.new("RGBA", (8, 8), (0, 0, 0, 255)))
rejects(Image.new("RGBA", (8, 8), (0, 0, 0, 0)))
image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
for y in range(2, 6):
    for x in range(2, 6):
        image.putpixel((x, y), (200, 50, 20, 255))
backend.validate_transparent(image)


class Mesh:
    vertices = [1, 2, 3]
    faces = [1]
    attrs = "attrs"
    coords = "coords"
    layout = "layout"
    voxel_size = 1.0

    def simplify(self, value):
        assert value == 16777216


class Pipeline:
    def run(self, provided, **kwargs):
        assert provided is image and kwargs["seed"] == 23 and kwargs["pipeline_type"] == "512"
        assert all(
            kwargs[name] == {"steps": 3}
            for name in (
                "sparse_structure_sampler_params",
                "shape_slat_sampler_params",
                "tex_slat_sampler_params",
            )
        )
        return [Mesh()]


class Output:
    def export(self, path, file_type, extension_webp):
        assert file_type == "glb" and extension_webp
        Path(path).write_bytes(b"glTF")


def bake(**kwargs):
    assert kwargs["texture_size"] == 512 and kwargs["remesh"] is True
    return Output()


with (
    tempfile.TemporaryDirectory() as folder,
    patch.dict(
        sys.modules,
        {"o_voxel": types.SimpleNamespace(postprocess=types.SimpleNamespace(to_glb=bake))},
    ),
    patch.object(backend.torch.cuda, "is_available", return_value=True),
):
    output = Path(folder) / "test.glb"
    backend.generate_glb(Pipeline(), image, output, seed=23, steps=3, texture_size=512)
    assert output.read_bytes() == b"glTF"
    try:
        backend.generate_glb(Pipeline(), image, output, steps=0)
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid step count was accepted.")
print("TRELLIS.2 input validation and render controls passed with a substitute renderer.")
