"""Verify the native nvdiffrast CUDA rasterizer with a small triangle."""

import nvdiffrast.torch as dr
import torch

assert torch.cuda.is_available(), "CUDA is required."
vertices = torch.tensor(
    [[[-0.8, -0.8, 0.0, 1.0], [0.8, -0.8, 0.0, 1.0], [0.0, 0.8, 0.0, 1.0]]], device="cuda"
)
triangles = torch.tensor([[0, 1, 2]], dtype=torch.int32, device="cuda")
context = dr.RasterizeCudaContext(device=vertices.device)
raster, _ = dr.rasterize(context, vertices, triangles, resolution=[32, 32])
torch.cuda.synchronize()
assert raster.is_cuda and raster.shape == (1, 32, 32, 4)
assert torch.count_nonzero(raster[..., 3]).item() > 0
print("nvdiffrast CUDA triangle rasterization passed.")
