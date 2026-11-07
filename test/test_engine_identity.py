"""Guarded recovery identities require both an instance nonce and the token."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from engine_identity import identity, install_identity_endpoint
from fastapi import FastAPI
from fastapi.testclient import TestClient


class IdentityTest(unittest.TestCase):
    def test_identity_requires_authentication_and_a_well_formed_nonce(self):
        app=FastAPI();install_identity_endpoint(app,'test-token','3d-trellis')
        client=TestClient(app)
        with patch.dict(os.environ,{'FORGE_ENGINE_INSTANCE_NONCE':'a'*64}):
            self.assertEqual(client.get('/api/forge/identity').status_code,403)
            self.assertEqual(client.get('/api/forge/identity',headers={'X-Forge-Engine-Token':'wrong'}).status_code,403)
            result=client.get('/api/forge/identity',headers={'X-Forge-Engine-Token':'test-token'})
            self.assertEqual(result.status_code,200)
            self.assertEqual(result.json(),{'engine':'3d-trellis','pid':os.getpid(),'nonce':'a'*64})
        with patch.dict(os.environ,{'FORGE_ENGINE_INSTANCE_NONCE':'not-a-nonce'}):
            self.assertEqual(client.get('/api/forge/identity',headers={'X-Forge-Engine-Token':'test-token'}).status_code,404)
        with self.assertRaises(PermissionError):identity('', '', 'tts')
        with self.assertRaises(PermissionError):identity('test-token', 'nön-ascii', 'tts')


if __name__=='__main__':unittest.main()
