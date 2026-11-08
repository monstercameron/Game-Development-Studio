import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';
import { friendlyAssetName, jobHint } from '../src/job-hints.js';

const jobBase = {
  id: randomUUID(),
  status: 'completed',
  startedAt: '2026-11-07T10:00:00.000Z',
  finishedAt: '2026-11-07T10:00:30.000Z',
};
// The record the library shows is the stored metadata shaped like readAssetMeta's result.
function shown(job, output) {
  const meta = buildJobMetadata(job, output);
  return {
    type: meta.jobType,
    job: { id: meta.jobId, type: meta.jobType },
    asset: { path: meta.path, kind: meta.kind },
    prompt: {
      text: meta.prompt,
      negative: meta.negative,
      secondary: meta.secondary,
      title: meta.title,
    },
    seed: meta.seed,
    settings: meta.settings,
    references: meta.references,
    parent: meta.parentPath ? { path: meta.parentPath } : null,
    model: meta.model,
  };
}
const rows = (meta) =>
  Object.fromEntries(describeSettings(meta).map((row) => [row.key, row.value]));

test('an image variation is described as "n of N" and its group bookkeeping is hidden', () => {
  const group = randomUUID();
  const meta = shown(
    {
      ...jobBase,
      type: 'images',
      request: {
        prompt: 'a fox',
        width: 1024,
        height: 576,
        num_inference_steps: 3,
        references: [],
        seed: 11,
        variation_group: group,
        variation_index: 2,
        variation_count: 4,
        lora: 'pixel-art.safetensors',
        lora_scale: 0.7,
        use_kv_cache: false,
        sigma_schedule: '1, 0.6, 0.2',
        output_resolution: 1536,
      },
    },
    'images/forge-a.png',
  );
  const described = rows(meta);
  assert.equal(described.variation_index, '2 of 4');
  assert.equal(Object.hasOwn(described, 'variation_group'), false);
  assert.equal(Object.hasOwn(described, 'variation_count'), false);
  assert.equal(described.lora, 'pixel-art.safetensors');
  assert.equal(described.lora_scale, '0.7');
  assert.equal(described.use_kv_cache, 'Off');
  assert.equal(described.sigma_schedule, '1, 0.6, 0.2');
  assert.equal(meta.settings.variation_group, group, 'the group is stored with the asset');
  const labels = Object.fromEntries(describeSettings(meta).map((row) => [row.key, row.label]));
  assert.equal(labels.variation_index, 'Variation');
  assert.equal(labels.lora, 'LoRA');
  assert.equal(labels.use_kv_cache, 'KV cache');

  const plan = reusePlan(meta);
  assert.equal(plan.draft.imageLora, 'pixel-art.safetensors');
  assert.equal(plan.draft.imageLoraScale, '0.7');
  assert.equal(plan.draft.imageKvCache, false);
  assert.equal(plan.draft.imageSigmas, '1, 0.6, 0.2');
  assert.equal(plan.draft.imageTargetSize, '1536');
  assert.equal(Object.hasOwn(plan.draft, 'imageVariations'), false, 'a reuse is a single render');
  assert.equal(
    reusePlan({ ...meta, settings: { ...meta.settings, use_kv_cache: undefined } }).draft
      .imageKvCache,
    true,
  );
});

