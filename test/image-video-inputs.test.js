import test from 'node:test';
import assert from 'node:assert/strict';
import { imageRequest, videoRequest } from '../src/imageVideoInputs.js';

test('image controls map presets and custom values into the engine request', () => {
  const draft = {
    prompt: 'a castle',
    options: ['Landscape · 16:9', 'Balanced'],
    seed: '',
    referenceIds: [],
  };
  assert.deepEqual(imageRequest(draft), {
    prompt: 'a castle',
    width: 1024,
    height: 576,
    num_inference_steps: 30,
    references: [],
  });
  assert.deepEqual(
    imageRequest({
      ...draft,
      imageWidth: '512',
      imageHeight: '768',
      imageSteps: '22',
      seed: '42',
      imageNegativePrompt: '  blurred  ',
      imageGuidance: '2.5',
    }),
    {
      prompt: 'a castle',
      width: 512,
      height: 768,
      num_inference_steps: 22,
      references: [],
      seed: 42,
      negative_prompt: 'blurred',
      true_cfg_scale: 2.5,
    },
  );
  assert.equal(imageRequest({ ...draft, imageNegativePrompt: 'smoke' }).true_cfg_scale, 2);
});

test('image controls expose transparency, matched size and sizes up to 2752 px', () => {
  const draft = { prompt: 'a castle', options: ['Square · 1:1', 'Draft'], referenceIds: ['a.png'] };
  assert.deepEqual(imageRequest({ ...draft, imageTransparent: true, imageWidth: '2752' }), {
    prompt: 'a castle',
    width: 2752,
    height: 1024,
    num_inference_steps: 12,
    references: ['a.png'],
    transparent: true,
  });
  // A matched size lets the model pick width and height; the fields are not sent.
  assert.deepEqual(imageRequest({ ...draft, imageMatchReference: true, imageWidth: '512' }), {
    prompt: 'a castle',
    size_from_reference: true,
    num_inference_steps: 12,
    references: ['a.png'],
  });
  assert.throws(
    () => imageRequest({ ...draft, referenceIds: [], imageMatchReference: true }),
    /reference image/,
  );
  assert.throws(() => imageRequest({ ...draft, imageHeight: '2784' }), /Height/);
});

test('image controls reject invalid dimensions, steps, seeds and guidance', () => {
  const draft = { prompt: 'a castle', options: ['Square · 1:1', 'Balanced'], seed: '' };
  for (const [change, pattern] of [
    [{ imageWidth: '513' }, /multiple of 32/],
    [{ imageHeight: '0' }, /Height/],
    [{ imageSteps: '101' }, /Image steps/],
    [{ seed: '-1' }, /Seed/],
    [{ imageNegativePrompt: 'blurred', imageGuidance: '1' }, /guidance/],
    [{ imageNegativePrompt: 'blurred', imageGuidance: '11' }, /guidance/],
  ]) {
    assert.throws(() => imageRequest({ ...draft, ...change }), pattern);
  }
});

test('video quality is piped to supported H3 sampling settings', () => {
  const draft = {
    prompt: 'a castle',
    options: ['Portrait · 9:16', 'About 7 seconds'],
    referenceIds: ['ref.png'],
  };
  assert.deepEqual(videoRequest({ ...draft, videoSteps: '20' }), {
    prompt: 'a castle',
    references: ['ref.png'],
    aspect: 'portrait',
    frames: 175,
    steps: 20,
  });
  assert.equal(videoRequest(draft).steps, 12);
  assert.equal(
    'seed' in videoRequest(draft),
    false,
    'a blank seed is chosen when the job is queued',
  );
  assert.equal(videoRequest({ ...draft, seed: '42' }).seed, 42);
  assert.equal(videoRequest({ ...draft, seed: 0 }).seed, 0);
  for (const seed of ['-1', '2147483648', '1.5', 'abc']) {
    assert.throws(() => videoRequest({ ...draft, seed }), /Seed/);
  }
  assert.throws(() => videoRequest({ ...draft, videoSteps: '13' }), /supported video quality/);
});
