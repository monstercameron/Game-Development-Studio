"""Regression tests for TRELLIS checkpoint readiness checks."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "runtime"))
import trellis_manifest as manifest  # noqa: E402


class TrellisManifestTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root_path = Path(self.temporary.name)
        self.model = root_path / "model"
        self.decoder = root_path / "decoder"
        self.dino = root_path / "dino"
        self.patches = (
            patch.object(manifest, "MODEL", self.model),
            patch.object(manifest, "DECODER", self.decoder),
            patch.object(manifest, "DINO", self.dino),
        )
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

        self.paths = manifest.required_files()
        for path in self.paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix == ".json":
                path.write_text("{}", encoding="utf-8")
            else:
                path.write_bytes(b"checkpoint")

    def test_complete_nonempty_manifest_is_ready(self):
        self.assertEqual(manifest.missing_files(), [])

    def test_higher_pipelines_need_their_extra_checkpoints(self):
        self.assertEqual(manifest.pipelines_available(), ["512"])
        for path in manifest.extra_files(manifest.PIPELINE_EXTRAS["1024"]):
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix == ".json":
                path.write_text("{}", encoding="utf-8")
            else:
                path.write_bytes(b"x")
        self.assertEqual(
            manifest.pipelines_available(), ["512", "1024", "1024_cascade", "1536_cascade"]
        )
        # Without the base files nothing is available, even if the extras exist.
        self.paths[0].unlink()
        self.assertEqual(manifest.pipelines_available(), [])

    def test_empty_required_file_is_reported_missing(self):
        empty_file = self.paths[-1]
        empty_file.write_bytes(b"")

        self.assertEqual(manifest.missing_files(), [empty_file])

    def test_malformed_json_is_reported_missing(self):
        malformed_json = next(path for path in self.paths if path.suffix == ".json")
        malformed_json.write_text("{invalid", encoding="utf-8")

        self.assertEqual(manifest.missing_files(), [malformed_json])


if __name__ == "__main__":
    unittest.main()
