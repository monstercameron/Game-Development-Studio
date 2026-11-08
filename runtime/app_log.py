"""Forge structured application log for Python workers (stdlib only).

Mirrors runtime/app-log.js and runtime/log-fields.js; see docs/LOGGING.md and
docs/LOGGING_CONVERSION_GUIDE.md.

    from app_log import get_logger

    log = get_logger("image")
    log.info("model.load.completed", {"modelId": "Qwen/Qwen-Image", "durationMs": 8123})

Guarantees, as in Node:

- A call never raises into the caller and never waits for disk. Records are validated, redacted
  and buffered; a daemon thread appends them to this process's own spool file in
  ``<runtime>/log-spool`` every 250 ms, and ``atexit`` flushes the rest. The studio host ingests
  spool files into ``.forge-runtime/logs.sqlite``.
- Field names are checked against the same allow-list as Node; free text, paths and secrets are
  dropped (and counted on the record) instead of stored.
- Identical records in a hot loop are collapsed, and a token bucket caps the rate.

``install_logging_handler(component)`` sends existing ``logging.getLogger`` output to the same
log. Only the message *template* (``record.msg``) is kept when ``%``-arguments are present, so
argument values such as prompts never reach the log. ``install_excepthook(component)`` records
uncaught exceptions with a redacted summary.
"""

from __future__ import annotations

import atexit
import getpass
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

LOG_LEVELS = {"trace": 10, "debug": 20, "info": 30, "warn": 40, "error": 50}
DEFAULT_LOG_LEVEL = "info"
LEVEL_ENV = "FORGE_LOG_LEVEL"
TRACE_ENV = "FORGE_TRACE_ID"

# Keep in step with LOG_COMPONENTS in runtime/log-fields.js.
LOG_COMPONENTS = frozenset(
    {
        "assets",
        "asr",
        "catalog",
        "chat",
        "credentials",
        "desktop",
        "diagnostics",
        "engine",
        "errors",
        "game",
        "gpu",
        "http",
        "i18n",
        "image",
        "install",
        "log",
        "mcp",
        "megascans",
        "memory",
        "metadata",
        "model",
        "motion",
        "music",
        "power",
        "projects",
        "queue",
        "references",
        "runtime",
        "segmentation",
        "server",
        "settings",
        "sfx",
        "supervisor",
        "three-d",
        "thumbnails",
        "transcode",
        "trash",
        "tray",
        "ui",
        "unknown",
        "vegetation",
        "video",
        "voices",
        "world",
    }
)

EVENT_LENGTH = 96
MESSAGE_LENGTH = 300
STRING_FIELD_LENGTH = 160
ERROR_MESSAGE_LENGTH = 300
FIELD_COUNT = 32
ARRAY_ITEMS = 20
FIELDS_JSON_LENGTH = 4096

FLUSH_SECONDS = 0.25
ROLL_BYTES = 4 * 1024 * 1024
PROCESS_CAP_BYTES = 32 * 1024 * 1024
BUFFER_CAP_ROWS = 5000
RATE_BURST_ROWS = 1000
RATE_ROWS_PER_SECOND = 200
DEDUPE_WINDOW_SECONDS = 10.0
DEDUPE_BURST_ROWS = 20
DEDUPE_KEYS_CAP = 2000
LEVEL_REFRESH_SECONDS = 5.0
MEMORY_CAP_ROWS = 5000

