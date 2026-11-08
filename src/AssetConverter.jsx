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

export function canConvert(asset) {
  return asset && ['Images', 'Masks', 'Audio'].includes(asset.category);
}
// Pick a format that differs from the source so the first conversion does something useful.
function defaultFormat(id, category) {
  if (category === 'Audio') {
    return 'ogg';
  }
  return id.toLowerCase().endsWith('.png') ? 'webp' : 'png';
}
export default function AssetConverter({ asset, project, onSaved, onClose }) {
  const audio = asset.category === 'Audio';
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
          {(audio ? audioFormats : imageFormats).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {format === 'jpeg' && (
        <label>
          JPEG quality <span>{quality}%</span>
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
      {!audio && ['jpeg', 'bmp'].includes(format) && (
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
        {format === 'jpeg'
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
          </span>
          <a href={result.url} download={result.name}>
            <ArrowDownToLine size={16} /> Download
          </a>
        </div>
      )}
    </form>
  );
}
