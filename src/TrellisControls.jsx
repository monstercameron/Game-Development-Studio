import { trellisRequest } from './trellis-settings';

export default function TrellisControls({ draft, onChange }) {
  const steps = draft.trellisSteps === undefined ? 12 : (draft.trellisSteps ?? '');
  let error = '';
  try {
    trellisRequest({ ...draft, trellisSteps: steps });
  } catch (reason) {
    error = reason.message;
  }
  return (
    <>
      <div className="options">
        <label htmlFor="trellis-texture">
          <span className="field-label">Texture size</span>
          <select
            id="trellis-texture"
            value={draft.trellisTexture ?? 1024}
            onChange={(event) => onChange({ trellisTexture: Number(event.target.value) })}
          >
            <option value={512}>512 px</option>
            <option value={1024}>1024 px</option>
            <option value={2048}>2048 px</option>
          </select>
        </label>
        <label htmlFor="trellis-steps">
          <span className="field-label">Denoising steps</span>
          <input
            id="trellis-steps"
            type="number"
            min="1"
            max="50"
            step="1"
            value={steps}
            aria-invalid={!!error}
            aria-describedby="trellis-help"
            onChange={(event) => onChange({ trellisSteps: event.target.value })}
          />
        </label>
      </div>
      <p id="trellis-help" className="helper">
        {error ||
          'Experimental 512-resolution textured model. A full render has not yet been verified.'}
      </p>
    </>
  );
}
