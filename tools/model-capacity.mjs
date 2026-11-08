// Measures the installed model weights and writes site/model-capacity.json, then refreshes the
// no-JavaScript table inside site/index.html. Run it on the reference machine:
//
//   node tools/model-capacity.mjs
//
// Options:
//   --no-studio          Do not contact a running studio (the GPU size is then reused from the
//                        existing JSON, and no cross-check against the studio scan is made).
//   --studio-url <url>   Loopback studio address (default http://127.0.0.1:5173).
//   --render-only        Rebuild the table in index.html from the existing JSON; measure nothing.
//
// The only network calls are read-only GET requests to a loopback studio: one hardware read and
// up to STORAGE_POLL_ATTEMPTS storage reads while the studio finishes its rescan.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { modelCatalog } from '../runtime/model-catalog.js';
import { managedModels } from '../runtime/model-inventory.js';
import '../site/capacity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsRoot = path.join(repoRoot, 'models');
const jsonPath = path.join(repoRoot, 'site', 'model-capacity.json');
const htmlPath = path.join(repoRoot, 'site', 'index.html');

export const STATIC_START = '<!-- capacity:static:start -->';
export const STATIC_END = '<!-- capacity:static:end -->';
const DEFAULT_STUDIO_URL = 'http://127.0.0.1:5173';
const BYTES_PER_GIB = 1024 ** 3;
const BYTES_PER_GB = 1000 ** 3;
const BYTES_PER_MIB = 1024 ** 2;
// A folder this large that no row claims is treated as a forgotten model.
const UNMAPPED_LIMIT_BYTES = 100 * BYTES_PER_MIB;
// The studio answers "scanning" while it rescans. 12 polls 5 s apart wait up to about one minute.
const STORAGE_POLL_ATTEMPTS = 12;
const STORAGE_POLL_INTERVAL_MS = 5000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Hand-written mapping from folders under models/ to the rows of the site table. `card` is the
// id of the model card (or of the supporting-checkpoints card) the row links to, and `name` must
// equal that card's heading. Every folder belongs to exactly one row; the script fails when a
// folder over 100 MiB is not listed, so a new model cannot be forgotten.
export const ROW_DEFINITIONS = [
  {
    id: 'images',
    name: 'Qwen Image 2.1',
    area: 'Images',
    card: 'model-qwen-image',
    kind: 'weights',
    folders: ['Qwen-Image-2.1', 'Qwen-Image-2.1-LoRA'],
    note: 'Includes the folder for image LoRAs.',
  },
  {
    id: '3d-hunyuan',
    name: 'Hunyuan3D 2.1',
    area: '3D models',
    card: 'model-hunyuan',
    kind: 'weights',
    folders: ['Hunyuan3D-2.1'],
  },
  {
    id: '3d-trellis',
    name: 'TRELLIS.2',
    area: '3D models',
    card: 'model-trellis',
    kind: 'weights',
    folders: ['TRELLIS.2-4B'],
    note: 'Its decoder and DINOv3 encoder are listed separately as supporting checkpoints.',
  },
  {
    id: 'worldgen',
    name: 'WorldGen',
    area: 'Worlds',
    card: 'model-worldgen',
    kind: 'weights',
    folders: ['worldgen'],
    note: 'The two Q5 transformers; the FLUX.1 components live in the shared cache.',
  },
  {
    id: 'hy-world',
    name: 'HY-World 2.0',
    area: 'Worlds',
    card: 'model-hyworld',
    kind: 'weights',
    folders: ['HY-World-2.0'],
  },
  {
    id: 'motion-hy',
    name: 'HY-Motion 1.0',
    area: 'Character motion',
    card: 'model-hymotion',
    kind: 'weights',
    folders: ['HY-Motion'],
    note: 'Includes the CLIP ViT-L/14 and Qwen3-8B text encoders stored in the same folder.',
  },
  {
    id: 'motion-bricks',
    name: 'NVIDIA MotionBricks',
    area: 'Character motion',
    card: 'model-motionbricks',
    kind: 'weights',
    folders: ['MotionBricks'],
  },
  {
    id: 'video',
    name: 'MiniMax H3 Ref2VA',
    area: 'Video',
    card: 'model-h3',
    kind: 'weights',
    folders: ['MiniMax-H3'],
    note: 'Includes its LoRAs and VAEs.',
  },
  {
    id: 'music',
    name: 'YuE2',
    area: 'Music',
    card: 'model-yue2',
    kind: 'weights',
    folders: ['YuE2-3B', 'YuE2-Vae'],
    note: 'The YuE2-3B model and the YuE2-Vae decoder.',
  },
  {
    id: 'sfx',
    name: 'Stable Audio 3 Medium',
    area: 'Sound effects',
    card: 'model-stable-audio',
    kind: 'weights',
    folders: ['Stable-Audio-3'],
  },
  {
    id: 'tts',
    name: 'Qwen3-TTS 1.7B',
    area: 'Voices',
    card: 'model-tts',
    kind: 'weights',
    folders: ['Qwen3-TTS-12Hz-1.7B-CustomVoice'],
    note: 'The preset-voice checkpoint; Base and VoiceDesign are listed separately.',
  },
  {
    id: 'asr',
    name: 'Nemotron Speech Streaming 0.6B',
    area: 'Voices',
    card: 'model-asr',
    kind: 'weights',
    folders: ['nemotron-speech-streaming-en-0.6b'],
  },
  {
    id: 'segmentation',
    name: 'Meta SAM 3.1',
    area: 'Segmentation',
    card: 'model-sam',
    kind: 'weights',
    folders: ['sam3.1'],
  },
  {
    id: 'game',
    name: 'Mammoth-1',
    area: 'Game logic',
    card: 'model-mammoth',
    kind: 'weights',
    folders: ['Mammoth-1'],
  },
  {
    id: 'chat',
    name: 'Qwen3.8-27B',
    area: 'Chat',
    card: 'model-chat',
    kind: 'weights',
    folders: ['Qwen3.8-27B-GGUF'],
    note: 'A quantized GGUF file.',
  },
  {
    id: 'vegetation',
    name: 'SeedThree',
    area: 'Vegetation',
    card: 'model-vegetation',
    kind: 'weights',
    folders: [],
    note: 'Runs on the CPU and has no model weights.',
  },
  {
    id: 'trellis-decoder',
    name: 'TRELLIS image decoder',
    area: '3D models',
    card: 'model-support',
    kind: 'supporting',
    folders: ['TRELLIS-image-large'],
    note: 'Used by TRELLIS.2.',
  },
  {
    id: 'trellis-encoder',
    name: 'DINOv3 ViT-L/16 encoder',
    area: '3D models',
    card: 'model-support',
    kind: 'supporting',
    folders: ['dinov3-vitl16-pretrain-lvd1689m'],
    note: 'Used by TRELLIS.2.',
  },
  {
    id: 'tts-base',
    name: 'Qwen3-TTS Base',
    area: 'Voices',
    card: 'model-support',
    kind: 'supporting',
    folders: ['Qwen3-TTS-12Hz-1.7B-Base'],
    note: 'Optional checkpoint for voice cloning.',
  },
  {
    id: 'tts-voicedesign',
    name: 'Qwen3-TTS VoiceDesign',
    area: 'Voices',
    card: 'model-support',
    kind: 'supporting',
    folders: ['Qwen3-TTS-12Hz-1.7B-VoiceDesign'],
    note: 'Optional checkpoint for designing a voice from a description.',
  },
  {
    id: 'comfy-models',
    name: 'ComfyUI companion files',
    area: 'Video',
    card: 'model-support',
    kind: 'supporting',
    folders: ['ComfyUI'],
    note: 'LoRA and preview files. A file it shares with MiniMax H3 is counted under H3.',
  },
  {
    id: 'world-hf-cache',
    name: 'Shared Hugging Face cache',
    area: 'Worlds',
    card: 'model-support',
    kind: 'cache',
    folders: ['hf-cache'],
    note: 'Holds the FLUX.1 dev and Fill components, DA-2 and the WorldGen LoRAs.',
  },
  {
    id: 'other',
    name: 'Other small folders',
    area: 'Other',
    card: 'model-support',
    kind: 'supporting',
    folders: ['forge-install-staging'],
    note: 'Installer staging and folders under 100 MiB that no other row claims.',
  },
];

