"""Compare the compiled sparse convolution and Triton CUDA implementations."""
import torch
import flex_gemm
from flex_gemm.ops.spconv import sparse_submanifold_conv3d

assert torch.cuda.is_available(), 'CUDA is required.'
torch.manual_seed(17)
positions = torch.cartesian_prod(torch.arange(3, device='cuda'), torch.arange(3, device='cuda'), torch.arange(3, device='cuda'))
coords = torch.cat((torch.zeros((len(positions), 1), dtype=torch.int32, device='cuda'), positions.to(torch.int32)), dim=1).contiguous()
features = torch.randn((len(coords), 8), dtype=torch.float16, device='cuda').contiguous()
weight = torch.randn((8, 3, 3, 3, 8), dtype=torch.float16, device='cuda').contiguous()
bias = torch.randn((8,), dtype=torch.float16, device='cuda')
shape = torch.Size((1, 8, 3, 3, 3))
flex_gemm.ops.spconv.set_algorithm(flex_gemm.ops.spconv.Algorithm.EXPLICIT_GEMM)
expected, _ = sparse_submanifold_conv3d(features, coords, shape, weight, bias)
flex_gemm.ops.spconv.set_algorithm(flex_gemm.ops.spconv.Algorithm.MASKED_IMPLICIT_GEMM_SPLITK)
actual, _ = sparse_submanifold_conv3d(features, coords, shape, weight, bias)
torch.cuda.synchronize()
assert actual.is_cuda
torch.testing.assert_close(actual, expected, rtol=0.02, atol=0.02)
print('FlexGEMM sparse convolution passed on CUDA.')
