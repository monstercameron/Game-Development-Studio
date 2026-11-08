// Turns Fab's file list for a listing into the choices the page and MCP offer.
//
// Fab names every file after the model and its level of detail, for example
// `<model>_mid.glb`, `<model>_gltf_low.zip`, `<model>_high.zip` (FBX) or `<model>_exr_raw.zip`.
// The classification below is by name and format code only; Forge never opens a file before the
// user chooses it.
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;
export const QUALITIES = ['low', 'mid', 'high', 'raw'];

const GROUPS = [
  { id: 'glb', label: 'GLB (one file, recommended)', order: 0 },
  { id: 'gltf', label: 'glTF (ZIP with textures)', order: 1 },
  { id: 'fbx', label: 'FBX (ZIP with textures)', order: 2 },
  { id: 'ue', label: 'glTF for Unreal Engine (ZIP)', order: 3 },
  { id: 'usdz', label: 'USDZ (Forge cannot open this format)', order: 4 },
  { id: 'extra', label: 'Advanced: extra texture files', order: 5 },
];
const IMPORTABLE = new Set(['glb', 'gltf', 'fbx', 'ue']);

function plain(value, max) {
  return String(value ?? '').slice(0, max);
}

function qualityOf(name) {
  const match = /_(raw|high|mid|low)\.[a-z0-9]+$/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}

function groupOf(formatCode, name) {
  const lower = name.toLowerCase();
  if (formatCode === 'additional-files') {
    return 'extra';
  }
  if (lower.endsWith('.glb')) {
    return 'glb';
  }
  if (lower.endsWith('.usdz')) {
    return 'usdz';
  }
  if (formatCode === 'gltf') {
    return 'ue';
  }
  if (formatCode === 'fbx') {
    return 'fbx';
  }
  if (formatCode === 'converted-files' && lower.endsWith('.zip')) {
    return 'gltf';
  }
  return 'extra';
}

/**
 * @param {object[]} formats The array returned by `/i/listings/<id>/asset-formats`.
 * @returns {{ groups: object[], recommendedUid: string | null }}
 */
export function describeFiles(formats) {
  const buckets = new Map(GROUPS.map((group) => [group.id, []]));
  for (const format of Array.isArray(formats) ? formats : []) {
    const code = plain(format?.assetFormatType?.code, 40);
    for (const file of Array.isArray(format?.files) ? format.files : []) {
      const name = plain(file?.name, 160);
      const uid = plain(file?.uid, 36);
      const size =
        Number.isSafeInteger(file?.fileSize) && file.fileSize >= 0 ? file.fileSize : null;
      if (!name || !/^[0-9a-f-]{36}$/i.test(uid) || !/^[a-z0-9-]{1,40}$/.test(code)) {
        continue;
      }
      const group = groupOf(code, name);
      buckets.get(group).push({
        uid: uid.toLowerCase(),
        name,
        size,
        formatCode: code,
        group,
        quality: qualityOf(name),
        importable: IMPORTABLE.has(group),
        isLarge: size !== null && size > LARGE_FILE_BYTES,
      });
    }
  }
  const rank = (file) => QUALITIES.indexOf(file.quality ?? '');
  const groups = GROUPS.map((group) => ({
    ...group,
    advanced: group.id === 'extra',
    files: buckets
      .get(group.id)
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 12),
  })).filter((group) => group.files.length);
  const importable = groups.filter((group) => IMPORTABLE.has(group.id));
  const preferred =
    importable.find((group) => group.id === 'glb')?.files.find((file) => file.quality === 'mid') ||
    importable.flatMap((group) => group.files).find((file) => file.quality === 'mid') ||
    importable[0]?.files[0] ||
    null;
  return { groups, recommendedUid: preferred?.uid ?? null };
}

/**
 * Finds the file a request names, by uid or by format and quality.
 * @param {{ groups: object[] }} files Output of describeFiles.
 * @param {{ fileUid?: string, format?: string, quality?: string }} choice
 * @returns {object | null}
 */
export function pickFile(files, { fileUid, format, quality } = {}) {
  const all = (files?.groups || []).flatMap((group) => group.files);
  if (fileUid) {
    return all.find((file) => file.uid === String(fileUid).toLowerCase()) || null;
  }
  if (!format || !quality) {
    return null;
  }
  return all.find((file) => file.group === format && file.quality === quality) || null;
}
