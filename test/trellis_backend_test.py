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
        # The image is a cleaned copy (see clear_faint_alpha), identical for a clean input.
        assert provided.tobytes() == image.tobytes() and kwargs["seed"] == 23
        assert kwargs["pipeline_type"] == "512"
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


class Recorder:
    def __init__(self):
        self.models = {}
        self.types = []

    def run(self, provided, **kwargs):
        self.types.append(kwargs["pipeline_type"])
        return [Mesh()]


with (
    tempfile.TemporaryDirectory() as folder,
    patch.dict(
        sys.modules,
        {"o_voxel": types.SimpleNamespace(postprocess=types.SimpleNamespace(to_glb=bake))},
    ),
    patch.object(backend.torch.cuda, "is_available", return_value=True),
    patch.object(backend, "ensure_pipeline_models") as ensure,
):
    recorder = Recorder()
    output = Path(folder) / "test.glb"
    backend.generate_glb(
        recorder, image, output, seed=1, steps=3, texture_size=512, pipeline_type="1024_cascade"
    )
    assert recorder.types == ["1024_cascade"]
    assert ensure.call_args.args[:2] == (recorder, "1024_cascade")
    for bad in ("2048", "", None):
        try:
            backend.generate_glb(recorder, image, output, texture_size=512, pipeline_type=bad)
        except ValueError:
            continue
        raise AssertionError("Unsupported pipeline type was accepted.")
    # After a first-use checkpoint load the job message returns to the render message.
    ensure.return_value = True
    notes = []
    backend.generate_glb(
        recorder, image, output, texture_size=512, pipeline_type="1024", report=notes.append
    )
    assert notes == ["Generating textured 3D model (1024 pipeline)."]


haze = Image.new("RGBA", (8, 8), (90, 60, 30, 20))
haze.putpixel((3, 3), (200, 50, 20, 255))
haze.putpixel((4, 4), (200, 50, 20, 100))
cleared = backend.clear_faint_alpha(haze)
assert cleared.getpixel((0, 0)) == (0, 0, 0, 0)
assert cleared.getpixel((3, 3)) == (200, 50, 20, 255)
assert cleared.getpixel((4, 4)) == (200, 50, 20, 100)


class Component:
    pass


with patch.object(backend, "pipelines_available", return_value=["512"]):
    pipeline = types.SimpleNamespace(models={"shape_slat_flow_model_512": Component()})
    backend.ensure_pipeline_models(pipeline, "512")
    try:
        backend.ensure_pipeline_models(pipeline, "1024")
    except RuntimeError as error:
        assert "not installed" in str(error)
    else:
        raise AssertionError("A pipeline without checkpoints was accepted.")
loaded = []
with (
    patch.object(
        backend, "pipelines_available", return_value=["512", "1024", "1024_cascade", "1536_cascade"]
    ),
    patch.object(backend, "_load_component", side_effect=lambda base: loaded.append(base) or base),
):
    pipeline = types.SimpleNamespace(models={"shape_slat_flow_model_512": Component()})
    messages = []
    assert backend.ensure_pipeline_models(pipeline, "1536_cascade", messages.append) is True
    assert set(pipeline.models) == {
        "shape_slat_flow_model_512",
        "shape_slat_flow_model_1024",
        "tex_slat_flow_model_1024",
    }
    assert len(loaded) == 2 and messages
    # Already loaded: nothing more to read.
    assert backend.ensure_pipeline_models(pipeline, "1024") is False
    assert len(loaded) == 2
print("TRELLIS.2 input validation and render controls passed with a substitute renderer.")
