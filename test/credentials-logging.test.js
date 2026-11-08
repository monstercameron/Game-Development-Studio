import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  clearMemoryLogRecords,
  configureAppLog,
  readMemoryLogRecords,
  resetAppLogForTests,
} from '../runtime/app-log.js';
import { createCredentialStore } from '../runtime/credentials.js';
import { credentialService } from '../runtime/credential-service.js';
import { findSharedHuggingFaceToken } from '../runtime/sound-credentials.js';

// Not shaped like any key pattern, so the log redaction rules cannot hide a leak by accident.
const fakeSecret = 'zk_NoPatternFixtureSecret_4f9a1c7e22';
const fakeCiphertext = Buffer.from(fakeSecret).toString('base64');
const fakeNotesToken = 'hf_FixtureNotesToken0123456789abcdef';

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('credential logging records events and reasons but never a secret', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-credentials-log-test-'));
  t.after(async () => {
    resetAppLogForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });
  configureAppLog({ sink: 'memory', levelProvider: () => 'debug' });
  clearMemoryLogRecords();

  let failNextProtect = false;
  const store = createCredentialStore({
    directory: path.join(dir, 'credentials'),
    protect: async (value) => {
      if (failNextProtect) {
        // A real crypto layer could echo its input in a message; the log must not.
        throw Error(`protect failed for ${value}`);
      }
      return Buffer.from(value).toString('base64');
    },
    unprotect: async (value) => Buffer.from(value, 'base64').toString('utf8'),
  });
  const app = express();
  credentialService({ store }).configureServer({ middlewares: app });
  const server = await listen(app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(`${origin}/api/credentials/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forge-Request': 'credentials',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  // Success paths: save, replace, read for use, remove.
  assert.equal((await post('save', { provider: 'openai', secret: fakeSecret })).status, 200);
  assert.equal((await post('save', { provider: 'openai', secret: `${fakeSecret}2` })).status, 200);
  assert.equal(await store.get('openai'), `${fakeSecret}2`);
  assert.equal((await post('remove', { provider: 'openai' })).status, 200);

  // Rejection paths carry the secret in the request body, the header or the Origin.
  const badOrigin = await post(
    'save',
    { provider: 'openai', secret: fakeSecret },
    { Origin: `http://evil.example/${fakeSecret}` },
  );
  assert.equal(badOrigin.status, 403);
  const badHeader = await post(
    'save',
    { provider: 'openai', secret: fakeSecret },
    { 'X-Forge-Request': fakeSecret },
  );
  assert.equal(badHeader.status, 403);
  const tooLarge = await post('save', {
    provider: 'openai',
    secret: fakeSecret,
    padding: 'x'.repeat(10100),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(
    (await post('save', { provider: `other-${fakeSecret}`, secret: fakeSecret })).status,
    400,
  );
  assert.equal(
    (await post('save', { provider: 'openai', secret: `bad ${fakeSecret}` })).status,
    400,
  );
  assert.equal((await post('remove', { provider: `other-${fakeSecret}` })).status, 400);
  // V8's JSON.parse message quotes part of the body.
  assert.equal((await post('save', `{"provider":"openai","secret":"${fakeSecret}`)).status, 400);

  // Failure path: the store throws an error whose message contains the secret.
  failNextProtect = true;
  assert.equal((await post('save', { provider: 'openai', secret: fakeSecret })).status, 500);
  failNextProtect = false;
  await assert.rejects(store.set('other', fakeSecret), /provider/i);

  // The shared-notes scan reads a file that holds a token and a folder that does not exist.
  const notes = path.join(dir, 'shared');
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, 'Api Keys.md'), `huggingface: ${fakeNotesToken}\n`);
  assert.equal(await findSharedHuggingFaceToken(notes), fakeNotesToken);
  assert.equal(await findSharedHuggingFaceToken(path.join(dir, 'missing')), '');

  const records = readMemoryLogRecords();
  const text = JSON.stringify(records);
  for (const needle of [fakeSecret, fakeCiphertext, fakeNotesToken, 'evil.example', dir]) {
    assert.equal(text.includes(needle), false, `a log record contains ${needle.slice(0, 8)}...`);
  }
  assert.equal(
    records.some((record) => 'errorMessage' in record.fields),
    false,
    'credential failures must log the error class and code only',
  );

  const credentialRecords = records.filter((record) => record.component === 'credentials');
  const events = credentialRecords.map((record) => record.event);
  for (const event of [
    'credentials.key.saved',
    'credentials.key.read',
    'credentials.key.removed',
    'credentials.request.rejected',
    'credentials.request.failed',
    'credentials.shared_token.scan.failed',
  ]) {
    assert.ok(events.includes(event), `missing ${event}`);
  }
  const reasons = new Set(
    credentialRecords
      .filter((record) => record.event === 'credentials.request.rejected')
      .map((record) => record.fields.reason),
  );
  for (const reason of [
    'bad_origin',
    'bad_header',
    'too_large',
    'unknown_provider',
    'invalid_secret',
    'bad_request',
  ]) {
    assert.ok(reasons.has(reason), `missing rejection reason ${reason}`);
  }
  assert.equal(
    credentialRecords.find((record) => record.event === 'credentials.request.failed').fields
      .errorClass,
    'Error',
  );
});
