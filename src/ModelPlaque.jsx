import {
  Aperture,
  AudioLines,
  Box,
  Clapperboard,
  Cpu,
  Gamepad2,
  Layers3,
  Mic2,
  Music2,
  Scissors,
  WandSparkles,
} from 'lucide-react';
import './model-plaque.css';

// These are the configured GPU admission budgets, not measured model sizes.
// The budget strings match the "Est. GPU budget" values in runtime/model-catalog.js
// so the same model reads the same on every page. Keep them aligned with
// runtime/*-preparation.js and runtime/model-load.js.
const models = {
  'Qwen Image 2.1': { icon: Aperture, budget: '~48 GiB load' },
  'Hunyuan3D 2.1': { icon: Box, budget: '~16 GiB load · up to +16 GiB render' },
  'TRELLIS.2': { icon: Layers3, budget: '~4 GiB load · +24 GiB render' },
  'HY-Motion 1.0': { icon: Gamepad2, budget: '~26 GiB load · +8–16 GiB render' },
  'NVIDIA MotionBricks': { icon: WandSparkles, budget: '~8 GiB load · +3 GiB render' },
  'MiniMax H3 Ref2VA': {
    icon: Clapperboard,
    budget: '~6 GiB render · ~12 GiB with reference clips',
  },
  YuE2: { icon: Music2, budget: '~24 GiB load' },
  'Stable Audio 3': { icon: AudioLines, budget: '~20 GiB load' },
  'Qwen3-TTS 1.7B · Preset voices': { icon: Mic2, budget: '~12 GiB load · +8 GiB render' },
  'Meta SAM 3.1': { icon: Scissors, budget: '~12 GiB load' },
  'Mammoth-1 · OneJev': { icon: Cpu, budget: '~24 GiB load' },
};

// Badge text is chosen in priority order: a selector action wins over the
// render or decision-service status, which wins over the preview label.
function getBadgeLabel({ hasModelSelector, supportsRender, isGame }) {
  if (hasModelSelector) {
    return 'Change model';
  }
  if (supportsRender) {
    return 'Render workflow';
  }
  if (isGame) {
    return 'Decision API';
  }
  return 'Preview';
}

// The budget prop replaces the catalog string when the caller has a runtime
// estimate (the video page computes it from the draft settings).
export default function ModelPlaque({
  model,
  supportsRender,
  isGame,
  hasModelSelector = false,
  budget = null,
}) {
  const info = models[model];
  const Icon = info?.icon || Cpu;
  const explanation =
    'Configured GPU admission budget, not measured model usage. ' +
    'Forge keeps a 2 GiB GPU reserve; actual usage and rendering needs vary.';
  const badgeTone = supportsRender || isGame ? 'integration-badge' : 'integration-badge preview';
  const badgeClassName = hasModelSelector ? `${badgeTone} model-plaque-action` : badgeTone;
  const handleOpenModelSelector = () => {
    const selector = document.querySelector('#model3d, #motion-model');
    selector?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    selector?.focus({ preventScroll: true });
  };
  const Plaque = hasModelSelector ? 'button' : 'div';
  return (
    <Plaque
      className={`engine-chip model-plaque${hasModelSelector ? ' is-actionable' : ''}`}
      onClick={hasModelSelector ? handleOpenModelSelector : undefined}
      type={hasModelSelector ? 'button' : undefined}
      aria-label={hasModelSelector ? `Change render model: ${model}` : undefined}
    >
      <span className="model-plaque-icon" aria-hidden="true">
        <Icon size={23} strokeWidth={1.7} />
      </span>
      <span className="model-plaque-copy">
        <small>
          {supportsRender ? 'Render model' : isGame ? 'Decision service' : 'Planned model'}
        </small>
        <strong>{model}</strong>
        {info && (
          <span className="model-plaque-memory" title={explanation}>
            <Cpu size={13} aria-hidden="true" /> Est. GPU budget: {budget ?? info.budget}
          </span>
        )}
      </span>
      <span className={badgeClassName}>
        {getBadgeLabel({ hasModelSelector, supportsRender, isGame })}
      </span>
    </Plaque>
  );
}