const KIND_PRIORITY = { weights: 0, supporting: 1, cache: 2 };

function toGiB(bytes) {
  return Math.round((bytes / BYTES_PER_GIB) * 100) / 100;
}

function toGB(bytes) {
  return Math.round((bytes / BYTES_PER_GB) * 100) / 100;
}

function formatGiBText(bytes) {
  return globalThis.ForgeCapacity.formatGiB(bytes);
}

// Checks the table against the catalogs: each folder in exactly one row, and every folder that
// Forge's own catalogs know about is present.
export function validateDefinitions(definitions = ROW_DEFINITIONS) {
  const owner = new Map();
  const ids = new Set();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate row id: ${definition.id}`);
    }
    ids.add(definition.id);
    for (const folder of definition.folders) {
      if (owner.has(folder)) {
        throw new Error(
          `Folder ${folder} is mapped to both ${owner.get(folder)} and ${definition.id}.`,
        );
      }
      owner.set(folder, definition.id);
    }
  }
  const known = new Set([
    ...managedModels.map((model) => model.folder),
    ...modelCatalog.map((model) => model.folder).filter(Boolean),
  ]);
  for (const folder of known) {
    if (!owner.has(folder)) {
      throw new Error(`Forge's model catalog uses folder ${folder}, but no table row maps it.`);
    }
  }
  return owner;
}

