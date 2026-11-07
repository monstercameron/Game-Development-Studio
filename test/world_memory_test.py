"""Exercise the render-only memory guard without starting a model."""
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from world_worker import wait_for_render


class FakeGuard:
    def __init__(self): self.closed = False
    def close(self): self.closed = True


class FakeChild:
    def __init__(self, guard, finish_after):
        self.guard, self.finish_after, self.calls, self.returncode = guard, finish_after, 0, None
    def poll(self): return self.returncode
    def wait(self, timeout):
        self.calls += 1
        if self.guard.closed or self.calls > self.finish_after:
            self.returncode = 1 if self.guard.closed else 0
            return self.returncode
        raise subprocess.TimeoutExpired('test-render', timeout)


class WorldMemoryTests(unittest.TestCase):
    def test_aborts_only_after_repeated_critical_commit(self):
        guard = FakeGuard(); child = FakeChild(guard, 20)
        with self.assertRaisesRegex(RuntimeError, 'Windows commit memory'):
            wait_for_render(child, guard, lambda: 100)
        self.assertTrue(guard.closed)

    def test_recovers_from_transient_low_memory(self):
        guard = FakeGuard(); child = FakeChild(guard, 3)
        samples = iter([100, 5 * 1024**3, 100])
        self.assertEqual(wait_for_render(child, guard, lambda: next(samples)), 0)
        self.assertFalse(guard.closed)


if __name__ == '__main__': unittest.main()
