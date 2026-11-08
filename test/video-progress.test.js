import test from 'node:test';
import assert from 'node:assert/strict';
import { videoProgress } from '../runtime/video-progress.js';

test('uses the latest sampling progress and removes terminal escapes', () => {
  const details =
    'loading 3/10 - 1GB/s\r\n |===| 1/8 - 15.0s/it - ETA 01:50\x1b[K\r |====| 2/8 - 16.14s/it - ETA 02:16\x1b[K';
  assert.equal(videoProgress(details, 8), 'Rendering video · step 2/8 · ETA 02:16');
});

test('ignores loading bars and progress from different step counts', () => {
  assert.equal(videoProgress('7/10 - 1GB/s', 8), null);
  assert.equal(videoProgress('2/12 - 10.0s/it - ETA 01:20', 8), null);
  assert.equal(videoProgress(null, 8), null);
});