/**
 * Walks models/ without following links. Each regular file is counted once even when NTFS hard
 * links give it several names. Folders are visited models first, then supporting files, then
 * caches, so a file shared between a model and a cache is attributed to the model.
 */
export async function scanModelsFolder(root, owner, definitions = ROW_DEFINITIONS) {
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('The models folder is missing or is a link.');
  }
  const kindOf = new Map(definitions.map((definition) => [definition.id, definition.kind]));
  const entries = await fs.readdir(root, { withFileTypes: true });
  const ordered = entries
    .map((entry) => {
      const rowId = owner.get(entry.name) ?? 'other';
      return { entry, rowId, priority: KIND_PRIORITY[kindOf.get(rowId)] };
    })
    .sort((a, b) => a.priority - b.priority || a.entry.name.localeCompare(b.entry.name, 'en'));

  const linked = new Map();
  const folders = new Map();
  let skippedLinks = 0;

  const walk = async (directory, stats) => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      const fullPath = path.join(directory, child.name);
      const info = await fs.lstat(fullPath, { bigint: true });
      if (info.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      if (info.isDirectory()) {
        await walk(fullPath, stats);
        continue;
      }
      if (!info.isFile()) {
        continue;
      }
      const size = Number(info.size);
      stats.files += 1;
      stats.nameBytes += size;
      if (info.nlink > 1n) {
        const key = `${info.dev}:${info.ino}`;
        const known = linked.get(key);
        if (known) {
          known.names += 1;
          continue;
        }
        linked.set(key, { size, names: 1, links: Number(info.nlink) });
      }
      stats.bytes += size;
    }
  };

  for (const { entry, rowId } of ordered) {
    const fullPath = path.join(root, entry.name);
    const stats = { rowId, bytes: 0, nameBytes: 0, files: 0 };
    const info = await fs.lstat(fullPath);
    if (info.isSymbolicLink()) {
      skippedLinks += 1;
    } else if (info.isDirectory()) {
      await walk(fullPath, stats);
    } else if (info.isFile()) {
      stats.bytes = info.size;
      stats.nameBytes = info.size;
      stats.files = 1;
    }
    folders.set(entry.name, stats);
  }

  let sharedWithOutsideBytes = 0;
  let sharedWithOutsideFiles = 0;
  for (const file of linked.values()) {
    if (file.links > file.names) {
      sharedWithOutsideBytes += file.size;
      sharedWithOutsideFiles += 1;
    }
  }
  return { folders, skippedLinks, sharedWithOutsideBytes, sharedWithOutsideFiles };
}

