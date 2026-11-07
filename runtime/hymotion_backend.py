"""Experimental HY-Motion 1.0 backend for an isolated Forge worker.

This uses the upstream motion model and text encoders. It does not manage
concurrency or perform memory admission; callers must do both before loading.
"""
import gc
import os
from pathlib import Path
import sys

import numpy as np
import torch
import yaml

from hymotion_bvh import motion_to_bvh


def load_motion_core(source_dir, model_root, device='cuda'):
    from accelerate import init_empty_weights

    source = Path(source_dir).resolve()
    root = Path(model_root).resolve()
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable in the HY-Motion runtime.')
    sys.path.insert(0, str(source))
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    from hymotion.pipeline import motion_diffusion
    from hymotion.utils.loaders import load_object

    folder = root / 'HY-Motion-1.0'
    with (folder / 'config.yml').open(encoding='utf-8') as stream:
        config = yaml.safe_load(stream)
    args = config['train_pipeline_args']
    args['test_cfg']['mean_std_dir'] = str(source / 'stats')
    # Upstream's body-model path is relative to CWD. Keep the source path
    # explicit so the host process can start the worker from any directory.
    old_body = motion_diffusion.WoodenMesh
    try:
        motion_diffusion.WoodenMesh = lambda: old_body(str(source / 'scripts/gradio/static/assets/dump_wooden'))
        with init_empty_weights():
            pipeline = load_object(config['train_pipeline'], args,
                                   network_module=config['network_module'],
                                   network_module_args=config['network_module_args'])
    finally:
        motion_diffusion.WoodenMesh = old_body
    checkpoint = torch.load(folder / 'latest.ckpt', map_location='cpu', weights_only=True, mmap=True)
    weights = checkpoint['model_state_dict']
    missing, unexpected = pipeline.load_state_dict(weights, strict=False, assign=True)
    derived = {'body_model.j_template', 'body_model.parents', 'body_model.skin_indices',
               'body_model.skin_weights', 'body_model.v_template'}
    if set(missing) != derived or unexpected:
        raise RuntimeError(f'HY-Motion checkpoint does not match its architecture: missing={missing}, unexpected={unexpected}')
    pipeline = pipeline.to(device).eval()
    del checkpoint, weights
    gc.collect()

    return pipeline


def load_motion_text_encoder(pipeline, model_root, device='cuda'):
    from hymotion.utils.loaders import load_object
    from hymotion.network.text_encoders import text_encoder
    root = Path(model_root).resolve()
    text_encoder.LLM_ENCODER_LAYOUT['qwen3']['module_path'] = str(root / 'Qwen3-8B')
    text_encoder.SENTENCE_EMB_LAYOUT['clipl']['module_path'] = str(root / 'clip-vit-large-patch14')
    encoder = load_object(pipeline._text_encoder_module, pipeline._text_encoder_cfg)
    pipeline.text_encoder = encoder.to(device).eval()
    return pipeline


def load_motion(source_dir, model_root, device='cuda'):
    pipeline = load_motion_core(source_dir, model_root, device=device)
    return load_motion_text_encoder(pipeline, model_root, device=device)


def generate_motion(pipeline, prompt, *, duration=3, seed=123, steps=50, guidance=5.0):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 1000:
        raise ValueError('Describe one human motion in 1–1000 characters.')
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not np.isfinite(duration) or not 1 <= duration <= 12:
        raise ValueError('Duration must be between 1 and 12 seconds.')
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError('Seed must be an integer from 0 to 2147483647.')
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 100:
        raise ValueError('Steps must be an integer from 1 to 100.')
    if isinstance(guidance, bool) or not isinstance(guidance, (int, float)) or not np.isfinite(guidance) or not 0 <= guidance <= 20:
        raise ValueError('Guidance must be between 0 and 20.')
    previous = pipeline.validation_steps
    try:
        pipeline.validation_steps = steps
        with torch.inference_mode():
            result = pipeline.generate(prompt.strip(), [seed], duration, cfg_scale=guidance)
    finally:
        pipeline.validation_steps = previous
    rotations = result['rot6d'][0].detach().cpu().numpy()
    translation = result['transl'][0].detach().cpu().numpy()
    body = pipeline.body_model
    return motion_to_bvh(rotations, translation, body.j_template.detach().cpu().numpy(),
                         body.parents.detach().cpu().numpy(), body.joint_names,
                         fps=pipeline.output_mesh_fps)
