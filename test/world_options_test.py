"""World worker request limits and result lookup, without starting a model."""

import sys
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from world_worker import WorldRequest, generate, result_path

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=="


class WorldRequestTests(unittest.TestCase):
    def test_option_ranges_match_the_studio(self):
        base = {"model": "hy-world", "mode": "image", "resolution": 518, "images": [PNG]}
        WorldRequest(**base, splat_limit=100_000, confidence_percentile=0)
        WorldRequest(**base, splat_limit=5_000_000, confidence_percentile=50, remove_sky=True)
        WorldRequest(model="worldgen", mode="text", prompt="a", resolution=1024, guidance=1)
        for bad in (
            {"splat_limit": 99_999},
            {"splat_limit": 5_000_001},
            {"confidence_percentile": 50.5},
            {"confidence_percentile": -1},
            {"guidance": 0.9},
            {"guidance": 51},
        ):
            with self.subTest(bad), self.assertRaises(ValidationError):
                WorldRequest(**base, **bad)

    def test_generators_only_accept_their_own_outputs_and_sizes(self):
        views = {"model": "hy-world", "mode": "image", "images": [PNG]}
        for bad in (
            {**views, "resolution": 518, "output": "glb"},
            {**views, "resolution": 518, "output": "mesh"},
            {**views, "resolution": 1024},
            {**views, "mode": "panorama", "resolution": 518, "images": [PNG, PNG]},
            {**views, "mode": "text", "resolution": 518},
            {"model": "worldgen", "mode": "text", "prompt": "a", "resolution": 952},
            {
                "model": "worldgen",
                "mode": "text",
                "prompt": "a",
                "resolution": 1024,
                "output": "obj",
            },
        ):
            with self.subTest(bad), self.assertRaises(HTTPException) as caught:
                generate(WorldRequest(**bad))
            self.assertEqual(caught.exception.status_code, 400)

    def test_result_path_finds_a_ply_or_a_glb_but_not_an_empty_file(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            self.assertIsNone(result_path(work))
            (work / "result.glb").write_bytes(b"")
            self.assertIsNone(result_path(work))
            self.assertEqual(result_path(work, require_data=False), work / "result.glb")
            (work / "result.glb").write_bytes(b"glTF")
            self.assertEqual(result_path(work), work / "result.glb")


if __name__ == "__main__":
    unittest.main()
