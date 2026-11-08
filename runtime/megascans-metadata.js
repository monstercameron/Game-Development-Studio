// Records where an imported Megascans file came from in the project's asset details database.
//
// The record uses the existing `import` source, so the Asset library and the generation details
// panel show it without a new schema. Settings keys avoid `url`/`path` suffixes because the
// asset-metadata sanitizer drops those; the listing address is stored as `source_link`.
import { buildProvenanceMetadata, upsertAssetMeta } from './asset-metadata.js';
import { attributionText, DEFAULT_LICENSE, FAB_SELLER } from './megascans-library.js';

/**
 * @param {string} projectFolder Real path of the project folder.
 * @param {string[]} paths Project-relative model paths (forward slashes).
 * @param {{
 *   listing: object | null,
 *   filename: string,
 *   title?: string,
 *   fileUid?: string | null,
 * }} source
 * @param {{ logger?: Console }} [options]
 * @returns {number} How many records were written.
 */
export function recordMegascansImport(projectFolder, paths, source, { logger } = {}) {
  const listing = source.listing;
  const title = listing?.title || source.title || source.filename.replace(/\.[^.]+$/, '');
  const settings = {
    seller: listing?.seller || FAB_SELLER,
    license: listing?.license || DEFAULT_LICENSE,
    original_file: source.filename,
  };
  if (source.fileUid) {
    // Downloaded by Forge from Fab rather than chosen by the user.
    settings.fab_file_uid = source.fileUid;
    settings.downloaded_at = new Date().toISOString();
  }
  if (listing) {
    settings.fab_listing_id = listing.id;
    settings.source_link = listing.url;
    settings.license_link = listing.licenseUrl;
    settings.attribution = attributionText(listing);
  } else {
    settings.attribution = `${title} by ${FAB_SELLER} (Epic Games), via Fab`;
  }
  let written = 0;
  for (const rel of paths) {
    const meta = buildProvenanceMetadata({
      path: rel,
      source: 'import',
      jobType: 'megascans-import',
      title,
      settings,
    });
    if (upsertAssetMeta(projectFolder, meta, { logger })) {
      written++;
    }
  }
  return written;
}
