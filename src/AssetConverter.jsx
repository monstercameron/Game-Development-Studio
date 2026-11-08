import { useEffect, useState } from 'react';
import { ArrowDownToLine, FileOutput, X } from 'lucide-react';
import './asset-converter.css';

const imageFormats = [
  ['png', 'PNG · lossless'],
  ['webp', 'WebP · lossless'],
  ['jpeg', 'JPEG · smaller file'],
  ['bmp', 'BMP · uncompressed'],
  ['tga', 'TGA · game texture'],
];
const audioFormats = [
  ['wav', 'WAV · uncompressed'],
  ['flac', 'FLAC · lossless'],
  ['ogg', 'Ogg Vorbis · game audio'],
  ['opus', 'Ogg Opus · efficient audio'],
  ['mp3', 'MP3 · widely supported'],
];

// WebM (VP8) is poorly supported by game engines and editors, so videos convert to MP4 or GIF.
const videoFormats = [
  ['mp4', 'MP4 · H.264 video and AAC sound'],
  ['gif', 'GIF · silent loop, up to 480 px wide'],
];

// 3D models convert between these mesh formats (see runtime/model-convert.js). Each copy keeps
// its generation details; the original is untouched.
const modelFormats = [
  ['glb', 'GLB · one file, game ready'],
  ['gltf', 'glTF · one text file with the data embedded'],
  ['obj', 'OBJ · with an MTL material and a PNG texture'],
  ['ply', 'PLY · colours stored per vertex'],
  ['stl', 'STL · shape only, for printing'],
];
const modelNotes = {
  glb: 'Repackages the container without changing the model.',
  gltf: 'Repackages the container without changing the model; the data is embedded as text, so the file is about a third larger.',
  obj: 'Saves the OBJ plus an .mtl file and the colour texture as a PNG beside it, all named after the copy. Metallic and roughness maps and animations are not part of OBJ. Forge’s viewer shows the OBJ shape without its texture.',
  ply: 'PLY has no textures, so the texture is baked into colours at each vertex, which loses fine detail.',
  stl: 'STL keeps only the shape: no colours, textures or animation.',
};
const modelExtensions = ['glb', 'gltf', 'obj', 'ply', 'stl'];
const modelExtension = (id) => id.split('.').at(-1).toLowerCase();

export function canConvert(asset) {
  return (
    asset &&
    (['Images', 'Masks', 'Audio', 'Video'].includes(asset.category) ||
      (asset.category === '3D' && modelExtensions.includes(modelExtension(asset.id))))
  );
}
// Pick a format that differs from the source so the first conversion does something useful.
function defaultFormat(id, category) {
  if (category === '3D') {
    return modelExtension(id) === 'glb' ? 'obj' : 'glb';
  }
  if (category === 'Audio') {
    return 'ogg';
  }
  if (category === 'Video') {
    return 'mp4';
  }
  return id.toLowerCase().endsWith('.png') ? 'webp' : 'png';
}
export default function AssetConverter({ asset, project, onSaved, onClose }) {
  const audio = asset.category === 'Audio';
  const video = asset.category === 'Video';
  const model = asset.category === '3D';
  const sourceName = asset.id.split('/').at(-1);
  const [format, setFormat] = useState(() => defaultFormat(asset.id, asset.category)),
    [quality, setQuality] = useState(90),
    [background, setBackground] = useState('#ffffff'),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    setFormat(defaultFormat(asset.id, asset.category));
    setResult(null);
    setError('');
  }, [asset.id, asset.category]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/assets/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
        body: JSON.stringify({ path: asset.id, format, quality, background }),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw Error('The conversion service returned an unreadable response.');
      }
      if (!response.ok) {
        throw Error(data?.error || 'Could not convert this asset.');
      }
      if (
        !data ||
        typeof data.name !== 'string' ||
        typeof data.path !== 'string' ||
        typeof data.backend !== 'string' ||
        typeof data.url !== 'string'
      ) {
        throw Error('The conversion service returned an incomplete result.');
      }
      setResult(data);
      await onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not convert this asset.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="asset-converter" onSubmit={submit} aria-label="Convert asset" aria-busy={busy}>
      <div className="converter-heading">
        <div>
          <FileOutput size={18} />
          <strong>Convert a copy</strong>
        </div>
        <button
          type="button"
          className="converter-close"
          onClick={onClose}
          aria-label="Close converter"
          disabled={busy}
        >
          <X size={17} />
        </button>
      </div>
      <div className="converter-locations" aria-label="Conversion files">
        <p>
          <span>Original</span>
          <strong title={sourceName}>{sourceName}</strong>
        </p>
        <p>
          <span>Copy location</span>
          <strong>Same project folder</strong>
        </p>
      </div>
      <label>
        Output format
        <select
          value={format}
          disabled={busy}
          onChange={(e) => {
            setFormat(e.target.value);
            setResult(null);
          }}
        >
          {(model
            ? modelFormats.filter(([value]) => value !== modelExtension(asset.id))
            : video
              ? videoFormats
              : audio
                ? audioFormats
                : imageFormats
          ).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {(format === 'jpeg' || format === 'mp4') && (
        <label>
          {format === 'mp4' ? 'MP4 quality' : 'JPEG quality'} <span>{quality}%</span>
          <input
            type="range"
            min="1"
            max="100"
            value={quality}
            disabled={busy}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
        </label>
      )}
      {!audio && !video && ['jpeg', 'bmp'].includes(format) && (
        <label className="converter-background">
          Transparency background{' '}
          <input
            type="color"
            value={background}
            disabled={busy}
            onChange={(e) => setBackground(e.target.value)}
          />
        </label>
      )}
      <p className="converter-note">
        {model
          ? `${modelNotes[format] || ''} The original file is kept unchanged. Point clouds and Gaussian splats cannot be converted.`
          : format === 'mp4'
            ? 'Makes an H.264 + AAC MP4 that game engines, editors and phones play. The WebM stays unchanged; the MP4 keeps this video’s generation details.'
            : format === 'gif'
              ? 'Makes a silent, looping GIF at about 12 frames per second and up to 480 pixels wide. Long clips are cut at about 25 seconds.'
              : format === 'jpeg'
                ? 'JPEG can use NVIDIA nvJPEG when available. Forge reports the backend used after conversion. Transparency is filled with the chosen color.'
                : format === 'bmp'
                  ? 'Transparency is filled with the chosen color.'
                  : format === 'tga'
                    ? 'TGA is useful for game textures; Forge creates a preview thumbnail.'
                    : format === 'opus'
                      ? 'Opus is resampled to 48 kHz when needed.'
                      : 'The original file is kept unchanged.'}
      </p>
      <button className="primary" disabled={busy}>
        {busy ? 'Converting…' : 'Convert & save copy'}
      </button>
      {error && (
        <p className="converter-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="converter-result" role="status">
          <span>
            <strong>Saved {result.name}</strong>
            <small>
              Saved to {result.path}. Encoded with {result.backend}
            </small>
            {Array.isArray(result.extraFiles) && result.extraFiles.length > 0 && (
              <small>
                Also saved beside it: {result.extraFiles.map((file) => file.name).join(', ')}
              </small>
            )}
            {Array.isArray(result.notes) &&
              result.notes.map((note) => <small key={note}>{note}</small>)}
          </span>
          <a href={result.url} download={result.name}>
            <ArrowDownToLine size={16} /> Download
          </a>
        </div>
      )}
    </form>
  );
}
