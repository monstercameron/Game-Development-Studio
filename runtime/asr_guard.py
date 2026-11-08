"""Guard an isolated Nemotron server and its HTTP/WebSocket sessions.

Only the proxy is exposed at the configured port. On Windows the native
server is placed in a kill-on-close job so a guard crash cannot orphan it.
"""

import argparse
import asyncio
import ctypes
import hmac
import json
import os
import subprocess
import sys
from pathlib import Path

from app_log import get_logger, install_excepthook
from engine_identity import identity

# Read once at import. An empty token refuses every /api/forge/ request and makes run() fail,
# so a guard started without the Forge-issued secret never accepts control traffic.
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
# Header and request-line cap in bytes, enforced before any route is parsed.
MAX_HEADER = 32768
log = get_logger("asr")


class WindowsJob:
    """Own a child process with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE."""

    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("The guarded speech runtime currently requires Windows.")
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in (
                    "read_ops",
                    "write_ops",
                    "other_ops",
                    "read_bytes",
                    "write_bytes",
                    "other_bytes",
                )
            ]

        class BASIC_LIMIT(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong),
                ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD),
                ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t),
                ("active_process_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority_class", wintypes.DWORD),
                ("scheduling_class", wintypes.DWORD),
            ]

        class EXTENDED_LIMIT(ctypes.Structure):
            _fields_ = [
                ("basic", BASIC_LIMIT),
                ("io", IO_COUNTERS),
                ("process_memory_limit", ctypes.c_size_t),
                ("job_memory_limit", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        info = EXTENDED_LIMIT()
        # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000) under JobObjectExtendedLimitInformation (9),
        # so the native engine dies with this guard even if the guard crashes.
        info.basic.flags = 0x00002000
        if not self.kernel.SetInformationJobObject(
            self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)
        ):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)

    def add(self, process):
        if not self.kernel.AssignProcessToJobObject(
            self.handle, ctypes.c_void_p(int(process._handle))
        ):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class Guard:
    """Proxy client connections to the native engine on an internal loopback port.

    `active` tracks connections that may hold a speech session; `/api/forge/stop` is refused
    while it is non-empty. Setting `stop_event` lets run() shut the guard down.
    """

    def __init__(self, native_port, stop_event):
        self.native_port = native_port
        self.stop_event = stop_event
        self.active = set()
        self.closing = False
        self.stop_handle = None

    async def reply(self, writer, status, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
            + data
        )
        await writer.drain()

    async def handle(self, reader, writer):
        target_writer = None
        tracked = False
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            if len(header) > MAX_HEADER:
                raise ValueError("Header too large")
            lines = header[:-4].split(b"\r\n")
            request = lines[0].decode("ascii", "strict").split(" ")
            if len(request) != 3:
                raise ValueError("Invalid HTTP request")
            headers = []
            for line in lines[1:]:
                name, value = line.split(b":", 1)
                headers.append((name.strip().lower(), value.strip()))
            if request[1].startswith("/api/forge/"):
                supplied = next(
                    (
                        value.decode("ascii", "ignore")
                        for name, value in headers
                        if name == b"x-forge-engine-token"
                    ),
                    "",
                )
                if not TOKEN or not hmac.compare_digest(TOKEN, supplied):
                    log.warn(
                        "asr.request.rejected",
                        {"route": "/api/forge/:action", "reason": "forbidden"},
                    )
                    return await self.reply(writer, "403 Forbidden", {"error": "Forbidden."})
                if request[0] == "GET" and request[1] == "/api/forge/identity":
                    try:
                        return await self.reply(writer, "200 OK", identity(TOKEN, supplied, "asr"))
                    except LookupError as error:
                        log.warn("asr.identity.unavailable", {"errorClass": type(error).__name__})
                        return await self.reply(
                            writer, "404 Not Found", {"error": "Recovery identity is unavailable."}
                        )
                if request[0] == "GET" and request[1] == "/api/forge/status":
                    return await self.reply(
                        writer,
                        "200 OK",
                        {
                            "engine": "forge-asr-guard-v1",
                            "active": len(self.active),
                            "closing": self.closing,
                        },
                    )
                if request[0] != "POST":
                    log.warn(
                        "asr.request.rejected",
                        {"route": "/api/forge/:action", "reason": "method_not_allowed"},
                    )
                    return await self.reply(
                        writer, "405 Method Not Allowed", {"error": "Use POST."}
                    )
                if request[1] == "/api/forge/resume":
                    if self.stop_handle:
                        self.stop_handle.cancel()
                        self.stop_handle = None
                    self.closing = False
                    log.info("asr.stop.cancelled")
                    return await self.reply(writer, "200 OK", {"resumed": True})
                if request[1] != "/api/forge/stop":
                    log.warn(
                        "asr.request.rejected",
                        {"route": "/api/forge/:action", "reason": "unknown_action"},
                    )
                    return await self.reply(writer, "404 Not Found", {"error": "Not found."})
                self.closing = True
                if self.active:
                    self.closing = False
                    log.warn(
                        "asr.stop.rejected",
                        {"reason": "sessions_active", "activeCount": len(self.active)},
                    )
                    return await self.reply(
                        writer, "409 Conflict", {"error": "Speech sessions are still connected."}
                    )
                log.info("asr.stop.requested")
                if self.stop_handle is None:
                    self.stop_handle = asyncio.get_running_loop().call_later(1, self.stop_event.set)
                return await self.reply(writer, "200 OK", {"stopping": True})
            if self.closing:
                log.warn("asr.request.rejected", {"reason": "closing"})
                return await self.reply(
                    writer, "503 Service Unavailable", {"error": "Speech service is stopping."}
                )
            # Mark work active before opening the backend, so stop cannot race a new session.
            tracked = not (
                request[0] == "GET"
                and request[1] in ("/v1/models", "/health", "/ready", "/version")
            )
            if tracked:
                self.active.add(writer)
            target_reader, target_writer = await asyncio.open_connection(
                "127.0.0.1", self.native_port
            )
            websocket = any(
                name == b"upgrade" and value.lower() == b"websocket" for name, value in headers
            )
            log.debug(
                "asr.session.opened",
                {
                    "method": request[0],
                    "isWebsocket": websocket,
                    "activeCount": len(self.active),
                },
            )
            if not websocket:
                # Keep-alive sockets otherwise look active long after a request ends.
                headers = [(name, value) for name, value in headers if name != b"connection"]
                headers.append((b"connection", b"close"))
                header = (
                    lines[0]
                    + b"\r\n"
                    + b"".join(name + b": " + value + b"\r\n" for name, value in headers)
                    + b"\r\n"
                )
            target_writer.write(header)
            await target_writer.drain()

            async def pipe(source, destination):
                try:
                    while data := await source.read(65536):
                        destination.write(data)
                        await destination.drain()
                except (ConnectionError, OSError) as error:
                    log.debug("asr.stream.failed", {"errorClass": type(error).__name__})
                finally:
                    try:
                        destination.close()
                    except OSError as error:
                        log.debug("asr.stream.cleanup.failed", {"errorClass": type(error).__name__})

            first = asyncio.create_task(pipe(reader, target_writer))
            second = asyncio.create_task(pipe(target_reader, writer))
            await asyncio.wait([first, second], return_when=asyncio.FIRST_COMPLETED)
            for task in (first, second):
                if not task.done():
                    task.cancel()
            await asyncio.gather(first, second, return_exceptions=True)
        except (
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
            asyncio.TimeoutError,
            ValueError,
            UnicodeError,
            OSError,
        ) as error:
            log.warn("asr.request.failed", {"errorClass": type(error).__name__})
            if not writer.is_closing():
                try:
                    await self.reply(
                        writer, "503 Service Unavailable", {"error": "Speech service unavailable."}
                    )
                except (ConnectionError, OSError) as reply_error:
                    log.debug("asr.reply.failed", {"errorClass": type(reply_error).__name__})
        finally:
            if tracked:
                self.active.discard(writer)
                log.debug("asr.session.closed", {"activeCount": len(self.active)})
            if target_writer:
                target_writer.close()
            writer.close()


