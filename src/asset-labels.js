// Friendly display names for project assets. Forge saves its renders as forge-<job id>.<ext>,
// which says nothing about the picture, sound or model inside. The label is built from the
// stored generation metadata and is shown only on screen: stored file names never change, and
// the real name stays available as secondary text, a tooltip and in the generation details.

// Same pattern as src/job-hints.js: the first eight characters of the job ID tell two files apart.
const generatedFileName = /^forge-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_LABEL_WORDS = 6;
const MAX_LABEL_CHARACTERS = 48;

export function assetFileName(asset) {
  const source = String(asset?.name || asset?.title || asset?.id || '');
  return source.split(/[\\/]/).filter(Boolean).pop() || '';
}

// What to call the file when there is no prompt to describe it: "Image", "Track", "Sound"...
export function assetNoun(asset) {
  const folder = String(asset?.id || '').toLowerCase();
  if (folder.startsWith('music/')) {
    return 'Track';
  }
  if (folder.startsWith('sfx/')) {
    return 'Sound';
  }
  if (folder.startsWith('voices/')) {
    return 'Voice';
  }
  return (
    {
      Images: 'Image',
      Masks: 'Cutout',
      Video: 'Video',
      '3D': '3D model',
      Audio: 'Audio',
      Text: 'Text',
    }[asset?.category] || 'File'
  );
}

// The first few words of a prompt, on one line. Empty when there is nothing to show.
export function promptSnippet(prompt) {
  const words = String(prompt ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) {
    return '';
  }
  let snippet = words.slice(0, MAX_LABEL_WORDS).join(' ');
  let shortened = words.length > MAX_LABEL_WORDS;
  if (snippet.length > MAX_LABEL_CHARACTERS) {
    snippet = snippet.slice(0, MAX_LABEL_CHARACTERS - 1).trimEnd();
    shortened = true;
  }
  return shortened ? `${snippet.replace(/[.,;:!?-]+$/, '')}…` : snippet;
}

// { label, fileName, secondary, isGenerated }. `secondary` is the quieter line under the label:
// the file name for a generated file, otherwise the project path. `meta` is the details-index
// entry for the asset, if it has loaded.
// A file that someone named themselves keeps its own name.
export function friendlyAssetLabel(asset, meta) {
  const fileName = assetFileName(asset);
  const generated = generatedFileName.exec(fileName);
  if (!generated) {
    return { label: fileName, fileName, secondary: asset?.id || fileName, isGenerated: false };
  }
  const snippet = promptSnippet(meta?.prompt);
  return {
    label: snippet || `${assetNoun(asset)} ${generated[1]}`,
    fileName,
    secondary: fileName,
    isGenerated: true,
  };
}