EVENT_PATTERN = re.compile(r"^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){1,5}$")
ID_VALUE = re.compile(r"^[A-Za-z0-9._:+/-]{1,128}$")
ENUM_VALUE = re.compile(r"^[A-Za-z0-9_/][A-Za-z0-9._:+/=-]{0,79}$")
FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,47}$")
TRACE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
NUMERIC_NAME = re.compile(
    r"(?:Ms|Sec|Seconds|Minutes|Hours|Days|Bytes|KiB|MiB|GiB|Count|Total|Index|Percent|Pct|Ratio|Tokens|Px|Width"
    r"|Height|Fps|Frames|Steps|Seed|Size|Limit|Attempt|Attempts|Pid|Port|Status|Code|Version"
    r"|Depth|Length|Max|Min|Rate|Score|Temperature|Position|Priority|Mb|Gb)$"
)
NUMERIC_NAMES = frozenset(
    {
        "attempt",
        "bytes",
        "count",
        "depth",
        "exitCode",
        "height",
        "index",
        "limit",
        "mib",
        "pid",
        "port",
        "position",
        "priority",
        "seed",
        "status",
        "steps",
        "total",
        "width",
    }
)
BOOLEAN_NAME = re.compile(r"^(?:is|has|can|should|was|did|will|needs|uses)[A-Z]")
BOOLEAN_NAMES = frozenset({"ok", "ready", "cached", "forced", "dryRun", "retry", "enabled"})
ID_NAME = re.compile(r"(?:Id|Hash|Sha|Digest|Revision)$")
IDS_NAME = re.compile(r"Ids$")
ENUM_NAMES = frozenset(
    {
        "action",
        "arch",
        "aspect",
        "backend",
        "category",
        "code",
        "component",
        "decision",
        "device",
        "direction",
        "dtype",
        "engine",
        "errorClass",
        "errorCode",
        "extension",
        "feature",
        "format",
        "from",
        "host",
        "kind",
        "language",
        "locale",
        "method",
        "mode",
        "model",
        "nextState",
        "operation",
        "outcome",
        "page",
        "phase",
        "platform",
        "policy",
        "precision",
        "previousState",
        "protocol",
        "provider",
        "quality",
        "reason",
        "resolution",
        "result",
        "route",
        "scope",
        "settingKey",
        "signal",
        "source",
        "stage",
        "state",
        "status",
        "target",
        "to",
        "transport",
        "trigger",
        "type",
        "unit",
        "version",
        "view",
        "voiceMode",
    }
)

_REPO_ROOT = Path(__file__).resolve().parent.parent

# The same secret patterns as runtime/error-redaction.js.
_SECRET_PATTERNS = [
    (re.compile(r"\bsk-(?:proj-|svcacct-|admin-|ant-)?[A-Za-z0-9_-]{16,}"), "[redacted-key]"),
    (re.compile(r"\bhf_[A-Za-z0-9]{16,}"), "[redacted-key]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "[redacted-key]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "[redacted-key]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[redacted-key]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[redacted-key]"),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
        "[redacted-token]",
    ),
    (re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE), r"\1 [redacted]"),
    (
        re.compile(
            r"([?&](?:token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|auth|sig"
            r"|signature|password|pass|secret|client_secret|code|session|sessionid)=)[^&\s#\"'<>]+",
            re.IGNORECASE,
        ),
        r"\1[redacted]",
    ),
    (
        re.compile(
            r"((?<![A-Za-z0-9_])[\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token"
            r"|auth[_-]?token|hf[_-]?token|token|password|passwd|secret|client[_-]?secret"
            r"|cookie|set-cookie|authorization)[\"']?\s*[:=]\s*[\"']?)(?!\[redacted)[^\s\"',;}&]+",
            re.IGNORECASE,
        ),
        r"\1[redacted]",
    ),
    (
        re.compile(
            r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}"
            r"(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b"
        ),
        "<email>",
    ),
]
_HOME_WINDOWS = re.compile(
    r"(?:file:/{2,3})?\b[A-Za-z]:(?:\\\\|\\|/)(?:Users|Documents and Settings)(?:\\\\|\\|/)"
    r"[^\\/\r\n\"'<>|:*?\s]+",
    re.IGNORECASE,
)
_HOME_POSIX = re.compile(r"(?<![A-Za-z0-9_.-])/(?:home|Users)/[^/\s\"'<>]+")
_WINDOWS_PATH = re.compile(
    r"(?:file:/{2,3})?\b[A-Za-z]:(?:\\\\|\\|/)(?:[^\\/\r\n\"'<>|:*?()\[\]]+(?:\\\\|\\|/))*"
    r"[^\\/\r\n\"'<>|:*?()\[\]\s]*"
)
_LOOPBACK = re.compile(r"https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?", re.IGNORECASE)


