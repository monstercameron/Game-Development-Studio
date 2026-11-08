"""Unit tests for runtime/app_log.py (structured application log, docs/LOGGING.md)."""

import json
import logging
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))

import app_log  # noqa: E402


class AppLogTest(unittest.TestCase):
    def setUp(self) -> None:
        # The app_log writer is process-wide; reset it so each test sees only its own records.
        app_log.configure(sink="memory")
        app_log._writer.memory.clear()
        app_log._writer.dedupe.clear()
        app_log._writer.tokens = float(app_log.RATE_BURST_ROWS)

    def records(self) -> list[dict]:
        return app_log.read_memory_records()

    def test_extension_field_accepts_a_leading_dot(self) -> None:
        self.assertEqual(app_log.sanitize_fields({"extension": ".glb"}), ({"extension": "glb"}, []))
        self.assertEqual(app_log.sanitize_fields({"extension": "glb"}), ({"extension": "glb"}, []))
        self.assertEqual(app_log.sanitize_fields({"extension": "..x"}), ({}, ["extension"]))
        self.assertEqual(app_log.sanitize_fields({"format": ".glb"}), ({}, ["format"]))

    def test_allow_list_keeps_safe_fields_and_counts_drops(self) -> None:
        log = app_log.get_logger("image")
        log.info(
            "model.load.completed",
            {
                "modelId": "Qwen/Qwen-Image",
                "durationMs": 81.6,
                "freeMiB": 1024,
                "isCached": True,
                "to": "ready",
                "prompt": "a castle at dusk",
                "reason": "C:\\Users\\alice\\x.png",
                "width": "wide",
            },
        )
        [record] = self.records()
        self.assertEqual(record["durationMs"], 82)
        self.assertEqual(
            record["fields"],
            {
                "modelId": "Qwen/Qwen-Image",
                "freeMiB": 1024,
                "isCached": True,
                "to": "ready",
                "droppedFields": 3,
                "droppedFieldNames": ["prompt", "reason", "width"],
            },
        )

    def test_redaction_removes_keys_paths_and_tokens(self) -> None:
        log = app_log.get_logger("errors")
        try:
            raise ValueError(
                "upload of C:\\Users\\alice\\Documents\\secret-plans.txt failed: "
                "Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijk key sk-proj-Abcdefghijklmnopqrstuvwxyz012"
            )
        except ValueError as error:
            log.error("errors.upload.failed", {"error": error})
        text = json.dumps(self.records())
        for secret in ("alice", "secret-plans", "eyJhbGciOiJIUzI1NiJ9abc", "sk-proj-Abcdef"):
            self.assertNotIn(secret, text)
        self.assertIn("ValueError", text)

    def test_levels_and_invalid_input_never_raise(self) -> None:
        log = app_log.get_logger("not-a-component")
        log.debug("job.poll.checked", {"jobId": "a"})
        log.info("Not An Event", "not a dict")
        log.info(None, None)
        events = [record["event"] for record in self.records()]
        self.assertIn("log.component.unknown", events)
        self.assertIn("log.event.invalid", events)
        self.assertNotIn("job.poll.checked", events)
        self.assertEqual(
            app_log.parse_level_spec("warn,queue=debug,nope=info"), ("warn", {"queue": "debug"})
        )

    def test_dedupe_collapses_a_hot_loop(self) -> None:
        log = app_log.get_logger("queue")
        for _ in range(50):
            log.warn("queue.poll.failed", {"jobId": "same"})
        records = self.records()
        self.assertEqual(len([r for r in records if r["count"] == 1]), 20)
        summary = next(r for r in records if r["count"] > 1)
        self.assertEqual(summary["count"], 30)
        self.assertTrue(summary["fields"]["collapsed"])

    def test_stdlib_handler_keeps_only_the_template(self) -> None:
        logger = logging.getLogger("forge.test.handler")
        logger.setLevel(logging.INFO)
        handler = app_log.install_logging_handler("voices", logger)
        try:
            logger.info("Loaded voice for %s", "a private prompt about dragons")
        finally:
            logger.removeHandler(handler)
        [record] = self.records()
        self.assertEqual(record["event"], "voices.log.info")
        self.assertEqual(record["message"], "Loaded voice for %s")
        self.assertNotIn("dragons", json.dumps(record))

    def test_time_child_and_trace(self) -> None:
        log = app_log.get_logger("world").child(jobId="job-9")
        app_log.set_trace_id("trace-python-1")
        try:
            stop = log.time("world.render.timed", {"steps": 4})
            self.assertIsInstance(stop(), int)
        finally:
            app_log.set_trace_id(None)
        [record] = self.records()
        self.assertEqual(record["jobId"], "job-9")
        self.assertEqual(record["traceId"], "trace-python-1")
        self.assertEqual(record["fields"]["steps"], 4)

    def test_thread_excepthook_logs_a_redacted_summary(self) -> None:
        original_thread_hook = threading.excepthook
        original_hook = sys.excepthook

        def crash() -> None:
            raise RuntimeError("worker failed at /home/alice/model.bin")

        try:
            # A silent previous hook keeps the traceback out of the test output.
            threading.excepthook = lambda args: None
            app_log.install_excepthook("world")
            thread = threading.Thread(target=crash)
            thread.start()
            thread.join()
        finally:
            threading.excepthook = original_thread_hook
            sys.excepthook = original_hook
        record = next(r for r in self.records() if r["event"] == "thread.exception.uncaught")
        self.assertEqual(record["fields"]["errorClass"], "RuntimeError")
        self.assertNotIn("alice", json.dumps(record))

    def test_spool_file_and_exit_flush(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = (
                "import sys; sys.path.insert(0, sys.argv[1]); import app_log; "
                "log = app_log.get_logger('image'); "
                "log.info('image.render.completed', {'jobId': 'j1', 'durationMs': 5})"
            )
            # Replacing the whole environment keeps the developer's own settings out of the
            # child process. SYSTEMROOT is required by Windows for Python to start.
            env = {"FORGE_RUNTIME_DIR": directory, "SYSTEMROOT": str(Path("C:/Windows"))}
            subprocess.run(
                [sys.executable, "-c", script, str(ROOT / "runtime")],
                env=env,
                check=True,
                timeout=60,
            )
            files = list((Path(directory) / "log-spool").glob("*.jsonl"))
            self.assertEqual(len(files), 1)
            [line] = files[0].read_text(encoding="utf-8").splitlines()
            record = json.loads(line)
            self.assertEqual(record["event"], "image.render.completed")
            self.assertEqual(record["jobId"], "j1")


if __name__ == "__main__":
    unittest.main()
