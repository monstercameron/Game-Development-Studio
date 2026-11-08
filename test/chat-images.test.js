import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chatService } from '../runtime/chat-service.js';
import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
} from '../runtime/chat-image-limits.js';
import { buildImageMessages, checkChatImage, sniffChatImage } from '../runtime/chat-images.js';
import { chatsForStorage, normalizeSavedChats } from '../src/chat-project.js';
import { fitWithin, imageInputBlock, sniffImageType } from '../src/chat-images.js';
import { engineDefinitions, engineStartArgs } from '../runtime/engines.js';
import { estimateChatMemory } from '../runtime/chat-memory.js';
import { planChatLoad } from '../runtime/chat-load-plan.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBytes = Buffer.from(PNG_BASE64, 'base64');
const pngUrl = `data:image/png;base64,${PNG_BASE64}`;
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const webpBytes = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
]);
const dataUrl = (bytes, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`;

test('image type is read from the first bytes, never from a claimed type or name', () => {
  assert.equal(sniffChatImage(pngBytes), 'image/png');
  assert.equal(sniffChatImage(jpegBytes), 'image/jpeg');
  assert.equal(sniffChatImage(webpBytes), 'image/webp');
  assert.equal(sniffChatImage(Buffer.from('this is plain text, renamed cat.png')), null);
  assert.equal(sniffChatImage(Buffer.from('GIF89a000000000000')), null);
  assert.equal(sniffChatImage(Buffer.alloc(4)), null);
  assert.equal(sniffImageType(new Uint8Array(pngBytes)), 'image/png');
  assert.equal(sniffImageType(new Uint8Array(jpegBytes)), 'image/jpeg');
  assert.equal(sniffImageType(new Uint8Array(webpBytes)), 'image/webp');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="x"></svg>')), null);
});

test('a data URL claiming PNG but holding text is refused, and a wrong claim is corrected', () => {
  const text = dataUrl(Buffer.from('definitely not a picture at all'), 'image/png');
  assert.throws(() => checkChatImage(text), /checked by its contents/);
  assert.throws(() => checkChatImage('data:image/gif;base64,AAAA'), /PNG, JPEG or WebP/);
  assert.throws(() => checkChatImage('https://example.com/a.png'), /PNG, JPEG or WebP/);
  assert.throws(() => checkChatImage('data:image/png;base64,@@@@'), /PNG, JPEG or WebP/);
  assert.throws(() => checkChatImage(42), /not a data URL/);
  const corrected = checkChatImage(dataUrl(jpegBytes, 'image/png'));
  assert.equal(corrected.mimeType, 'image/jpeg');
  assert.ok(corrected.dataUrl.startsWith('data:image/jpeg;base64,'));
});

test('image size, count and total limits are enforced', () => {
  const big = Buffer.concat([pngBytes, Buffer.alloc(MAX_CHAT_IMAGE_BYTES)]);
  assert.throws(() => checkChatImage(dataUrl(big)), /larger than 8 MiB/);
  const justUnder = Buffer.concat([pngBytes, Buffer.alloc(MAX_CHAT_IMAGE_BYTES - pngBytes.length)]);
  assert.equal(checkChatImage(dataUrl(justUnder)).bytes, MAX_CHAT_IMAGE_BYTES);

  const five = Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => pngUrl);
  assert.throws(
    () => buildImageMessages([{ role: 'user', content: 'x', images: five }]),
    /up to 4 images/,
  );
  const sevenMiB = dataUrl(
    Buffer.concat([pngBytes, Buffer.alloc(7 * 1024 * 1024 - pngBytes.length)]),
  );
  assert.ok(MAX_CHAT_IMAGES * 7 * 1024 * 1024 > MAX_CHAT_IMAGES_TOTAL_BYTES);
  assert.throws(
    () =>
      buildImageMessages([{ role: 'user', content: 'x', images: [sevenMiB, sevenMiB, sevenMiB] }]),
    /total more than 20 MiB/,
  );
  assert.throws(
    () => buildImageMessages([{ role: 'assistant', content: 'x', images: [pngUrl] }]),
    /Only user messages/,
  );
  assert.throws(
    () => buildImageMessages([{ role: 'user', content: 'x', images: 'nope' }]),
    /must be a list/,
  );
});

test('images become OpenAI content parts and text-only messages stay plain strings', () => {
  const built = buildImageMessages([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'what is this?', images: [pngUrl, dataUrl(jpegBytes, 'image/jpeg')] },
    { role: 'assistant', content: 'a pixel', images: [] },
  ]);
  assert.equal(built.imageCount, 2);
  assert.deepEqual(built.messages[0], { role: 'system', content: 'be brief' });
  assert.deepEqual(built.messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: pngUrl } },
      { type: 'image_url', image_url: { url: dataUrl(jpegBytes, 'image/jpeg') } },
    ],
  });
  assert.deepEqual(built.messages[2], { role: 'assistant', content: 'a pixel' });
});

test('the browser shrinks pictures to fit the edge limit without enlarging', () => {
  assert.deepEqual(fitWithin(4000, 2000), { width: 1536, height: 768, scale: 0.384 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scale: 1 });
  assert.equal(fitWithin(1, 100000).width, 1);
});

test('picture input reasons are specific', () => {
  assert.match(imageInputBlock({ isLocalQwen: false, vision: null }), /local Qwen/);
  assert.match(imageInputBlock({ isLocalQwen: true, vision: null }), /Checking/);
  assert.equal(
    imageInputBlock({ isLocalQwen: true, vision: { available: true, message: 'ok' } }),
    '',
  );
  assert.equal(
    imageInputBlock({
      isLocalQwen: true,
      vision: { available: false, message: 'Vision files missing' },
    }),
    'Vision files missing',
  );
});

test('saved history keeps thumbnails and references but never picture data', () => {
  const huge = `data:image/png;base64,${'A'.repeat(200000)}`;
  const chats = [
    {
      id: 'c',
      messages: [
        {
          role: 'user',
          content: 'look',
          images: [
            {
              name: 'apple.png',
              thumb: 'data:image/jpeg;base64,/9j/AAAA',
              dataUrl: pngUrl,
              source: { projectId: 'p', path: 'images/apple.png' },
            },
            { name: 'big.png', thumb: huge, dataUrl: huge },
          ],
        },
        { role: 'assistant', content: 'an apple' },
      ],
    },
  ];
  const stored = JSON.stringify(chatsForStorage(chats));
  assert.ok(!stored.includes('dataUrl'));
  assert.ok(!stored.includes('AAAAAAAAAA'));
  assert.ok(!stored.includes('data:image/png'));
  const restored = normalizeSavedChats(JSON.parse(stored));
  assert.deepEqual(restored[0].messages[0].images[0], {
    name: 'apple.png',
    thumb: 'data:image/jpeg;base64,/9j/AAAA',
    source: { projectId: 'p', path: 'images/apple.png' },
  });
  assert.equal(restored[0].messages[0].images[1].thumb, '');
  assert.equal(restored[0].messages[1].images, undefined);
});

test('the Qwen server gets the projector only when its file exists', () => {
  const chat = engineDefinitions.find((definition) => definition.id === 'chat');
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  const withProjector = engineStartArgs(chat, {
    contextSize: 4096,
    projectorPath: fileURLToPath(import.meta.url),
  });
  assert.equal(value(withProjector, '--mmproj'), fileURLToPath(import.meta.url));
  assert.equal(value(withProjector, '--image-max-tokens'), '1024');
  assert.equal(
    value(
      engineStartArgs(chat, { contextSize: 32768, projectorPath: fileURLToPath(import.meta.url) }),
      '--image-max-tokens',
    ),
    '2048',
  );
  const without = engineStartArgs(chat, { projectorPath: 'C:/definitely/missing/mmproj.gguf' });
  assert.ok(!without.includes('--mmproj'));
  assert.ok(!without.includes('--image-max-tokens'));
  assert.ok(!chat.args.includes('--mmproj'), 'the base definition stays text-only');
});

test('the projector adds its size to the GPU estimate and the admission budget', async () => {
  const base = estimateChatMemory(4096);
  const vision = estimateChatMemory(4096, { projectorMiB: 950 });
  assert.equal(vision.estimatedGpuMiB - base.estimatedGpuMiB, 950);
  assert.equal(vision.gpuBudgetMiB - base.gpuBudgetMiB, 950);
  const gpu = async () => ({ devices: [{ index: 0, freeMiB: base.gpuBudgetMiB + 2048 + 500 }] });
  const services = async () => [];
  const plain = await planChatLoad({ hardware: gpu, services, contextSize: 4096 });
  const withProjector = await planChatLoad({
    hardware: gpu,
    services,
    contextSize: 4096,
    projectorMiB: 950,
  });
  assert.equal(plain.code, 'ready');
  assert.equal(withProjector.code, 'insufficient_gpu_memory');
});

// A fake llama.cpp server behind the chat proxy. It records every completion payload.
async function visionHarness(t, { vision = true, projector = true, reachable = true } = {}) {
  const sent = [];
  const state = { vision, reachable };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (!state.reachable) {
      throw Object.assign(TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (path === '/props') {
      return Response.json({ modalities: { vision: state.vision, audio: false } });
    }
    sent.push({ path, body: JSON.parse(init.body) });
    return new Response(
      'data: {"choices":[{"delta":{"content":"an apple"}}]}\n\ndata: [DONE]\n\n',
      {
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  };
  const app = express();
  chatService({ fetchImpl, projectorExists: () => projector }).configureServer({
    middlewares: app,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) =>
    fetch(`${origin}/api/chat/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forge-Request': 'chat' },
      body: JSON.stringify(body),
    });
  return { sent, post, origin, app };
}

