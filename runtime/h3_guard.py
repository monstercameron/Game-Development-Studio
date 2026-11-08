"""Supervise H3 and its render subprocesses behind a loopback proxy.

The Windows job contains the Node server and any renderer it starts. A guard
crash closes the job and terminates the entire owned process tree. Standalone
H3 Studio is never attached to this job or modified.

Forge can also ask the guard to stop (POST /api/forge/stop with the per-start
control token). H3 has no stop operation of its own, so the guard decides: it
refuses new work, checks that nothing is in flight and that H3 reports no running
render, and only then exits, which closes the job and ends the whole tree. Because
every request to H3 passes through this proxy, the check and the refusal cannot race
a new submission. The control routes are answered here and never forwarded to H3.
"""

import argparse
import asyncio
import hmac
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import hidden_console  # noqa: F401  (hidden console for everything the guard starts)
from app_log import get_logger, install_excepthook
from asr_guard import WindowsJob
from engine_identity import identity

log = get_logger("video")

MAX_HEADER = 32768
TOKEN_VARIABLE = "FORGE_ENGINE_CONTROL_TOKEN"
# Requests that only read state and finish immediately never count as work in flight.
IDLE_READS = ("/api/status", "/api/forge-capabilities")


class VideoProxy:
    def __init__(self, private_port, stop_event, token=""):
        self.private_port = private_port
        self.stop_event = stop_event
        self.token = token
        self.active = set()
        self.closing = False
        self.stop_requested = False
        self.stop_handle = None

    def job_is_running(self):
        """True unless H3 itself reports that no render is running. Raises if it cannot say."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        url = f"http://127.0.0.1:{self.private_port}/api/status"
        with opener.open(url, timeout=3) as response:
            status = json.load(response)
        job = status.get("job")
        return isinstance(job, dict) and job.get("state") == "running"

    async def control(self, writer, method, path, headers):
        supplied = next(
            (
                value.decode("ascii", "ignore")
                for name, value in headers
                if name == b"x-forge-engine-token"
            ),
            "",
        )
        if not self.token or not hmac.compare_digest(self.token, supplied):
            log.warn("video.control.rejected", {"reason": "bad_token"})
            return await self.reply(writer, "403 Forbidden", {"error": "Forbidden."})
        if method == "GET" and path == "/api/forge/identity":
            # Lets a restarted studio prove, with the control token and the per-start nonce, that
            # this guard is the one it launched, so it can adopt it (and the render it holds)
            # instead of treating the running video engine as foreign.
            try:
                return await self.reply(writer, "200 OK", identity(self.token, supplied, "video"))
            except LookupError as error:
                log.warn("video.identity.unavailable", {"errorClass": type(error).__name__})
                return await self.reply(
                    writer, "404 Not Found", {"error": "Recovery identity is unavailable."}
                )
        if method == "GET" and path == "/api/forge/status":
            return await self.reply(
                writer,
                "200 OK",
                {
                    "engine": "forge-h3-guard-v1",
                    "active": len(self.active),
                    "closing": self.closing,
                },
            )
        if method != "POST":
            return await self.reply(writer, "405 Method Not Allowed", {"error": "Use POST."})
        if path == "/api/forge/resume":
            if self.stop_handle:
                self.stop_handle.cancel()
                self.stop_handle = None
            self.closing = False
            self.stop_requested = False
            log.info("video.resume.accepted")
            return await self.reply(writer, "200 OK", {"resumed": True})
        if path != "/api/forge/stop":
            return await self.reply(writer, "404 Not Found", {"error": "Not found."})
        # Refuse new work first, then look: nothing can slip in between the check and the exit.
        self.closing = True
        if self.active:
            self.closing = False
            log.warn(
                "video.stop.rejected",
                {"reason": "requests_in_flight", "activeCount": len(self.active)},
            )
            return await self.reply(
                writer, "409 Conflict", {"error": "The video service has requests in progress."}
            )
        try:
            running = await asyncio.to_thread(self.job_is_running)
        except Exception as error:
            self.closing = False
            log.warn(
                "video.stop.rejected",
                {"reason": "status_unknown", "errorClass": type(error).__name__},
            )
            return await self.reply(
                writer,
                "409 Conflict",
                {"error": "H3 did not report whether a video is rendering, so it was not stopped."},
            )
        log.debug("video.status.checked", {"isRendering": running})
        if running or self.active:
            self.closing = False
            log.warn("video.stop.rejected", {"reason": "rendering"})
            return await self.reply(
                writer, "409 Conflict", {"error": "A video is rendering; it was not stopped."}
            )
        if self.stop_handle is None:
            self.stop_requested = True
            self.stop_handle = asyncio.get_running_loop().call_later(1, self.stop_event.set)
            log.info("video.stop.accepted")
        return await self.reply(writer, "200 OK", {"stopping": True})

    async def reply(self, writer, status, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
            + data
        )
        await writer.drain()

    async def handle(self, reader, writer):
        target = None
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
                return await self.control(writer, request[0], request[1], headers)
            idle_read = request[0] == "GET" and request[1].split("?")[0] in IDLE_READS
            if self.closing and not idle_read:
                log.warn("video.request.rejected", {"reason": "stopping"})
                return await self.reply(
                    writer, "503 Service Unavailable", {"error": "Video service is stopping."}
                )
            # Counted before the first await, so a stop request cannot miss this request.
            tracked = not idle_read
            if tracked:
                self.active.add(writer)
            remote_reader, target = await asyncio.open_connection("127.0.0.1", self.private_port)
            headers = [(name, value) for name, value in headers if name != b"connection"]
            headers.append((b"connection", b"close"))
            target.write(
                lines[0]
                + b"\r\n"
                + b"".join(name + b": " + value + b"\r\n" for name, value in headers)
                + b"\r\n"
            )
            await target.drain()

            async def pipe(source, destination):
                try:
                    while data := await source.read(65536):
                        destination.write(data)
                        await destination.drain()
                except (ConnectionError, OSError) as error:
                    log.debug("video.request.pipe.failed", {"errorClass": type(error).__name__})
                finally:
                    try:
                        destination.close()
                    except OSError as error:
                        log.debug(
                            "video.request.close.failed", {"errorClass": type(error).__name__}
                        )

            tasks = [
                asyncio.create_task(pipe(reader, target)),
                asyncio.create_task(pipe(remote_reader, writer)),
            ]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        except (
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
            asyncio.TimeoutError,
            ValueError,
            UnicodeError,
            OSError,
        ) as error:
            log.warn(
                "video.request.failed",
                {"reason": "unavailable", "errorClass": type(error).__name__},
            )
            if not writer.is_closing():
                try:
                    await self.reply(
                        writer, "503 Service Unavailable", {"error": "Video service unavailable."}
                    )
                except (ConnectionError, OSError) as reply_error:
                    log.debug(
                        "video.request.reply.failed",
                        {"errorClass": type(reply_error).__name__},
                    )
        finally:
            if tracked:
                self.active.discard(writer)
            if target:
                target.close()
            writer.close()


async def run(args):
    job = WindowsJob()
    process = None
    server = None
    try:
        probe = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
        private_port = probe.sockets[0].getsockname()[1]
        probe.close()
        await probe.wait_closed()
        # The control token belongs to the guard; H3 and its renderer never need it.
        token = os.environ.get(TOKEN_VARIABLE, "")
        env = {key: value for key, value in os.environ.items() if key != TOKEN_VARIABLE}
        env["FORGE_H3_INTERNAL_PORT"] = str(private_port)
        process = subprocess.Popen(
            [str(args.node), str(args.bootstrap), str(args.engine_dir)],
            cwd=str(args.engine_dir),
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        log.info("video.process.spawned", {"kind": "h3-server", "pid": process.pid})
        try:
            job.add(process)
        except Exception as error:
            log.error(
                "video.job.attach.failed",
                {"errorClass": type(error).__name__},
            )
            process.terminate()
            process.wait(timeout=10)
            raise
        stop_event = asyncio.Event()
        proxy = VideoProxy(private_port, stop_event, token)
        server = await asyncio.start_server(
            proxy.handle, "127.0.0.1", args.port, limit=MAX_HEADER + 1
        )
        print(
            f"H3 guard PID {os.getpid()} owns server PID {process.pid} on an internal port.",
            flush=True,
        )
        log.info("video.guard.started", {"pid": os.getpid(), "port": args.port})
        while process.poll() is None and not stop_event.is_set():
            await asyncio.sleep(0.25)
        if proxy.stop_requested:
            print("H3 guard stopping at Forge's request.", flush=True)
            log.info("video.guard.stopping", {"reason": "stop_requested"})
            return
        log.error("video.guard.failed", {"reason": "server_exited", "exitCode": process.returncode})
        raise RuntimeError(f"H3 server exited with code {process.returncode}.")
    finally:
        if server:
            server.close()
            await server.wait_closed()
        job.close()
        if process and process.poll() is None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                log.warn("video.process.killed", {"kind": "h3-server", "pid": process.pid})
                process.kill()
                process.wait(timeout=10)
        if process:
            log.info("video.process.exited", {"kind": "h3-server", "exitCode": process.poll()})
        log.info("video.guard.stopped")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--bootstrap", type=Path, required=True)
    parser.add_argument("--engine-dir", type=Path, required=True)
    install_excepthook("video")
    try:
        asyncio.run(run(parser.parse_args()))
    except Exception as error:
        log.error("video.guard.failed", {"errorClass": type(error).__name__})
        print(f"H3 guard failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
