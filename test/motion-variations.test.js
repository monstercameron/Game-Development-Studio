import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function draftWith(values) {
  return { prompt: 'walk forward', motionDuration: '3', motionSteps: '50', ...values };
}

test('HY-Motion variations queue consecutive seeds and report partial failures', async () => {
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  });
  const previousFetch = globalThis.fetch;
  const submitted = [];
  let failAfter = Infinity;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/runtime/jobs');
    const body = JSON.parse(options.body);
    if (submitted.length >= failAfter) {
      return new Response(JSON.stringify({ error: 'Queue is full.' }), { status: 409 });
    }
    submitted.push(body);
    return new Response(JSON.stringify({ id: `job-${submitted.length}` }), { status: 202 });
  };
  try {
    const { enqueueMotion } = await vite.ssrLoadModule('/src/RuntimeQueue.jsx');
    const projectId = '11111111-1111-4111-8111-111111111111';

    await enqueueMotion(projectId, draftWith({ seed: '40', motionVariations: '3' }));
    assert.deepEqual(
      submitted.map((body) => body.request.seed),
      [40, 41, 42],
    );
    assert.ok(submitted.every((body) => body.type === 'motion' && body.projectId === projectId));
    assert.ok(submitted.every((body) => !('motionVariations' in body.request)));
    assert.ok(submitted.every((body) => body.request.steps === 50 && body.request.duration === 3));

    submitted.length = 0;
    await enqueueMotion(projectId, draftWith({ motionVariations: '2' }));
    const [first, second] = submitted.map((body) => body.request.seed);
    assert.equal(second, first + 1);
    assert.ok(first >= 0 && second <= 2147483647);

    submitted.length = 0;
    await assert.rejects(
      enqueueMotion(projectId, draftWith({ seed: '2147483647', motionVariations: '2' })),
      /seed must be at most 2147483646/,
    );
    assert.equal(submitted.length, 0);

    failAfter = 1;
    submitted.length = 0;
    await assert.rejects(
      enqueueMotion(projectId, draftWith({ seed: '7', motionVariations: '3' })),
      /Queued 1 of 3 motion clips, then: Queue is full\./,
    );
    assert.equal(submitted.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await vite.close();
  }
});