const localRequest = {
  provider: 'compatible',
  endpoint: 'http://127.0.0.1:8098/v1',
  model: 'qwen3.8-27b',
};

test('a local request with images reaches llama.cpp as image_url parts', async (t) => {
  const h = await visionHarness(t);
  const response = await h.post('completions', {
    ...localRequest,
    messages: [
      { role: 'user', content: 'first turn', images: undefined },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'what object is this?', images: [pngUrl, pngUrl] },
    ],
  });
  assert.equal(response.status, 200);
  await response.text();
  const messages = h.sent[0].body.messages;
  assert.equal(messages[0].content, 'first turn');
  assert.equal(messages[2].content[0].text, 'what object is this?');
  assert.deepEqual(
    messages[2].content.slice(1).map((part) => [part.type, part.image_url.url]),
    [
      ['image_url', pngUrl],
      ['image_url', pngUrl],
    ],
  );
  assert.ok(!('images' in messages[2]));
});

test('pictures are refused for OpenAI and for other compatible servers, nothing is sent', async (t) => {
  const h = await visionHarness(t);
  const message = { role: 'user', content: 'hi', images: [pngUrl] };
  const openai = await h.post('completions', {
    provider: 'openai',
    apiKey: 'test-key-not-real',
    model: 'gpt-test',
    messages: [message],
  });
  assert.equal(openai.status, 400);
  assert.equal((await openai.json()).code, 'vision_unsupported_provider');
  const other = await h.post('completions', {
    provider: 'compatible',
    endpoint: 'http://127.0.0.1:1234/v1',
    model: 'other',
    messages: [message],
  });
  assert.equal(other.status, 400);
  assert.equal(h.sent.length, 0);
});