/**
 * Throws when a folder over 100 MiB under models/ is not claimed by a row, so that a new model
 * cannot be left out of the capacity table without a visible failure.
 */
export function assertNoForgottenModel(folders, owner) {
  const forgotten = [...folders.entries()].filter(
    ([name, stats]) => !owner.has(name) && stats.nameBytes > UNMAPPED_LIMIT_BYTES,
  );
  if (forgotten.length > 0) {
    const list = forgotten
      .map(([name, stats]) => `${name} (${formatGiBText(stats.nameBytes)} GiB)`)
      .join(', ');
    throw new Error(
      `Unmapped folder(s) over 100 MiB: ${list}. Add each to ROW_DEFINITIONS in ` +
        'tools/model-capacity.mjs so the capacity table cannot omit a model.',
    );
  }
}

export function buildRows(folders, definitions = ROW_DEFINITIONS) {
  const rows = definitions.map((definition) => {
    let bytes = 0;
    for (const stats of folders.values()) {
      if (stats.rowId === definition.id) {
        bytes += stats.bytes;
      }
    }
    return { definition, bytes };
  });
  // Empty supporting rows (an installer folder that holds nothing) add noise, so they are dropped.
  return rows.filter(({ definition, bytes }) => definition.kind === 'weights' || bytes > 0);
}

async function readJson(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`GET ${new URL(url).pathname} returned HTTP ${response.status}.`);
  }
  return response.json();
}

function assertLoopback(studioUrl) {
  const url = new URL(studioUrl);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('--studio-url must be a loopback address (127.0.0.1, localhost or [::1]).');
  }
  return url;
}

// Both calls are read-only GET requests that use the studio's own origin and request header.
async function readStudio(studioUrl) {
  const base = assertLoopback(studioUrl);
  const headers = { Origin: base.origin, 'X-Forge-Request': 'runtime' };
  const hardware = await readJson(new URL('/api/runtime/hardware', base), headers);
  // The studio rescans in the background and answers "scanning" until it has finished, so wait.
  let storage = null;
  for (let attempt = 0; attempt < STORAGE_POLL_ATTEMPTS; attempt += 1) {
    storage = await readJson(new URL('/api/runtime/model-storage', base), headers);
    if (storage.state === 'ready') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, STORAGE_POLL_INTERVAL_MS));
  }
  return { storage, hardware };
}

function pickGpu(hardware) {
  const device = (hardware.devices ?? []).find((item) => Number.isInteger(item.totalMiB));
  if (!device) {
    throw new Error('The hardware endpoint reported no GPU with a memory size.');
  }
  return {
    gpuName: String(device.name),
    gpuMemoryMiB: device.totalMiB,
    gpuMemoryGiB: device.totalMiB / 1024,
    source: 'GET /api/runtime/hardware (read-only)',
    measuredAt: hardware.measuredAt,
  };
}

function crossCheckStudio(storage, scan, totalBytes) {
  if (storage.state !== 'ready' || !Array.isArray(storage.entries)) {
    return null;
  }
  const entries = storage.entries.filter((entry) => Number.isInteger(entry.bytes));
  const studioBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const scanned = new Set(entries.map((entry) => entry.folder));
  let uniqueOfScanned = 0;
  let namesOfScanned = 0;
  let unscannedBytes = 0;
  let sameSizes = true;
  for (const [name, stats] of scan.folders) {
    if (scanned.has(name)) {
      uniqueOfScanned += stats.bytes;
      namesOfScanned += stats.nameBytes;
    } else {
      unscannedBytes += stats.bytes;
    }
  }
  for (const entry of entries) {
    const local = scan.folders.get(entry.folder);
    if (!local || local.nameBytes !== entry.bytes) {
      sameSizes = false;
    }
  }
  const countedTwice = namesOfScanned - uniqueOfScanned;
  return {
    source: 'Forge studio storage scan (GET /api/runtime/model-storage, read-only)',
    observedAt: storage.observedAt,
    entries: entries.length,
    bytes: studioBytes,
    gib: toGiB(studioBytes),
    gb: toGB(studioBytes),
    sameSizesAsDirectScan: sameSizes && studioBytes === namesOfScanned,
    reconciliation: {
      studioBytes,
      hardLinkedNamesCountedTwiceBytes: countedTwice,
      foldersTheStudioDoesNotScanBytes: unscannedBytes,
      thisTotalBytes: totalBytes,
      unexplainedBytes: studioBytes - countedTwice + unscannedBytes - totalBytes,
    },
  };
}

