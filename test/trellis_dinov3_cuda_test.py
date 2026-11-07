"""Exercise the real, locally downloaded TRELLIS.2 DINOv3 encoder on CUDA."""

import ctypes
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HOME"] = str(root / "models" / "hf-cache")
os.environ["ATTN_BACKEND"] = "sdpa"
os.environ["SPARSE_ATTN_BACKEND"] = "sdpa"
os.environ["TRITON_HOME"] = str(root / ".forge-runtime" / "trellis2-cache")
os.environ["FLEX_GEMM_AUTOTUNE_CACHE_PATH"] = str(
    root / ".forge-runtime" / "trellis2-cache" / "flex-gemm" / "autotune_cache.json"
)


class MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ulong),
        ("load", ctypes.c_ulong),
        ("total_phys", ctypes.c_ulonglong),
        ("available_phys", ctypes.c_ulonglong),
        ("total_page_file", ctypes.c_ulonglong),
        ("available_page_file", ctypes.c_ulonglong),
        ("total_virtual", ctypes.c_ulonglong),
        ("available_virtual", ctypes.c_ulonglong),
        ("available_extended_virtual", ctypes.c_ulonglong),
    ]


memory = MemoryStatus()
memory.length = ctypes.sizeof(memory)
if (
    not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory))
    or memory.available_phys < 5 * 1024**3
):
    raise RuntimeError("At least 5 GiB available system memory is required for this encoder test.")

import torch  # noqa: E402 - keep the memory guard ahead of CUDA initialization.
from PIL import Image  # noqa: E402 - keep the memory guard ahead of CUDA initialization.
from trellis2.modules.image_feature_extractor import (  # noqa: E402 - guarded CUDA test imports.
    DinoV3FeatureExtractor,
)

if not torch.cuda.is_available() or torch.cuda.mem_get_info()[0] < 4 * 1024**3:
    raise RuntimeError("CUDA and at least 4 GiB available GPU memory are required.")
model = DinoV3FeatureExtractor(
    str(root / "models" / "dinov3-vitl16-pretrain-lvd1689m"), image_size=224
)
model.cuda()
features = model([Image.new("RGB", (224, 224), (128, 64, 32))])
torch.cuda.synchronize()
assert features.is_cuda and features.shape[0] == 1 and features.shape[-1] == 1024
assert bool(torch.isfinite(features).all())
with torch.no_grad():
    pixels = model.transform(
        torch.tensor([128, 64, 32], device="cuda", dtype=torch.float32)
        .view(1, 3, 1, 1)
        .expand(1, 3, 224, 224)
        / 255
    )
    hidden = model.model.embeddings(pixels, bool_masked_pos=None)
    positions = model.model.rope_embeddings(pixels)
    encoded = model.model.model(hidden, position_embeddings=positions).last_hidden_state
    expected = torch.nn.functional.layer_norm(encoded, encoded.shape[-1:])
torch.testing.assert_close(features, expected, rtol=1e-4, atol=1e-4)
print(
    f"DINOv3 feature extraction passed on {torch.cuda.get_device_name(0)}; shape={tuple(features.shape)}."
)
