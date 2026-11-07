"""Verify a native Triton JIT kernel on CUDA without loading model weights."""

import torch
import triton
import triton.language as tl


@triton.jit
def add_one(source, destination, count: tl.constexpr, block: tl.constexpr):
    offsets = tl.program_id(0) * block + tl.arange(0, block)
    data = tl.load(source + offsets, mask=offsets < count, other=0)
    tl.store(destination + offsets, data + 1, mask=offsets < count)


if not torch.cuda.is_available():
    raise RuntimeError("CUDA unavailable; CPU execution is not supported.")
x = torch.arange(1024, device="cuda", dtype=torch.float32)
y = torch.empty_like(x)
add_one[(triton.cdiv(x.numel(), 256),)](x, y, x.numel(), 256)
torch.cuda.synchronize()
if not torch.equal(y, x + 1):
    raise RuntimeError("Triton CUDA kernel returned incorrect results.")
print(f"Triton {triton.__version__} CUDA kernel passed on {torch.cuda.get_device_name(0)}.")
