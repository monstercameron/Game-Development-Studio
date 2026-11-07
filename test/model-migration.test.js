import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { engineDefinitions } from '../runtime/engines.js';
import { defaultModelsRoot, managedModels } from '../runtime/model-inventory.js';

test('migrated engines use centralized storage and shared models cannot be removed', () => {
  const engine = (id) => engineDefinitions.find((item) => item.id === id);
  assert.equal(engine('images').env.QWEN_MODEL, path.join(defaultModelsRoot, 'Qwen-Image-2.1'));
  assert.equal(engine('music').env.FORGE_MODELS_ROOT, defaultModelsRoot);
  assert.equal(
    engine('sfx').env.HF_HUB_CACHE,
    path.join(defaultModelsRoot, 'Stable-Audio-3', 'hub'),
  );
  assert.equal(
    engine('video').env.FORGE_H3_VAE_ROOT,
    path.join(defaultModelsRoot, 'MiniMax-H3', 'sol-engine'),
  );
  assert.equal(engine('world').env.HF_HUB_CACHE, path.join(defaultModelsRoot, 'hf-cache', 'hub'));
  assert.equal(engine('game').env.FORGE_MAMMOTH_MODELS, path.join(defaultModelsRoot, 'Mammoth-1'));
  const chat = engine('chat');
  assert.equal(
    chat.args[chat.args.indexOf('--model') + 1],
    path.join(defaultModelsRoot, 'Qwen3.8-27B-GGUF', 'Qwen3.8-27B-Q4_K_M.gguf'),
  );
  for (const id of [
    'images',
    'music',
    'sfx',
    'video',
    'game',
    'hy-world',
    'chat',
    'motion-bricks',
  ]) {
    assert.equal(managedModels.find((model) => model.id === id)?.removable, false, id);
  }
});
