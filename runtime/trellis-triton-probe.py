"""Verify a native Triton JIT kernel on CUDA without loading model weights."""

import torch
import triton
import triton.language as tl


@triton.jit
def add_one(source, destination, count: tl.constexpr, block: tl.constexpr):
    offsets = tl.program_id(0) * block + tl.arange(0, block)
    loaded_values = tl.load(source + offsets, mask=offsets < count, other=0)
    tl.store(destination + offsets, loaded_values + 1, mask=offsets < count)


if not torch.cuda.is_available():
    raise RuntimeError("CUDA unavailable; CPU execution is not supported.")
source_values = torch.arange(1024, device="cuda", dtype=torch.float32)
destination_values = torch.empty_like(source_values)
add_one[(triton.cdiv(source_values.numel(), 256),)](
    source_values, destination_values, source_values.numel(), 256
)
# The kernel launch is asynchronous; wait for it before comparing results.
torch.cuda.synchronize()
if not torch.equal(destination_values, source_values + 1):
    raise RuntimeError("Triton CUDA kernel returned incorrect results.")
print(f"Triton {triton.__version__} CUDA kernel passed on {torch.cuda.get_device_name(0)}.")
