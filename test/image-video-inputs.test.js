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
  assert.throws(() => videoRequest({ ...draft, videoSteps: '13' }), /supported video quality/);
});
