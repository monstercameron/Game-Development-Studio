import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Which TRELLIS.2 pipelines have their checkpoints on disk. This mirrors
// trellis_manifest.pipelines_available() so the studio can offer (or hide) a pipeline while the
// worker is stopped. The 512 pipeline's files are the base set; the others add the 1024 flow
// models, which sit in the same repository folder. The worker re-checks before every render.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRA_CHECKPOINTS = [
  'slat_flow_img2shape_dit_1_3B_1024_bf16',
  'slat_flow_imgshape2tex_dit_1_3B_1024_bf16',
];

function present(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function installedTrellisPipelines(modelRoot = path.join(appRoot, 'models')) {
  const folder = path.join(modelRoot, 'TRELLIS.2-4B', 'ckpts');
  const higher = EXTRA_CHECKPOINTS.every(
    (name) =>
      present(path.join(folder, `${name}.json`)) &&
      present(path.join(folder, `${name}.safetensors`)),
  );
  // The 512 pipeline stays listed: whether the base checkpoints exist is reported separately
  // as model_downloaded, and a missing base disables the whole engine.
  return higher ? ['512', '1024', '1024_cascade', '1536_cascade'] : ['512'];
}
