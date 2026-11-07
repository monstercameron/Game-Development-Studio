"""Offline, GPU-only TRELLIS.2 512 pipeline for an isolated Windows worker.

The caller must perform host/GPU memory admission before loading or rendering.
Only transparent inputs are supported until the gated background remover is
available. Checkpoints are memory-mapped to avoid an extra full CPU copy.
"""
import gc
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.forge-runtime' / 'trellis2-cache'
os.environ['ATTN_BACKEND'] = 'sdpa'
os.environ['SPARSE_ATTN_BACKEND'] = 'sdpa'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HOME'] = str(ROOT / 'models' / 'hf-cache')
os.environ['TORCH_HOME'] = str(ROOT / 'models' / 'torch-cache')
os.environ['TRITON_HOME'] = str(CACHE)
os.environ['FLEX_GEMM_AUTOTUNE_CACHE_PATH'] = str(CACHE / 'flex-gemm' / 'autotune_cache.json')
os.environ['FLEX_GEMM_AUTOSAVE_AUTOTUNE_CACHE'] = '0'

import numpy as np
import torch
from accelerate import init_empty_weights
from safetensors.torch import load_file
from trellis_manifest import MODEL, DECODER, DINO, COMPONENTS, missing_files


def _load_component(base):
    from trellis2 import models
    config = json.loads(Path(f'{base}.json').read_text(encoding='utf-8'))
    with init_empty_weights():
        model = getattr(models, config['name'])(**config['args'])
    state = load_file(f'{base}.safetensors', device='cpu')
    mismatch = model.load_state_dict(state, strict=False, assign=True)
    missing = set(mismatch.missing_keys)
    # This deterministic buffer is absent from the upstream checkpoint.
    if config['name'] == 'SparseStructureFlowModel' and missing == {'rope_phases'}:
        from trellis2.modules.attention import RotaryPositionEmbedder
        args = config['args']
        positions = torch.meshgrid(*[torch.arange(args['resolution']) for _ in range(3)], indexing='ij')
        coords = torch.stack(positions, dim=-1).reshape(-1, 3)
        model.rope_phases = RotaryPositionEmbedder(args['model_channels'] // args['num_heads'], 3)(coords)
        missing.clear()
    if missing or mismatch.unexpected_keys or any(value.device.type == 'meta' for value in list(model.parameters()) + list(model.buffers())):
        raise RuntimeError(f'Checkpoint {base.name} does not match its model configuration.')
    model.eval()
    return model


class TransparentOnly:
    def to(self, _device):
        return self

    def cpu(self):
        return self

    def __call__(self, _image):
        raise ValueError('TRELLIS.2 currently requires a transparent image. Remove its background first.')


def load_trellis():
    if not torch.cuda.is_available():
        raise RuntimeError('TRELLIS.2 requires CUDA; CPU inference is disabled.')
    missing = missing_files()
    if missing:
        raise RuntimeError(f'TRELLIS.2 is missing {len(missing)} required files, including {missing[0].name}.')
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.pipelines import samplers
    from trellis2.modules.image_feature_extractor import DinoV3FeatureExtractor
    config = json.loads((MODEL / 'pipeline.json').read_text(encoding='utf-8'))['args']
    for key, expected in COMPONENTS.items():
        if expected and config['models'].get(key) != expected:
            raise RuntimeError(f'Unexpected TRELLIS.2 pipeline component: {key}.')
    if config['models'].get('sparse_structure_decoder') != 'microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16':
        raise RuntimeError('Unexpected TRELLIS.2 decoder configuration.')
    loaded = {key:_load_component(MODEL / relative if relative else DECODER) for key,relative in COMPONENTS.items()}
    def sampler(key):
        return getattr(samplers, config[key]['name'])(**config[key]['args'])
    pipeline = Trellis2ImageTo3DPipeline(
        models=loaded,
        sparse_structure_sampler=sampler('sparse_structure_sampler'),
        shape_slat_sampler=sampler('shape_slat_sampler'),
        tex_slat_sampler=sampler('tex_slat_sampler'),
        sparse_structure_sampler_params=config['sparse_structure_sampler']['params'],
        shape_slat_sampler_params=config['shape_slat_sampler']['params'],
        tex_slat_sampler_params=config['tex_slat_sampler']['params'],
        shape_slat_normalization=config['shape_slat_normalization'],
        tex_slat_normalization=config['tex_slat_normalization'],
        image_cond_model=DinoV3FeatureExtractor(str(DINO)),
        rembg_model=TransparentOnly(), low_vram=True, default_pipeline_type='512')
    pipeline.cuda()
    gc.collect()
    return pipeline


def validate_transparent(image):
    if image.mode != 'RGBA':
        raise ValueError('TRELLIS.2 currently requires a PNG or WebP with a transparent background.')
    alpha = np.asarray(image.getchannel('A'))
    if alpha.min() == 255 or np.count_nonzero(alpha > 204) < 4:
        raise ValueError('The image needs a transparent background and a visible foreground.')
    ys, xs = np.where(alpha > 204)
    if xs.max() == xs.min() or ys.max() == ys.min():
        raise ValueError('The visible foreground is too small.')


def generate_glb(pipeline, image, destination, *, seed=42, steps=12, texture_size=1024):
    if not torch.cuda.is_available():
        raise RuntimeError('TRELLIS.2 requires CUDA; CPU inference is disabled.')
    validate_transparent(image)
    if not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError('Invalid seed.')
    if not isinstance(steps, int) or not 1 <= steps <= 50 or texture_size not in (512, 1024, 2048):
        raise ValueError('Unsupported sampling steps or texture size.')
    import o_voxel
    with torch.inference_mode():
        mesh = pipeline.run(image, seed=seed, pipeline_type='512',
                            sparse_structure_sampler_params={'steps':steps},
                            shape_slat_sampler_params={'steps':steps},
                            tex_slat_sampler_params={'steps':steps})[0]
        if mesh is None or not len(mesh.vertices) or not len(mesh.faces):
            raise RuntimeError('No mesh was generated. Try another image or seed.')
        mesh.simplify(16777216)
        glb = o_voxel.postprocess.to_glb(vertices=mesh.vertices, faces=mesh.faces,
            attr_volume=mesh.attrs, coords=mesh.coords, attr_layout=mesh.layout,
            voxel_size=mesh.voxel_size, aabb=[[-0.5,-0.5,-0.5],[0.5,0.5,0.5]],
            decimation_target=1000000, texture_size=texture_size,
            remesh=True, remesh_band=1, remesh_project=0, verbose=True)
        glb.export(str(destination), file_type='glb', extension_webp=True)