def _shorten_path(match: re.Match[str]) -> str:
    text = match.group(0)
    separator = "/" if "/" in text and "\\" not in text else "\\"
    parts = [part for part in re.split(r"[\\/]+", text) if part]
    for index, part in enumerate(parts):
        if re.fullmatch(r"(site|dist)-packages", part, re.IGNORECASE):
            return separator.join(["<site-packages>", *parts[index + 1 :]])
    if len(parts) <= 1:
        return "<path>"
    return separator.join(["<path>", *parts[-2:]])


def _root_pattern(root: str) -> re.Pattern[str] | None:
    parts = [re.escape(part).replace(r"\ ", "(?: |%20)") for part in re.split(r"[\\/]+", root)]
    parts = [part for part in parts if part]
    if not parts:
        return None
    return re.compile(
        r"(?:file:/{2,3})?" + r"[\\/]+".join(parts) + r"(?![A-Za-z0-9_.-])", re.IGNORECASE
    )


def _home_directory() -> str:
    # A worker started with a minimal environment may have no USERPROFILE/HOME; importing the
    # logger must still work (the generic C:\Users\<name> rule then covers home paths).
    try:
        return str(Path.home())
    except (RuntimeError, KeyError, OSError):
        return ""


def _local_roots() -> list[tuple[re.Pattern[str], str]]:
    runtime = os.environ.get("FORGE_RUNTIME_DIR") or str(_REPO_ROOT / ".forge-runtime")
    projects = os.environ.get("FORGE_PROJECTS_DIR") or str(_REPO_ROOT / "projects")
    roots = [
        (str(_REPO_ROOT), "<repo>"),
        (projects, "<projects>"),
        (runtime, "<runtime>"),
        (_home_directory(), "<home>"),
    ]
    roots.sort(key=lambda item: len(item[0]), reverse=True)
    compiled = []
    for root, placeholder in roots:
        pattern = _root_pattern(root) if len(root) > 3 else None
        if pattern:
            compiled.append((pattern, placeholder))
    return compiled


try:
    _USER = getpass.getuser()
except Exception:  # noqa: BLE001 - some service accounts have no user record.
    _USER = ""
_ROOTS = _local_roots()
_USER_PATTERN = (
    re.compile(r"(?<![A-Za-z0-9_])" + re.escape(_USER) + r"(?![A-Za-z0-9_])", re.IGNORECASE)
    if len(_USER.strip()) >= 3
    else None
)


_PRIVATE_PATH_TAIL = re.compile(r"(<home>|<projects>|<path>|<user>)((?:[\\/]+[^\\/\s\"'<>|:*?]+)+)")


def _private_tail(match: re.Match[str]) -> str:
    tail = match.group(2)
    separator = "\\" if "\\" in tail else "/"
    extension = re.search(r"\.([A-Za-z0-9]{1,8})$", tail)
    return f"{match.group(1)}{separator}<file>{'.' + extension.group(1) if extension else ''}"


def redact_text(value: Any) -> str:
    """Like redactLogText in runtime/log-fields.js: secrets, emails, user names and absolute
    paths are replaced, and file names under private placeholders keep only their extension."""
    return _PRIVATE_PATH_TAIL.sub(_private_tail, _redact_shared(value))


def _redact_shared(value: Any) -> str:
    """Removes secrets, emails, user names and absolute paths, like redactText in Node."""
    if not isinstance(value, str) or not value:
        return ""
    text = value
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    for pattern, placeholder in _ROOTS:
        text = pattern.sub(placeholder, text)
    text = _HOME_WINDOWS.sub("<home>", text)
    text = _HOME_POSIX.sub("<home>", text)
    text = _WINDOWS_PATH.sub(_shorten_path, text)
    text = _LOOPBACK.sub("<studio>", text)
    if _USER_PATTERN:
        text = _USER_PATTERN.sub("<user>", text)
    return text


def _clean_string(value: Any, limit: int) -> str:
    text = re.sub(r"[\r\n\t]+", " ", redact_text(str(value)))
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _frames(tb: Any) -> list[str]:
    frames = []
    for frame in traceback.extract_tb(tb)[-5:]:
        frames.append(f"{Path(frame.filename).name}:{frame.name}"[:STRING_FIELD_LENGTH])
    return frames