function methodParagraphs({ date, scan, crossCheck, totalBytes }) {
  const paragraphs = [
    `Sizes were measured on ${date} by tools/model-capacity.mjs. It walks every folder under ` +
      'the checkout’s models folder without following links, adds up the size of each regular ' +
      'file, and assigns each folder to one row of the table through a mapping written in the ' +
      'script. The script fails when a folder over 100 MiB is not mapped, so a new model cannot ' +
      'be left out. Sizes are file sizes, so they exclude filesystem overhead and are not ' +
      'parameter counts.',
    'NTFS can give one file several names (hard links). Each such file is counted once, in ' +
      'the model row that owns it. Forge’s Models page and its storage scan add up every name, ' +
      'so they can report more bytes than the files really occupy.',
  ];
  if (crossCheck) {
    const twice = formatGiBText(crossCheck.reconciliation.hardLinkedNamesCountedTwiceBytes);
    const unscanned = formatGiBText(crossCheck.reconciliation.foldersTheStudioDoesNotScanBytes);
    paragraphs.push(
      `The running studio’s own storage scan reported ${formatGiBText(crossCheck.bytes)} GiB ` +
        `for the same models folder; this table totals ${formatGiBText(totalBytes)} GiB. The ` +
        `difference is ${twice} GiB of hard-linked names that the studio scan counts twice` +
        (crossCheck.reconciliation.foldersTheStudioDoesNotScanBytes > 0
          ? `, offset by ${unscanned} GiB in a folder the studio scan does not cover`
          : '') +
        (crossCheck.reconciliation.unexplainedBytes === 0
          ? ' (no bytes are left unexplained).'
          : `, with ${formatGiBText(Math.abs(crossCheck.reconciliation.unexplainedBytes))} GiB ` +
            'still unexplained, probably files that changed between the two scans.'),
    );
  }
  if (scan.sharedWithOutsideFiles > 0) {
    const sharedGiBText = formatGiBText(scan.sharedWithOutsideBytes);
    paragraphs.push(
      `${scan.sharedWithOutsideFiles} of the counted files (${sharedGiBText} ` +
        'GiB) also have hard links outside the models folder. They are counted here, but ' +
        'deleting them from the models folder would not free that space.',
    );
  }
  paragraphs.push(
    'Not measured: parameter counts, compressed size, GPU memory used by a loaded model, or ' +
      'duplicate content stored as separate copies.',
  );
  return paragraphs;
}

/**
 * Builds the document written to site/model-capacity.json. Pure: it reads no files and makes no
 * requests. `rows` come from buildRows, `scan` from scanModelsFolder and `machine` carries the GPU
 * size (`gpuMemoryMiB`) used for the comparison.
 */