# Cache-aware streaming right context R gives a chunk of (R + 1) x 80 ms: 0, 1, 6 and 13 are
# the 80, 160, 560 and 1120 ms modes of the Nemotron streaming model. Omitted keeps the engine
# default (1).
RIGHT_CONTEXTS = (0, 1, 6, 13)


def native_command(args, port):
    """Return the argv that starts the native engine on the internal loopback `port`.

    `args.right_context` is appended only when set, so the engine default applies otherwise.
    """
    command = [
        str(args.native),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--asr-model",
        str(args.model),
        "--device",
        "cuda:0",
        "--no-ui",
    ]
    if args.right_context is not None:
        command += ["--asr.streaming.rnnt_right_context", str(args.right_context)]
    return command


async def run(args):
    """Serve the guard on `args.port` until a stop request or engine exit.

    Raises RuntimeError when the control token is missing or the engine exits unexpectedly.
    The native process is always reaped and the Windows job is closed on the way out.
    """
    if not TOKEN:
        raise RuntimeError("A Forge control token is required.")
    log.info("asr.process.started", {"pid": os.getpid(), "port": args.port})
    job = WindowsJob()
    process = None
    server = None
    try:
        # Reserve and release an internal loopback port immediately before spawn.
        probe = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
        port = probe.sockets[0].getsockname()[1]
        probe.close()
        await probe.wait_closed()
        stop = asyncio.Event()
        guard = Guard(port, stop)
        server = await asyncio.start_server(
            guard.handle, "127.0.0.1", args.port, limit=MAX_HEADER + 1
        )
        process = subprocess.Popen(
            native_command(args, port),
            cwd=str(args.cwd),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            job.add(process)
        except Exception:
            process.terminate()
            process.wait(timeout=10)
            raise
        print(
            f"Speech guard PID {os.getpid()} started CUDA engine PID {process.pid} on an internal port.",
            flush=True,
        )
        log.info("asr.process.spawned", {"kind": "native_engine", "pid": process.pid})

        async def monitor():
            while process.poll() is None and not stop.is_set():
                await asyncio.sleep(0.25)
            stop.set()

        monitor_task = asyncio.create_task(monitor())
        await stop.wait()
        monitor_task.cancel()
        await asyncio.gather(monitor_task, return_exceptions=True)
        if process.poll() is not None and not guard.closing:
            raise RuntimeError(f"Speech engine exited with code {process.returncode}.")
    finally:
        if server:
            server.close()
            await server.wait_closed()
        job.close()
        if process and process.poll() is None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                log.warn(
                    "asr.process.kill.forced",
                    {
                        "kind": "native_engine",
                        "pid": process.pid,
                        "errorClass": type(error).__name__,
                    },
                )
                process.kill()
                process.wait(timeout=10)
        if process:
            log.info(
                "asr.process.exited",
                {"kind": "native_engine", "pid": process.pid, "exitCode": process.returncode},
            )
        log.info("asr.process.stopped", {"pid": os.getpid()})


if __name__ == "__main__":
    install_excepthook("asr")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--right-context", type=int, choices=RIGHT_CONTEXTS, default=None)
    try:
        asyncio.run(run(parser.parse_args()))
    except Exception as error:
        log.error("asr.process.failed", {"errorClass": type(error).__name__})
        print(f"Speech guard failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