def describe_error(error: BaseException | None) -> dict[str, Any]:
    """Safe fields for an exception: class, optional code, redacted message, top frames."""
    if error is None:
        return {}
    fields: dict[str, Any] = {}
    name = type(error).__name__
    fields["errorClass"] = name if re.fullmatch(r"[A-Za-z0-9_.$]{1,60}", name) else "Error"
    code = getattr(error, "errno", None) or getattr(error, "code", None)
    if isinstance(code, int) and not isinstance(code, bool):
        fields["errorCode"] = code
    elif isinstance(code, str) and ENUM_VALUE.fullmatch(code):
        fields["errorCode"] = code
    message = str(error)
    if message:
        fields["errorMessage"] = _clean_string(message, ERROR_MESSAGE_LENGTH)
    if error.__traceback__ is not None:
        frames = _frames(error.__traceback__)
        if frames:
            fields["errorFrames"] = frames
    return fields


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == value
        and value not in (float("inf"), float("-inf"))
    )


_REJECT = object()


def _accept_id(value: Any) -> Any:
    if _is_number(value):
        return value
    if isinstance(value, str) and ID_VALUE.fullmatch(value):
        return _clean_string(value, STRING_FIELD_LENGTH)
    return _REJECT


def _accept_field(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name in BOOLEAN_NAMES or BOOLEAN_NAME.match(name):
        return value if isinstance(value, bool) else _REJECT
    if IDS_NAME.search(name):
        if not isinstance(value, (list, tuple)):
            return _REJECT
        items = [_accept_id(item) for item in list(value)[:ARRAY_ITEMS]]
        return _REJECT if any(item is _REJECT for item in items) else items
    if ID_NAME.search(name) or name == "id":
        return _accept_id(value)
    is_numeric_name = name in NUMERIC_NAMES or bool(NUMERIC_NAME.search(name))
    if _is_number(value):
        return value if is_numeric_name else _REJECT
    if name in ENUM_NAMES and isinstance(value, str) and ENUM_VALUE.fullmatch(value):
        return _clean_string(value, STRING_FIELD_LENGTH)
    return _REJECT


def sanitize_fields(fields: Any) -> tuple[dict[str, Any], list[str]]:
    """Validates a field dict against the allow-list. Returns (kept fields, dropped names)."""
    kept: dict[str, Any] = {}
    dropped: list[str] = []
    if fields is None:
        return kept, dropped
    if not isinstance(fields, dict):
        return kept, ["(not-an-object)"]
    count = 0
    for name, value in fields.items():
        safe_name = name if isinstance(name, str) and FIELD_NAME.match(name) else "(invalid-name)"
        if count >= FIELD_COUNT:
            dropped.append(safe_name)
            continue
        if value is None and safe_name == name:
            continue
        if name in ("error", "err") and isinstance(value, BaseException):
            kept.update(describe_error(value))
            count += 1
            continue
        if safe_name != name:
            dropped.append(safe_name)
            continue
        # Callers often pass a suffix such as ".png"; the value rule wants a bare word.
        candidate = value
        if name == "extension" and isinstance(value, str) and value.startswith("."):
            candidate = value[1:]
        accepted = _accept_field(name, candidate)
        if accepted is _REJECT:
            dropped.append(name)
            continue
        kept[name] = accepted
        count += 1
    return kept, dropped


def parse_level_spec(spec: Any) -> tuple[str, dict[str, str]]:
    """Parses 'info' or 'warn,queue=debug'. Invalid parts are ignored."""
    level = DEFAULT_LOG_LEVEL
    components: dict[str, str] = {}
    if not isinstance(spec, str):
        return level, components
    for raw in spec.split(","):
        part = raw.strip().lower()
        if not part:
            continue
        name, _, value = part.partition("=") if "=" in part else ("", "", part)
        if value not in LOG_LEVELS:
            continue
        if not name:
            level = value
        elif name in LOG_COMPONENTS:
            components[name] = value
    return level, components


def _default_sink() -> str:
    explicit = os.environ.get("FORGE_LOG_SINK", "")
    if explicit in ("off", "memory", "spool"):
        return explicit
    has_own_directory = bool(os.environ.get("FORGE_RUNTIME_DIR") or os.environ.get("FORGE_LOG_DIR"))
    # NODE_TEST_CONTEXT is inherited by workers that a `node --test` file spawns.
    is_test_run = (
        "unittest" in sys.modules
        or "pytest" in sys.modules
        or bool(os.environ.get("NODE_TEST_CONTEXT"))
    )
    return "memory" if is_test_run and not has_own_directory else "spool"


def _slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9-]+", "-", text.lower()).strip("-")[:40]
    return value or "python"


