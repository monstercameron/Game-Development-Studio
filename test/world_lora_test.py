"""Regression checks for offline LoRA paths without allocating model memory."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from world_lora import support_offline_lora


class OfflineLoraTests(unittest.TestCase):
    def test_local_file_is_split_into_directory_and_weight_name(self):
        class Pipeline:
            def load_lora_weights(self, source, **kwargs):
                return source, kwargs

        support_offline_lora(Pipeline)
        with tempfile.TemporaryDirectory() as directory:
            weights = Path(directory) / "adapter.safetensors"
            weights.touch()
            self.assertEqual(
                Pipeline().load_lora_weights(weights), (directory, {"weight_name": weights.name})
            )
            self.assertEqual(
                Pipeline().load_lora_weights(weights, weight_name="other.safetensors"),
                (weights, {"weight_name": "other.safetensors"}),
            )
            self.assertEqual(Pipeline().load_lora_weights("remote/model"), ("remote/model", {}))


if __name__ == "__main__":
    unittest.main()