test('an extended track names its source as the parent and keeps the engine job out of view', () => {
  const meta = shown(
    {
      ...jobBase,
      type: 'music',
      request: {
        operation: 'extend',
        source: 'music/forge-a.flac',
        source_job: randomUUID(),
        source_remote: 'yue-1',
        seed: 4,
        add_seconds: 30,
        lyrics_addition: '[Outro]\nla',
        style: 'warm pop',
        lyrics: '[Verse]\nhi\n\n[Outro]\nla',
        title: 'Song (extended)',
        duration_seconds: 30,
      },
    },
    'music/forge-b.flac',
  );
  assert.equal(meta.parent.path, 'music/forge-a.flac');
  assert.equal(meta.prompt.text, 'warm pop');
  assert.equal(meta.prompt.secondary, '[Verse]\nhi\n\n[Outro]\nla');
  const described = rows(meta);
  assert.equal(described.operation, 'Extended a finished track');
  assert.equal(described.source, 'music/forge-a.flac');
  assert.equal(described.add_seconds, '30');
  // The stored duration is only the added part, so it is not shown as the track length.
  assert.equal(Object.hasOwn(described, 'duration_seconds'), false);
  // Reusing the settings starts a fresh render from the preset length and the plain title.
  const reuse = reusePlan(meta).draft;
  assert.equal(reuse.musicDuration, '');
  assert.equal(reuse.musicTitle, 'Song');
  assert.equal(reuse.options[0], '15 seconds');
  assert.equal(Object.hasOwn(described, 'source_remote'), false);
  assert.equal(Object.hasOwn(described, 'source_job'), false);
  const resynth = shown(
    {
      ...jobBase,
      type: 'music',
      request: { operation: 'resynth', source: 'music/forge-a.flac', seed: 1, title: 'Again' },
    },
    'music/forge-c.flac',
  );
  assert.equal(rows(resynth).operation, 'Re-synthesized');
  // A normal track has no parent.
  assert.equal(
    shown(
      { ...jobBase, type: 'music', request: { style: 'x', lyrics: 'y', seed: 1 } },
      'music/forge-d.flac',
    ).parent,
    null,
  );
});

test('a sound made from a source records it as a reference and describes how it was used', () => {
  const staged = '11111111-2222-3333-4444-555555555555.wav';
  const meta = shown(
    {
      ...jobBase,
      type: 'sfx',
      request: {
        prompt: 'a door',
        duration: 6,
        steps: 8,
        seed: 3,
        source_audio: staged,
        edit_mode: 'replace',
        inpaint_start: 2,
        inpaint_end: 4,
      },
    },
    'sfx/forge-a.wav',
  );
  assert.deepEqual(
    meta.references.map((entry) => [entry.name, entry.mime]),
    [[`Source sound · ${staged}`, 'audio/wav']],
  );
  const described = rows(meta);
  assert.equal(described.edit_mode, 'Replaced a part of a source sound');
  assert.equal(described.inpaint_start, '2');
  assert.equal(described.inpaint_end, '4');
  assert.equal(Object.hasOwn(described, 'source_audio'), false, 'the staged ID is not shown');
  const plan = reusePlan(meta);
  assert.equal(plan.section, 'sfx');
  assert.equal(plan.draft.soundSourceId, '', 'sources are cleared, not carried over');
});

test('queue hints say what a job builds on', () => {
  assert.equal(jobHint({ type: 'images', request: { prompt: 'x' } }), '');
  assert.equal(
    jobHint({ type: 'images', request: { variation_index: 3, variation_count: 4 } }),
    'Variation 3 of 4',
  );
  assert.equal(
    jobHint({ type: 'sfx', request: { edit_mode: 'replace', inpaint_start: 1, inpaint_end: 2 } }),
    'Replacing 1–2 s of a source sound',
  );
  assert.equal(
    jobHint({ type: 'sfx', request: { edit_mode: 'continue' } }),
    'Continuing a source sound',
  );
  assert.equal(jobHint({ type: 'voices', request: { text: 'x' } }), '');
});

test('generated file names become short labels and named files stay as they are', () => {
  const id = '4be74c56-1cbb-40b7-9a09-55d984de0618';
  assert.equal(friendlyAssetName(`music/forge-${id}.flac`, 'track'), 'track 4be74c56');
  assert.equal(friendlyAssetName(`images\\forge-${id}-panorama.png`, 'image'), 'image 4be74c56');
  assert.equal(friendlyAssetName('music/theme song.flac', 'track'), 'theme song.flac');
  assert.equal(friendlyAssetName('', 'track', 'a track'), 'a track');
  assert.equal(friendlyAssetName(null), '');
});
