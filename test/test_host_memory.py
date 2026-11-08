import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))

from host_memory import HOST_MEMORY_FLOOR_BYTES, host_bytes_needed  # noqa: E402

GIB = 1024**3


class HostMemoryPolicyTest(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.pop("FORGE_HOST_MEMORY_POLICY", None)

    def tearDown(self):
        os.environ.pop("FORGE_HOST_MEMORY_POLICY", None)
        if self.saved is not None:
            os.environ["FORGE_HOST_MEMORY_POLICY"] = self.saved

    def test_default_is_a_soft_floor(self):
        self.assertEqual(host_bytes_needed(12 * GIB), HOST_MEMORY_FLOOR_BYTES)

    def test_floor_never_exceeds_a_smaller_budget(self):
        self.assertEqual(host_bytes_needed(GIB), GIB)

    def test_strict_policy_enforces_the_full_budget(self):
        os.environ["FORGE_HOST_MEMORY_POLICY"] = "Strict"
        self.assertEqual(host_bytes_needed(12 * GIB), 12 * GIB)


if __name__ == "__main__":
    unittest.main()
