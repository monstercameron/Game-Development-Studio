export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
export const TRELLIS_EXTENSIONS = ['png', 'webp'];
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'opus'];
export const POSE_EXTENSIONS = ['bvh'];

export function compatibleAssets(assets, extensions, query = '') {
  const allowed = new Set(extensions.map((value) => value.toLowerCase().replace(/^\./, '')));
  const search = query.trim().toLowerCase();
  return (assets || []).filter(
    (asset) =>
      allowed.has((asset.name || '').split('.').pop().toLowerCase()) &&
      (!search || `${asset.name} ${asset.id}`.toLowerCase().includes(search)),
  );
}

// Each selection is read through the existing local project asset endpoint.
// The caller passes the resulting File to the same validated queue/upload path
// as a file chosen from the OS, preserving the queue-time input snapshot.
/**
 * Reads each selected library asset from the project asset endpoint into a File.
 *
 * @param {{ id: string }} project Project whose asset endpoint serves the files.
 * @param {Array<{ id: string, name: string, size?: number }>} assets Library entries; `id` is
 *   the project-relative path.
 * @param {{ maxBytes?: number, totalBytes?: number, signal?: AbortSignal,
 *   fetchImpl?: typeof fetch }} [options] Size limits in bytes and request controls.
 * @returns {Promise<File[]>} Files in the same order as `assets`.
 * @throws {Error} When a file or the combined selection exceeds its size limit, or when a
 *   request fails (the error has a `cause`). An aborted request rethrows its AbortError.
 */
export async function readLibraryFiles(
  project,
  assets,
  { maxBytes, totalBytes, signal, fetchImpl = fetch } = {},
) {
  let total = 0;
  const files = [];
  for (const asset of assets) {
    if (Number.isFinite(maxBytes) && asset.size > maxBytes) {
      throw Error(`${asset.name} is too large.`);
    }
    const url = `/api/projects/${encodeURIComponent(project.id)}/asset?path=${encodeURIComponent(asset.id)}`;
    let response;
    let blob;
    try {
      response = await fetchImpl(url, { signal });
      if (!response.ok) {
        throw Error('request failed');
      }
      blob = await response.blob();
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        throw error;
      }
      throw Error(`Could not read ${asset.name}. Refresh the library and try again.`, {
        cause: error,
      });
    }
    if (Number.isFinite(maxBytes) && blob.size > maxBytes) {
      throw Error(`${asset.name} is too large.`);
    }
    total += blob.size;
    if (Number.isFinite(totalBytes) && total > totalBytes) {
      throw Error('The selected files exceed the combined size limit.');
    }
    const file = new File([blob], asset.name, {
      type: asset.type || blob.type || 'application/octet-stream',
      lastModified: Date.parse(asset.modified) || Date.now(),
    });
    // Remember where the file came from so a consumer can read it from the project instead.
    file.forgeSource = { projectId: project.id, path: asset.id };
    files.push(file);
  }
  return files;
}
