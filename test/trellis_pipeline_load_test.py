"""Load the actual offline 512 pipeline; do not run the memory-heavy renderer."""
import ctypes
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'runtime'))
class MemoryStatus(ctypes.Structure):
    _fields_ = [('length',ctypes.c_ulong),('load',ctypes.c_ulong),('total_phys',ctypes.c_ulonglong),
                ('available_phys',ctypes.c_ulonglong),('total_page_file',ctypes.c_ulonglong),
                ('available_page_file',ctypes.c_ulonglong),('total_virtual',ctypes.c_ulonglong),
                ('available_virtual',ctypes.c_ulonglong),('available_extended_virtual',ctypes.c_ulonglong)]
memory=MemoryStatus();memory.length=ctypes.sizeof(memory)
if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)) or memory.available_phys < 8*1024**3:
    raise RuntimeError('At least 8 GiB available system memory is required for this load test.')
from PIL import Image
import trellis_backend as backend
assert not backend.missing_files()
pipeline=backend.load_trellis()
assert set(pipeline.models)==set(backend.COMPONENTS)
assert pipeline.low_vram and pipeline.default_pipeline_type=='512'
assert pipeline.device.type=='cuda'
pipeline.image_cond_model.image_size=224
pipeline.image_cond_model.cuda()
features=pipeline.image_cond_model([Image.new('RGB',(224,224),(128,64,32))])
assert features.is_cuda and features.shape[-1]==1024
backend.torch.cuda.synchronize()
print('Offline 512 pipeline and its CUDA image encoder loaded successfully; rendering was not tested.')
