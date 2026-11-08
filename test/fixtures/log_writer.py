"""Python writer process for test/app-log.test.js: python log_writer.py <rows>."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))

import app_log  # noqa: E402

app_log.configure(process_name="py-writer")
log = app_log.get_logger("image")
for index in range(int(sys.argv[1])):
    log.info("job.state.changed", {"jobId": f"py-{index}", "to": "running", "index": index})
