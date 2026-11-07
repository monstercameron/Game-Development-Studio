"""Check the native Windows sparse-attention adapter against CUDA SDPA."""
import os
import sys
from pathlib import Path

os.environ['SPARSE_ATTN_BACKEND'] = 'sdpa'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.forge-runtime' / 'trellis2-src'))
import torch
from trellis2.modules.sparse import VarLenTensor
from trellis2.modules.sparse.attention.full_attn import sparse_scaled_dot_product_attention as attention


def reference(q, k, v):
    return torch.nn.functional.scaled_dot_product_attention(
        q.transpose(0, 1).unsqueeze(0), k.transpose(0, 1).unsqueeze(0),
        v.transpose(0, 1).unsqueeze(0)).squeeze(0).transpose(0, 1)


assert torch.cuda.is_available(), 'CUDA is required.'
torch.manual_seed(91)
parts = [torch.randn(length, 3, 2, 8, device='cuda') for length in (3, 5)]
actual = attention(VarLenTensor.from_tensor_list(parts)).to_tensor_list()
for values, result in zip(parts, actual):
    q, k, v = values.unbind(1)
    torch.testing.assert_close(result, reference(q, k, v))

q = [torch.randn(length, 2, 8, device='cuda') for length in (2, 4)]
kv = torch.randn(2, 3, 2, 2, 8, device='cuda')
actual = attention(VarLenTensor.from_tensor_list(q), kv).to_tensor_list()
for batch, result in enumerate(actual):
    k, v = kv[batch].unbind(1)
    torch.testing.assert_close(result, reference(q[batch], k, v))

dense_q = torch.randn(2, 3, 2, 8, device='cuda')
k = [torch.randn(length, 2, 8, device='cuda') for length in (4, 2)]
v = [torch.randn(length, 2, 8, device='cuda') for length in (4, 2)]
actual = attention(dense_q, VarLenTensor.from_tensor_list(k), VarLenTensor.from_tensor_list(v))
for batch in range(2):
    torch.testing.assert_close(actual[batch], reference(dense_q[batch], k[batch], v[batch]))

try:
    attention(VarLenTensor.from_tensor_list([torch.randn(2, 3, 2, 8)]))
except RuntimeError as error:
    assert 'requires CUDA' in str(error)
else:
    raise AssertionError('CPU sparse attention was accepted.')
print('TRELLIS.2 segmented sparse SDPA passed on CUDA.')
