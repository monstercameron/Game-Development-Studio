"""Raises a real, chained Python exception for the Forge error pipeline test.

Standard library only: it loads no model, opens no network connection and never touches the GPU.
The studio host (runtime/errors-test-routes.js) starts it with its stderr appended to
``engine-test.log`` in the runtime folder, which is how engine logs are written. The existing
log scanner then records the traceback as an error with the source ``engine:test``.

Variants:
    traceback  The exception is not caught, so Python prints the traceback and exits with 1.
    asgi       The exception is logged the way uvicorn logs a failed request
               ("ERROR:    Exception in ASGI application"), then the process exits normally.
"""

import argparse
import os
import sys
import traceback

# The host runs this file with -I, which keeps the script folder off sys.path, so add it here.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app_log import get_logger  # noqa: E402

log = get_logger("errors")

MARKER = "[Forge test error]"
# Deliberately fake values, present so redaction can be checked end to end.
FAKE_KEY = "sk-test-FAKE0123456789abcdef0123456789"
FAKE_BEARER = "Bearer forgeTestBearerToken0123456789"
FAKE_EMAIL = "forge-test-user@example.com"


class TestConfigurationError(Exception):
    """The intermediate error of the chain."""

    __test__ = False


def parse_worker_option(raw_value):
    # int() raises ValueError, the root cause of the chain.
    return int(raw_value)


def load_worker_settings(raw_value):
    try:
        return parse_worker_option(raw_value)
    except ValueError as cause:
        raise TestConfigurationError(
            f"{MARKER} The test worker option could not be read"
        ) from cause


def start_test_worker(run_number):
    home_file = os.path.join(
        os.path.expanduser("~"), "Documents", "forge-test-private", "notes.txt"
    )
    try:
        return load_worker_settings(f"not-a-number-{run_number}")
    except TestConfigurationError as error:
        raise RuntimeError(
            f"{MARKER} Test worker failed to start "
            f"(run {run_number}; file {home_file}; key {FAKE_KEY}; "
            f"header {FAKE_BEARER}; contact {FAKE_EMAIL})"
        ) from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Raise a chained exception for Forge.")
    parser.add_argument("--variant", choices=("traceback", "asgi"), default="traceback")
    parser.add_argument("--run", type=int, default=1)
    args = parser.parse_args(argv)
    if args.variant == "traceback":
        start_test_worker(args.run)
        return 0
    try:
        start_test_worker(args.run)
    except RuntimeError as error:
        # Expected for this variant: the traceback is written to stderr below instead of raised.
        log.debug(
            "errors.test.python.raised", {"kind": "python", "errorClass": type(error).__name__}
        )
        sys.stderr.write("ERROR:    Exception in ASGI application\n")
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