class _Writer:
    """Process-wide buffer, rate limiter and spool file writer."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.process_name = (
            os.environ.get("FORGE_LOG_PROCESS")
            or Path(sys.argv[0] if sys.argv and sys.argv[0] else "python").stem
        )
        runtime = os.environ.get("FORGE_RUNTIME_DIR") or str(_REPO_ROOT / ".forge-runtime")
        self.runtime_dir = Path(runtime)
        self.spool_dir = Path(os.environ.get("FORGE_LOG_DIR") or self.runtime_dir / "log-spool")
        self.mode = _default_sink()
        self.start_ms = int(time.time() * 1000)
        self.seq = 0
        self.buffer: list[dict[str, Any]] = []
        self.memory: list[dict[str, Any]] = []
        self.file_index = 0
        self.file_path: Path | None = None
        self.file_bytes = 0
        self.blocked_until = 0.0
        self.tokens = float(RATE_BURST_ROWS)
        self.tokens_at = time.monotonic()
        self.dedupe: dict[str, dict[str, Any]] = {}
        self.dropped = {"rate": 0, "buffer": 0, "spool": 0, "write": 0}
        self.internal_errors = 0
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.next_level_refresh = 0.0
        self.default_threshold = LOG_LEVELS[DEFAULT_LOG_LEVEL]
        self.component_thresholds: dict[str, int] = {}
        trace = os.environ.get(TRACE_ENV, "")
        self.trace_id = trace if TRACE_ID_PATTERN.match(trace) else None
        self.local = threading.local()

    # Levels -------------------------------------------------------------------------------
    def refresh_levels(self, now: float) -> None:
        self.next_level_refresh = now + LEVEL_REFRESH_SECONDS
        spec = os.environ.get(LEVEL_ENV, "")
        if not spec and self.mode == "spool":
            try:
                spec = self._settings_spec()
            except Exception:  # noqa: BLE001 - a locked settings file keeps the default level.
                self.internal_errors += 1
                spec = ""
        level, components = parse_level_spec(spec)
        self.default_threshold = LOG_LEVELS[level]
        self.component_thresholds = {name: LOG_LEVELS[value] for name, value in components.items()}

    def _settings_spec(self) -> str:
        import sqlite3

        settings = self.runtime_dir / "settings.sqlite"
        if not settings.exists():
            return ""
        uri = settings.resolve().as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=0.05)
        try:
            rows = connection.execute(
                "SELECT key,value_json FROM settings_overrides "
                "WHERE key IN ('logs.level','logs.componentLevels')"
            ).fetchall()
        except sqlite3.OperationalError:
            return ""
        finally:
            connection.close()
        values = {key: json.loads(value) for key, value in rows}
        parts = [values.get("logs.level"), values.get("logs.componentLevels")]
        return ",".join(part for part in parts if isinstance(part, str) and part)

    def threshold(self, component: str) -> int:
        now = time.monotonic()
        if now >= self.next_level_refresh:
            self.refresh_levels(now)
        return self.component_thresholds.get(component, self.default_threshold)

    # Gates --------------------------------------------------------------------------------
    def _take_token(self) -> bool:
        now = time.monotonic()
        elapsed = now - self.tokens_at
        if elapsed > 0:
            self.tokens = min(RATE_BURST_ROWS, self.tokens + elapsed * RATE_ROWS_PER_SECOND)
            self.tokens_at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True

    def _summary(self, entry: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        last = dict(entry["last"])
        last.update(
            seq=self.seq,
            count=entry["suppressed"],
            firstTs=entry["first_ts"],
            fields={**last["fields"], "collapsed": True},
        )
        return last

    def _passes_dedupe(self, record: dict[str, Any]) -> bool:
        key = "\x01".join(
            [
                record["level"],
                record["component"],
                record["event"],
                str(record.get("jobId") or ""),
                record["message"],
            ]
        )
        entry = self.dedupe.get(key)
        window_ms = DEDUPE_WINDOW_SECONDS * 1000
        if entry is None or record["ts"] - entry["start"] >= window_ms:
            if entry is not None and entry["suppressed"]:
                self.buffer.append(self._summary(entry))
            if entry is None and len(self.dedupe) >= DEDUPE_KEYS_CAP:
                return True
            entry = {"start": record["ts"], "passed": 0, "suppressed": 0, "first_ts": 0}
            self.dedupe[key] = entry
        if entry["passed"] < DEDUPE_BURST_ROWS:
            entry["passed"] += 1
            return True
        entry["suppressed"] += 1
        entry["first_ts"] = entry["first_ts"] or record["ts"]
        entry["last"] = record
        return False

    def _sweep(self, now_ms: int, force: bool) -> None:
        window_ms = DEDUPE_WINDOW_SECONDS * 1000
        for key in list(self.dedupe):
            entry = self.dedupe[key]
            if force or now_ms - entry["start"] >= window_ms:
                if entry["suppressed"]:
                    self.buffer.append(self._summary(entry))
                del self.dedupe[key]

    def _drop_records(self, now_ms: int) -> None:
        for reason, count in list(self.dropped.items()):
            if not count:
                continue
            self.dropped[reason] = 0
            self.seq += 1
            self.buffer.append(
                self._record(
                    now_ms,
                    "warn",
                    "log",
                    "log.records.dropped",
                    "Log records were dropped.",
                    {"droppedCount": count, "reason": reason},
                    [],
                )
            )

    # Records ------------------------------------------------------------------------------
    def _record(
        self,
        now_ms: int,
        level: str,
        component: str,
        event: str,
        message: str,
        fields: dict[str, Any],
        dropped: list[str],
    ) -> dict[str, Any]:
        rest = dict(fields)
        trace_id = rest.pop("traceId", None) or getattr(self.local, "trace_id", None)
        job_id = rest.pop("jobId", None)
        duration = rest.pop("durationMs", None)
        if dropped:
            rest["droppedFields"] = len(dropped)
            rest["droppedFieldNames"] = dropped[:8]
        if len(json.dumps(rest)) > FIELDS_JSON_LENGTH:
            rest = {"fieldsTruncated": True, "droppedFields": len(rest)}
        return {
            "ts": now_ms,
            "level": level,
            "component": component,
            "event": event,
            "message": message,
            "process": self.process_name,
            "pid": os.getpid(),
            "seq": self.seq,
            "traceId": trace_id or self.trace_id,
            "jobId": None if job_id is None else str(job_id),
            "durationMs": round(duration) if _is_number(duration) else None,
            "count": 1,
            "firstTs": None,
            "fields": rest,
        }

    def emit(
        self,
        component: str,
        level: str,
        event: Any,
        fields: Any,
        message: Any,
        context: dict[str, Any] | None,
    ) -> None:
        try:
            if self.mode == "off":
                return
            now_ms = int(time.time() * 1000)
            is_valid = isinstance(event, str) and len(event) <= EVENT_LENGTH
            is_valid = is_valid and bool(EVENT_PATTERN.match(event))
            clean, dropped = sanitize_fields(fields)
            if not is_valid:
                clean["invalidEvent"] = True
            merged = {**context, **clean} if context else clean
            text = (
                _clean_string(message, MESSAGE_LENGTH)
                if isinstance(message, str) and message
                else ""
            )
            with self.lock:
                record = self._record(
                    now_ms,
                    level,
                    component,
                    event if is_valid else "log.event.invalid",
                    text,
                    merged,
                    dropped,
                )
                if not self._passes_dedupe(record):
                    return
                if not self._take_token():
                    self.dropped["rate"] += 1
                    return
                if len(self.buffer) >= BUFFER_CAP_ROWS:
                    self.dropped["buffer"] += 1
                    return
                self.seq += 1
                record["seq"] = self.seq
                self.buffer.append(record)
                self._ensure_thread()
        except Exception:  # noqa: BLE001 - logging must never raise into the caller.
            self.internal_errors += 1

    # Spool --------------------------------------------------------------------------------
    def _prefix(self) -> str:
        return f"{_slug(self.process_name)}-{os.getpid()}-0-{self.start_ms}-"

    def _own_bytes(self) -> int:
        total = 0
        prefix = self._prefix()
        for entry in self.spool_dir.iterdir():
            if entry.name.startswith(prefix):
                try:
                    total += entry.stat().st_size
                except OSError:
                    continue
        return total

    def _file_for(self, size: int) -> Path | None:
        now = time.monotonic()
        if now < self.blocked_until:
            return None
        if self.file_path is None or self.file_bytes + size > ROLL_BYTES:
            self.spool_dir.mkdir(parents=True, exist_ok=True)
            if self._own_bytes() > PROCESS_CAP_BYTES:
                self.blocked_until = now + 10
                self.file_path = None
                return None
            self.file_index += 1
            self.file_path = self.spool_dir / f"{self._prefix()}{self.file_index}.jsonl"
            self.file_bytes = 0
        return self.file_path

    def flush(self, force: bool = False) -> None:
        """Writes buffered records. Safe to call from any thread; never raises."""
        try:
            with self.lock:
                now_ms = int(time.time() * 1000)
                self._sweep(now_ms, force)
                self._drop_records(now_ms)
                batch, self.buffer = self.buffer, []
                if not batch:
                    return
                if self.mode == "memory":
                    self.memory.extend(batch)
                    del self.memory[:-MEMORY_CAP_ROWS]
                    return
                if self.mode == "off":
                    return
                text = "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in batch)
                encoded = text.encode("utf-8")
                target = self._file_for(len(encoded))
                if target is None:
                    self.dropped["spool"] += len(batch)
                    return
                try:
                    with open(target, "ab") as handle:
                        handle.write(encoded)
                    self.file_bytes += len(encoded)
                except OSError:
                    self.dropped["write"] += len(batch)
                    self.file_path = None
        except Exception:  # noqa: BLE001 - logging must never raise into the caller.
            self.internal_errors += 1

    def _run(self) -> None:
        while not self.stop_event.wait(FLUSH_SECONDS):
            self.flush()

    def _ensure_thread(self) -> None:
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, name="forge-app-log", daemon=True)
            self.thread.start()
            atexit.register(self.flush, True)


_writer = _Writer()


class AppLogger:
    """Logger for one component. Use get_logger(component) to create one."""

    def __init__(self, component: str, context: dict[str, Any] | None = None) -> None:
        self.component = component if component in LOG_COMPONENTS else "unknown"
        self._context = context or None
        if self.component != component:
            _writer.emit(
                "log",
                "warn",
                "log.component.unknown",
                {},
                "A logger used an unregistered component.",
                None,
            )

    def is_enabled(self, level: str) -> bool:
        try:
            return LOG_LEVELS.get(level, 999) >= _writer.threshold(self.component)
        except Exception:  # noqa: BLE001 - logging must never raise into the caller.
            return False

    def _log(self, level: str, event: str, fields: Any, message: Any) -> None:
        try:
            if LOG_LEVELS[level] >= _writer.threshold(self.component):
                _writer.emit(self.component, level, event, fields, message, self._context)
        except Exception:  # noqa: BLE001 - logging must never raise into the caller.
            _writer.internal_errors += 1

    def trace(self, event: str, fields: dict[str, Any] | None = None, message: str = "") -> None:
        self._log("trace", event, fields, message)

    def debug(self, event: str, fields: dict[str, Any] | None = None, message: str = "") -> None:
        self._log("debug", event, fields, message)

    def info(self, event: str, fields: dict[str, Any] | None = None, message: str = "") -> None:
        self._log("info", event, fields, message)

    def warn(self, event: str, fields: dict[str, Any] | None = None, message: str = "") -> None:
        self._log("warn", event, fields, message)

    warning = warn

    def error(self, event: str, fields: dict[str, Any] | None = None, message: str = "") -> None:
        self._log("error", event, fields, message)

    def time(
        self, event: str, fields: dict[str, Any] | None = None
    ) -> Callable[[dict[str, Any] | None], int]:
        """Starts a timer; calling the result logs `event` with durationMs and returns it."""
        started = time.perf_counter()

        def stop(extra: dict[str, Any] | None = None) -> int:
            duration_ms = round((time.perf_counter() - started) * 1000)
            merged = {**(fields or {}), **(extra or {}), "durationMs": duration_ms}
            if extra and extra.get("error") is not None:
                self.error(event, merged)
            else:
                self.info(event, merged)
            return duration_ms

        return stop

    def child(self, context: dict[str, Any] | None = None, **extra: Any) -> AppLogger:
        """A logger with extra context fields, e.g. log.child(jobId=job_id)."""
        clean, _ = sanitize_fields({**(context or {}), **extra})
        return AppLogger(self.component, {**(self._context or {}), **clean})


def get_logger(component: str, context: dict[str, Any] | None = None) -> AppLogger:
    """Returns a logger for a component from LOG_COMPONENTS (e.g. 'image', 'world')."""
    clean, _ = sanitize_fields(context) if context else ({}, [])
    return AppLogger(component, clean or None)


def new_trace_id() -> str:
    return secrets.token_hex(8)


def set_trace_id(trace_id: str | None) -> None:
    """Attaches a trace id to records logged by the current thread (None clears it)."""
    valid = isinstance(trace_id, str) and bool(TRACE_ID_PATTERN.match(trace_id))
    _writer.local.trace_id = trace_id if valid else None


def flush() -> None:
    """Writes buffered records now (also runs automatically every 250 ms and at exit)."""
    _writer.flush(force=True)


def read_memory_records() -> list[dict[str, Any]]:
    """Records kept by the 'memory' sink, used under unittest without FORGE_RUNTIME_DIR."""
    _writer.flush(force=True)
    return list(_writer.memory)


def configure(
    *, process_name: str | None = None, sink: str | None = None, runtime_dir: str | None = None
) -> None:
    """Optional process configuration; call before the first record."""
    global _writer
    with _writer.lock:
        if runtime_dir:
            os.environ["FORGE_RUNTIME_DIR"] = runtime_dir
            _writer.flush(force=True)
            _writer.stop_event.set()
            _writer = _Writer()
        if process_name:
            _writer.process_name = process_name[:40]
            _writer.file_path = None
        if sink in ("off", "memory", "spool"):
            _writer.mode = sink
        _writer.next_level_refresh = 0.0


_STDLIB_LEVELS = (
    (logging.ERROR, "error"),
    (logging.WARNING, "warn"),
    (logging.INFO, "info"),
    (logging.DEBUG, "debug"),
)


class AppLogHandler(logging.Handler):
    """Routes stdlib logging records into the Forge log as `<component>.log.<level>` events."""

    def __init__(self, component: str) -> None:
        super().__init__(level=logging.DEBUG)
        self._logger = get_logger(component)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = next(
                (name for number, name in _STDLIB_LEVELS if record.levelno >= number), "trace"
            )
            # With %-arguments only the template is kept: argument values may hold prompts.
            template = str(record.msg) if record.args else record.getMessage()
            fields: dict[str, Any] = {}
            if record.exc_info and record.exc_info[1] is not None:
                fields["error"] = record.exc_info[1]
            self._logger._log(level, f"{self._logger.component}.log.{level}", fields, template)
        except Exception:  # noqa: BLE001 - logging must never raise into the caller.
            _writer.internal_errors += 1


def install_logging_handler(component: str, logger: logging.Logger | None = None) -> AppLogHandler:
    """Adds an AppLogHandler to `logger` (default: the root logger) once and returns it."""
    target = logger if logger is not None else logging.getLogger()
    for handler in target.handlers:
        if isinstance(handler, AppLogHandler):
            return handler
    handler = AppLogHandler(component)
    target.addHandler(handler)
    return handler


def install_excepthook(component: str) -> None:
    """Logs uncaught exceptions (main and other threads) with a redacted summary, then flushes."""
    log = get_logger(component)
    previous = sys.excepthook
    previous_thread_hook = threading.excepthook

    def hook(kind: type[BaseException], value: BaseException, tb: Any) -> None:
        log.error("process.exception.uncaught", {"error": value, "reason": "uncaughtException"})
        flush()
        previous(kind, value, tb)

    def thread_hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_value is not None:
            log.error("thread.exception.uncaught", {"error": args.exc_value})
            flush()
        previous_thread_hook(args)

    sys.excepthook = hook
    threading.excepthook = thread_hook
