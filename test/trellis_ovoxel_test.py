"""Exercise compiled O-Voxel CUDA serialization without loading model weights."""
import importlib.util
import sysconfig
from pathlib import Path
import torch

package = Path(sysconfig.get_path('purelib')) / 'o_voxel'
binary = next(package.glob('_C*.pyd'))
spec = importlib.util.spec_from_file_location('o_voxel._C', binary)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert torch.cuda.is_available(), 'CUDA is required.'
coords = torch.tensor([[0, 0, 0], [2, 5, 3], [7, 1, 4], [31, 15, 8]], dtype=torch.int32, device='cuda')
for name in ('z_order', 'hilbert'):
    code = getattr(module, f'{name}_encode_cuda')(coords[:, 0].contiguous(), coords[:, 1].contiguous(), coords[:, 2].contiguous())
    decoded = torch.stack(getattr(module, f'{name}_decode_cuda')(code), dim=1)
    torch.cuda.synchronize()
    assert code.is_cuda and decoded.is_cuda
    torch.testing.assert_close(decoded, coords)
print('O-Voxel Z-order and Hilbert CUDA round trips passed.')