export function buildCapacity({ rows, scan, machine, crossCheck, generatedAt }) {
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const jsonRows = rows
    .map(({ definition, bytes }) => ({
      id: definition.id,
      name: definition.name,
      area: definition.area,
      card: definition.card,
      kind: definition.kind,
      bytes,
      gib: toGiB(bytes),
      share: Math.round((bytes / totalBytes) * 100000) / 100000,
      note: definition.note ?? '',
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'en'));
  const modelRows = jsonRows.filter((row) => row.kind === 'weights');
  const supportingRows = jsonRows.filter((row) => row.kind !== 'weights');
  const modelBytes = modelRows.reduce((sum, row) => sum + row.bytes, 0);
  const supportingBytes = supportingRows.reduce((sum, row) => sum + row.bytes, 0);
  const gpuMemoryBytes = machine.gpuMemoryMiB * BYTES_PER_MIB;
  const date = generatedAt.slice(0, 10);
  const capacity = {
    schemaVersion: 1,
    generatedAt,
    machine,
    method: [],
    totals: {
      models: modelRows.length,
      modelsWithWeights: modelRows.filter((row) => row.bytes > 0).length,
      supportingEntries: supportingRows.length,
      files: [...scan.folders.values()].reduce((sum, stats) => sum + stats.files, 0),
      bytes: totalBytes,
      gib: toGiB(totalBytes),
      gb: toGB(totalBytes),
      modelBytes,
      modelGib: toGiB(modelBytes),
      supportingBytes,
      supportingGib: toGiB(supportingBytes),
    },
    rows: jsonRows,
    comparison: {
      gpuMemoryBytes,
      modelWeightsBytes: modelBytes,
      modelWeightsToGpuMemory: Math.round((modelBytes / gpuMemoryBytes) * 100) / 100,
      text: '',
    },
    crossCheck,
  };
  capacity.method = methodParagraphs({ date, scan, crossCheck, totalBytes });
  const summary = globalThis.ForgeCapacity.summarize(capacity);
  capacity.comparison.text = globalThis.ForgeCapacity.compareText(capacity, summary);
  return capacity;
}

/** The markup stored between the markers in index.html, indented to sit inside the section. */
export function staticBlock(data) {
  const markup = globalThis.ForgeCapacity.sectionMarkup(data, { isInteractive: false });
  return `${STATIC_START}\n      ${markup}\n      ${STATIC_END}`;
}

export function replaceStaticBlock(html, data) {
  const start = html.indexOf(STATIC_START);
  const end = html.indexOf(STATIC_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`index.html needs the markers ${STATIC_START} and ${STATIC_END}.`);
  }
  return html.slice(0, start) + staticBlock(data) + html.slice(end + STATIC_END.length);
}

async function main() {
  const args = process.argv.slice(2);
  const studioIndex = args.indexOf('--studio-url');
  const studioUrl = studioIndex === -1 ? DEFAULT_STUDIO_URL : args[studioIndex + 1];
  const useStudio = !args.includes('--no-studio');

  if (args.includes('--render-only')) {
    const existing = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    const html = await fs.readFile(htmlPath, 'utf8');
    await fs.writeFile(htmlPath, replaceStaticBlock(html, existing));
    console.log('Rebuilt the static table in site/index.html from site/model-capacity.json.');
    return;
  }

  const owner = validateDefinitions();
  const scan = await scanModelsFolder(modelsRoot, owner);
  assertNoForgottenModel(scan.folders, owner);
  const rows = buildRows(scan.folders);

  let machine = null;
  let crossCheck = null;
  if (useStudio) {
    try {
      const studio = await readStudio(studioUrl);
      machine = pickGpu(studio.hardware);
      const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
      crossCheck = crossCheckStudio(studio.storage, scan, totalBytes);
      if (!crossCheck) {
        console.warn('The studio storage scan is not ready; skipping the cross-check.');
      }
    } catch (error) {
      console.warn(`Studio not reachable (${error.message}); using the saved GPU size.`);
    }
  }
  if (!machine) {
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    } catch {
      throw new Error('No GPU size is available: start the studio, or keep an existing JSON file.');
    }
    machine = existing.machine;
  }
  const capacity = buildCapacity({
    rows,
    scan,
    machine,
    crossCheck,
    generatedAt: new Date().toISOString(),
  });
  await fs.writeFile(jsonPath, `${JSON.stringify(capacity, null, 2)}\n`);
  const html = await fs.readFile(htmlPath, 'utf8');
  await fs.writeFile(htmlPath, replaceStaticBlock(html, capacity));

  console.log(
    `${capacity.totals.models} models, ${capacity.totals.supportingEntries} supporting entries: ` +
      `${formatGiBText(capacity.totals.bytes)} GiB (${capacity.totals.gb} GB) on disk.`,
  );
  for (const row of capacity.rows) {
    console.log(`  ${row.gib.toFixed(2).padStart(7)} GiB  ${row.kind.padEnd(10)} ${row.name}`);
  }
  if (crossCheck) {
    console.log(
      `Studio scan: ${formatGiBText(crossCheck.bytes)} GiB; unexplained difference: ` +
        `${crossCheck.reconciliation.unexplainedBytes} bytes.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
