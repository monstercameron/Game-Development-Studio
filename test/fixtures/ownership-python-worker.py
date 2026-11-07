"""Small isolated Python venv listener used by ownership integration tests."""
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

config=json.loads(sys.stdin.readline())
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_args): pass
    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('X-Forge-Engine-Token',''),config['token']):
            self.send_response(403);self.end_headers();return
        if self.path=='/api/forge/identity':
            data=json.dumps({'engine':config['id'],'nonce':config['nonce'],'pid':os.getpid()}).encode()
            self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        elif self.path=='/shutdown':
            self.send_response(200);self.end_headers();threading.Thread(target=self.server.shutdown,daemon=True).start()
        else:
            self.send_response(404);self.end_headers()
server=HTTPServer(('127.0.0.1',config['port']),Handler)
print('ready',flush=True)
server.serve_forever()
server.server_close()
