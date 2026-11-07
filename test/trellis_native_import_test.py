"""Import the native TRELLIS.2 stack without downloading or loading weights."""
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
cache = root / '.forge-runtime' / 'trellis2-cache'
os.environ['ATTN_BACKEND'] = 'sdpa'
os.environ['SPARSE_ATTN_BACKEND'] = 'sdpa'
os.environ['TRITON_HOME'] = str(cache)
os.environ['FLEX_GEMM_AUTOTUNE_CACHE_PATH'] = str(cache / 'flex-gemm' / 'autotune_cache.json')
os.environ['FLEX_GEMM_AUTOSAVE_AUTOTUNE_CACHE'] = '0'
os.environ['HF_HOME'] = str(root / 'models' / 'hf-cache')
os.environ['TORCH_HOME'] = str(root / 'models' / 'torch-cache')
import torch
import cv2
import cumesh
import flex_gemm
import nvdiffrast.torch
import o_voxel
from trellis2.pipelines import Trellis2ImageTo3DPipeline

assert torch.cuda.is_available()
print(f'Native TRELLIS.2 imports passed on {torch.cuda.get_device_name(0)}; no model weights loaded.')
