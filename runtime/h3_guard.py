"""Supervise H3 and its render subprocesses behind a loopback proxy.

The Windows job contains the Node server and any renderer it starts. A guard
crash closes the job and terminates the entire owned process tree. Standalone
H3 Studio is never attached to this job or modified.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from asr_guard import WindowsJob

MAX_HEADER = 32768


class VideoProxy:
    def __init__(self, private_port):
        self.private_port = private_port

    async def reply(self, writer, status, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
            + data
        )
        await writer.drain()

    async def handle(self, reader, writer):
        target = None
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
                except (ConnectionError, OSError):
                    pass
                finally:
                    try:
                        destination.close()
                    except OSError:
                        pass

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
        ):
            if not writer.is_closing():
                try:
                    await self.reply(
                        writer, "503 Service Unavailable", {"error": "Video service unavailable."}
                    )
                except (ConnectionError, OSError):
                    pass
        finally:
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
        env = {**os.environ, "FORGE_H3_INTERNAL_PORT": str(private_port)}
        process = subprocess.Popen(
            [str(args.node), str(args.bootstrap), str(args.engine_dir)],
            cwd=str(args.engine_dir),
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            job.add(process)
        except Exception:
            process.terminate()
            process.wait(timeout=10)
            raise
        proxy = VideoProxy(private_port)
        server = await asyncio.start_server(
            proxy.handle, "127.0.0.1", args.port, limit=MAX_HEADER + 1
        )
        print(
            f"H3 guard PID {os.getpid()} owns server PID {process.pid} on an internal port.",
            flush=True,
        )
        while process.poll() is None:
            await asyncio.sleep(0.25)
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
                process.kill()
                process.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--bootstrap", type=Path, required=True)
    parser.add_argument("--engine-dir", type=Path, required=True)
    try:
        asyncio.run(run(parser.parse_args()))
    except Exception as error:
        print(f"H3 guard failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
