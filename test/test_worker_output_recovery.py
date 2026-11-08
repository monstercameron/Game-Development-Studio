"""Exercise committed-output recovery over HTTP across real worker restarts."""

import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PY312 = ROOT / ".forge-runtime" / "hunyuan3d-venv" / "Scripts" / "python.exe"
PYSAM = ROOT / ".forge-runtime" / "sam3-python-embed" / "python.exe"
PYTTS = ROOT / ".forge-runtime" / "tts-python-embed" / "python.exe"


def get(url):
    try:
        with urlopen(url, timeout=2) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class OutputRecoveryTests(unittest.TestCase):
    def test_atomic_outputs_survive_worker_restarts(self):
        workers = [
            ("hunyuan_worker.py", PY312, "hunyuan-outputs", "glb", "mesh", "3d-hunyuan"),
            ("sam31_worker.py", PYSAM, "sam31-outputs", "png", "image", "segmentation"),
            ("hymotion_worker.py", PY312, "hymotion-outputs", "bvh", "motion", "motion-hy"),
            ("tts_worker.py", PYTTS, "tts-outputs", "wav", "audio", "tts"),
        ]
        with tempfile.TemporaryDirectory(prefix="forge-output-recovery-") as directory:
            for filename, python, folder, extension, endpoint, engine_id in workers:
                with self.subTest(worker=filename):
                    output = Path(directory) / folder
                    output.mkdir()
                    # The empty file and the .part file stand in for interrupted writes. Only the
                    # completed output may be served, so both must answer 404.
                    job_id, empty_id, partial_id = "a" * 32, "b" * 32, "c" * 32
                    payload = b"completed output for recovery"
                    (output / f"{job_id}.{extension}").write_bytes(payload)
                    (output / f"{empty_id}.{extension}").touch()
                    (output / f".{partial_id}.part").write_bytes(b"incomplete")
                    # Each worker starts twice, so the second start must recover the same
                    # committed output from disk after the first process has exited.
                    for _ in range(2):
                        port = unused_port()
                        env = {
                            **os.environ,
                            "FORGE_RUNTIME_DIR": directory,
                            "FORGE_ENGINE_CONTROL_TOKEN": "test-token",
                            "FORGE_ENGINE_INSTANCE_NONCE": "a" * 64,
                        }
                        process = subprocess.Popen(
                            [
                                str(python),
                                "-u",
                                str(ROOT / "runtime" / filename),
                                "--port",
                                str(port),
                            ],
                            cwd=str(ROOT),
                            env=env,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        base = f"http://127.0.0.1:{port}"
                        try:
                            deadline = time.monotonic() + 20
                            while True:
                                if process.poll() is not None:
                                    self.fail(f"{filename} exited with {process.returncode}")
                                try:
                                    if get(base + "/api/status")[0] == 200:
                                        break
                                except (OSError, URLError):
                                    pass
                                if time.monotonic() > deadline:
                                    self.fail(f"{filename} did not start")
                                time.sleep(0.1)
                            status, body = get(base + f"/api/jobs/{job_id}")
                            identity_request = Request(
                                base + "/api/forge/identity",
                                headers={"X-Forge-Engine-Token": "test-token"},
                            )
                            with urlopen(identity_request, timeout=2) as response:
                                instance = json.load(response)
                            self.assertEqual(instance["engine"], engine_id)
                            self.assertEqual(instance["nonce"], "a" * 64)
                            self.assertGreater(instance["pid"], 0)
                            self.assertEqual(status, 200)
                            self.assertEqual(json.loads(body)["status"], "completed")
                            self.assertTrue(json.loads(body)["recovered"])
                            self.assertEqual(
                                get(base + f"/api/jobs/{job_id}/{endpoint}"), (200, payload)
                            )
                            for rejected in (empty_id, partial_id, "A" * 32, "not-a-job"):
                                self.assertEqual(get(base + f"/api/jobs/{rejected}")[0], 404)
                                self.assertEqual(
                                    get(base + f"/api/jobs/{rejected}/{endpoint}")[0], 404
                                )
                        finally:
                            process.terminate()
                            try:
                                process.wait(timeout=8)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
