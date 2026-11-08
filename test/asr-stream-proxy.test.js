import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { attachAsrStreamProxy } from '../runtime/asr-stream-proxy.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function request(port, origin, route = '/api/asr/realtime') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(Error('Request timed out')));
    socket.on('connect', () =>
      socket.write(
        `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      ),
    );
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', reject);
  });
}

test('stream proxy restricts origin and forwards only its fixed route', async (t) => {
  let requests = 0;
  let received = '';
  const backend = net.createServer((socket) => {
    requests++;
    socket.on('data', (chunk) => {
      received += chunk;
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
  });
  const backendPort = await listen(backend);
  const server = http.createServer();
  attachAsrStreamProxy(server, { baseUrl: `http://127.0.0.1:${backendPort}` });
  const port = await listen(server);
  t.after(() =>
    Promise.all([new Promise((r) => server.close(r)), new Promise((r) => backend.close(r))]),
  );
  assert.match(await request(port, 'http://attacker.example'), /^HTTP\/1.1 403/);
  assert.equal(requests, 0);
  assert.match(await request(port, `http://127.0.0.1:${port}`, '/other'), /^HTTP\/1.1 404/);
  assert.equal(requests, 0);
  assert.match(await request(port, `http://127.0.0.1:${port}`), /^HTTP\/1.1 101/);
  assert.equal(requests, 1);
  assert.match(received, /^GET \/v1\/audio\/transcriptions\/realtime HTTP\/1.1/);
});