test('a server started without the projector refuses pictures with a clear reason', async (t) => {
  const h = await visionHarness(t, { vision: false });
  const response = await h.post('completions', {
    ...localRequest,
    messages: [{ role: 'user', content: 'what is this?', images: [pngUrl] }],
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'vision_unavailable');
  assert.match(body.error, /without the vision projector/);
  assert.equal(h.sent.length, 0);
  // Text-only chat still works on the same server.
  const text = await h.post('completions', {
    ...localRequest,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(text.status, 200);
  await text.text();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].body.messages[0].content, 'hello');
});

test('invalid pictures are refused at the boundary before any upstream request', async (t) => {
  const h = await visionHarness(t);
  const refuse = async (images, pattern) => {
    const response = await h.post('completions', {
      ...localRequest,
      messages: [{ role: 'user', content: 'x', images }],
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'invalid_image');
    assert.match(body.error, pattern);
  };
  await refuse([dataUrl(Buffer.from('text renamed to cat.png, not a picture'))], /contents/);
  await refuse(['file:///C:/secret.png'], /data URL/);
  await refuse(Array(5).fill(pngUrl), /up to 4/);
  await refuse([dataUrl(Buffer.concat([pngBytes, Buffer.alloc(MAX_CHAT_IMAGE_BYTES)]))], /8 MiB/);
  assert.equal(h.sent.length, 0);
});

test('a request body larger than the image ceiling is rejected, text bodies keep the old cap', async (t) => {
  const h = await visionHarness(t);
  const huge = await h.post('completions', {
    ...localRequest,
    messages: [
      { role: 'user', content: 'x', images: [`data:image/png;base64,${'A'.repeat(40_000_000)}`] },
    ],
  });
  assert.equal(huge.status, 413);
  const longText = await h.post('completions', {
    ...localRequest,
    messages: [
      { role: 'user', content: 'a'.repeat(100000) },
      ...Array.from({ length: 10 }, () => ({ role: 'user', content: 'b'.repeat(100000) })),
    ],
  });
  assert.equal(longText.status, 413);
  assert.equal(h.sent.length, 0);
});

test('the vision route reports the running server, never the files on disk, first', async (t) => {
  const running = await visionHarness(t, { vision: true, projector: false });
  assert.deepEqual((await (await running.post('vision', localRequest)).json()).state, 'ready');
  const noVision = await visionHarness(t, { vision: false, projector: true });
  const missing = await (await noVision.post('vision', localRequest)).json();
  assert.equal(missing.available, false);
  assert.equal(missing.state, 'server_without_vision');
  const stopped = await visionHarness(t, { reachable: false, projector: true });
  const willStart = await (await stopped.post('vision', localRequest)).json();
  assert.equal(willStart.available, true);
  assert.equal(willStart.state, 'starts_with_vision');
  const noFile = await visionHarness(t, { reachable: false, projector: false });
  const files = await (await noFile.post('vision', localRequest)).json();
  assert.equal(files.available, false);
  assert.equal(files.state, 'files_missing');
  assert.match(files.message, /Vision files missing/);
  const openai = await (await running.post('vision', { provider: 'openai' })).json();
  assert.equal(openai.state, 'unsupported_connection');
  assert.equal(openai.available, false);
});

test('a stopped server with pictures asks the client to start it instead of failing the check', async (t) => {
  const h = await visionHarness(t, { reachable: false, projector: true });
  const response = await h.post('completions', {
    ...localRequest,
    messages: [{ role: 'user', content: 'x', images: [pngUrl] }],
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'server_unreachable');
});

test('forge_chat attaches project images to the last user message and the proxy sends them', async (t) => {
  const projectId = randomUUID();
  const h = await visionHarness(t);
  const assetPaths = [];
  h.app.get(`/api/projects/${projectId}/asset`, (req, res) => {
    assetPaths.push(req.query.path);
    if (req.query.path === 'text/notes.txt') {
      res.type('text/plain').send('not an image');
      return;
    }
    if (req.query.path === 'images/fake.png') {
      res.type('image/png').send(Buffer.from('this is text pretending to be a png'));
      return;
    }
    res.type('image/png').send(pngBytes);
  });
  const client = new Client(
    { name: 'chat-images-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: { ...process.env, FORGE_STUDIO_URL: h.origin },
      stderr: 'pipe',
    }),
  );
  const call = (args) => client.callTool({ name: 'forge_chat', arguments: args });
  const base = {
    model: 'qwen3.8-27b',
    messages: [{ role: 'user', content: 'what object is this?' }],
    projectId,
  };
  const ok = await call({ ...base, images: ['images/apple.png'] });
  assert.notEqual(ok.isError, true);
  assert.equal(JSON.parse(ok.content[0].text).text, 'an apple');
  const sentMessage = h.sent[0].body.messages[0];
  assert.equal(sentMessage.content[1].image_url.url, pngUrl);
  assert.deepEqual(assetPaths, ['images/apple.png']);

  const notImage = await call({ ...base, images: ['text/notes.txt'] });
  assert.equal(notImage.isError, true);
  assert.match(notImage.content[0].text, /not a PNG, JPEG or WebP/);
  const fake = await call({ ...base, images: ['images/fake.png'] });
  assert.equal(fake.isError, true);
  assert.match(fake.content[0].text, /contents/);
  const noProject = await call({ model: base.model, messages: base.messages, images: ['a.png'] });
  assert.equal(noProject.isError, true);
  assert.match(noProject.content[0].text, /projectId is required/);
  const tooMany = await call({ ...base, images: Array(5).fill('images/apple.png') });
  assert.equal(tooMany.isError, true);
  assert.equal(h.sent.length, 1, 'refused calls never reach the model server');
});
