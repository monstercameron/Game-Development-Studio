"""The image guard exposes recovery identity only to its supervisor."""

import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from qwen_worker import GuardedApp


async def request(app, token):
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "path": "/api/forge/identity",
            "method": "GET",
            "headers": [(b"x-forge-engine-token", token.encode())],
        },
        receive,
        send,
    )
    return messages[0]["status"], json.loads(messages[1]["body"])


class ImageGuardIdentityTest(unittest.IsolatedAsyncioTestCase):
    async def test_identity_requires_token_and_nonce(self):
        guard = GuardedApp(types.SimpleNamespace(), "secret")
        with patch.dict(os.environ, {"FORGE_ENGINE_INSTANCE_NONCE": "b" * 64}):
            self.assertEqual((await request(guard, "wrong"))[0], 403)
            status, body = await request(guard, "secret")
            self.assertEqual(status, 200)
            self.assertEqual(body, {"engine": "images", "pid": os.getpid(), "nonce": "b" * 64})
        with patch.dict(os.environ, {"FORGE_ENGINE_INSTANCE_NONCE": "invalid"}):
            self.assertEqual((await request(guard, "secret"))[0], 404)


if __name__ == "__main__":
    unittest.main()
