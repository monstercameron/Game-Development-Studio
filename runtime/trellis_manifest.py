"""Local files required by the experimental 512-resolution TRELLIS.2 pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / 'models' / 'TRELLIS.2-4B'
DECODER = ROOT / 'models' / 'TRELLIS-image-large' / 'ckpts' / 'ss_dec_conv3d_16l8_fp16'
DINO = ROOT / 'models' / 'dinov3-vitl16-pretrain-lvd1689m'
COMPONENTS = {
    'sparse_structure_flow_model': 'ckpts/ss_flow_img_dit_1_3B_64_bf16',
    'sparse_structure_decoder': None,
    'shape_slat_flow_model_512': 'ckpts/slat_flow_img2shape_dit_1_3B_512_bf16',
    'shape_slat_decoder': 'ckpts/shape_dec_next_dc_f16c32_fp16',
    'tex_slat_flow_model_512': 'ckpts/slat_flow_imgshape2tex_dit_1_3B_512_bf16',
    'tex_slat_decoder': 'ckpts/tex_dec_next_dc_f16c32_fp16',
}

def required_files():
    paths = [MODEL / 'pipeline.json', DINO / 'config.json', DINO / 'model.safetensors']
    for relative in COMPONENTS.values():
        base = MODEL / relative if relative else DECODER
        paths.extend((Path(f'{base}.json'), Path(f'{base}.safetensors')))
    return paths

def missing_files():
    return [path for path in required_files() if not path.is_file()]
