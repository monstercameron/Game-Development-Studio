import React from 'react';
import { Aperture, AudioLines, Box, Clapperboard, Cpu, Gamepad2, Layers3, Mic2, Music2, Scissors, WandSparkles } from 'lucide-react';
import './model-plaque.css';

// These are the configured GPU admission budgets, not measured model sizes.
// Keep them aligned with runtime/*-preparation.js and runtime/model-load.js.
const models = {
  'Qwen Image 2.1': {icon:Aperture, load:48},
  'Hunyuan3D 2.1': {icon:Box, load:16},
  'TRELLIS.2': {icon:Layers3, load:4, render:24},
  'HY-Motion 1.0': {icon:Gamepad2, load:26},
  'NVIDIA MotionBricks': {icon:WandSparkles, load:8},
  'MiniMax H3 Ref2VA': {icon:Clapperboard, load:6, phase:'render'},
  'YuE2': {icon:Music2, load:24},
  'Stable Audio 3': {icon:AudioLines, load:20},
  'Qwen3-TTS 1.7B · Preset voices': {icon:Mic2, load:12},
  'Meta SAM 3.1': {icon:Scissors, load:12},
  'Mammoth-1 · OneJev': {icon:Cpu, load:24},
};

export default function ModelPlaque({model, supportsRender, isGame}) {
  const info = models[model];
  const Icon = info?.icon || Cpu;
  const explanation = 'Estimated free GPU memory checked by Forge, not a measurement of model size. Forge also keeps a 2 GiB GPU reserve; actual usage and rendering needs vary.';
  return <div className="engine-chip model-plaque">
    <span className="model-plaque-icon" aria-hidden="true"><Icon size={23} strokeWidth={1.7}/></span>
    <div className="model-plaque-copy">
      <small>{supportsRender?'RENDER MODEL':isGame?'DECISION SERVICE':'PLANNED MODEL'}</small>
      <strong>{model}</strong>
      {info && <span className="model-plaque-memory" title={explanation} aria-label={explanation}>
        <Cpu size={13} aria-hidden="true"/> Est. GPU {info.phase==='render'?'render':'load'}: ~{info.load} GiB{info.render?` · +${info.render} GiB render`:''}
      </span>}
    </div>
    <span className={supportsRender||isGame?'integration-badge':'integration-badge preview'}>{supportsRender?'Render workflow':isGame?'Decision API':'Preview'}</span>
  </div>;
}
