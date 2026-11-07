"""Download the public, pinned image-to-3D checkpoints into Forge's models folder.

DINOv3 and background-removal weights are gated and are deliberately excluded.
Existing files with unexpected content are never overwritten.
"""
import hashlib
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ['HF_HOME'] = str(ROOT / 'models' / 'hf-cache')
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

from huggingface_hub import HfApi, hf_hub_download

NAMES = (
    'shape_dec_next_dc_f16c32_fp16',
    'slat_flow_img2shape_dit_1_3B_1024_bf16',
    'slat_flow_img2shape_dit_1_3B_512_bf16',
    'slat_flow_imgshape2tex_dit_1_3B_1024_bf16',
    'slat_flow_imgshape2tex_dit_1_3B_512_bf16',
    'ss_flow_img_dit_1_3B_64_bf16',
    'tex_dec_next_dc_f16c32_fp16',
)
# Freeze both model repositories so a later upstream update cannot silently
# combine checkpoints from incompatible revisions. See docs/MODEL_SOURCES.md.
REPOS = (
    ('microsoft/TRELLIS.2-4B', 'af44b45f2e35a493886929c6d786e563ec68364d',
     ROOT / 'models' / 'TRELLIS.2-4B',
     {'pipeline.json'} | {f'ckpts/{name}.{ext}' for name in NAMES for ext in ('json', 'safetensors')}),
    ('microsoft/TRELLIS-image-large', '25e0d31ffbebe4b5a97464dd851910efc3002d96',
     ROOT / 'models' / 'TRELLIS-image-large',
     {f'ckpts/ss_dec_conv3d_16l8_fp16.{ext}' for ext in ('json', 'safetensors')}),
)


def verify(path, metadata):
    """Verify LFS SHA-256 or the git blob hash published by Hugging Face."""
    if path.stat().st_size != metadata.size:
        return False
    digest = hashlib.sha256() if metadata.lfs else hashlib.sha1()
    if not metadata.lfs:
        digest.update(f'blob {metadata.size}\0'.encode())
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    expected = metadata.lfs.sha256 if metadata.lfs else metadata.blob_id
    return bool(expected) and digest.hexdigest() == expected


def main():
    api = HfApi()
    for repo, revision, destination, wanted in REPOS:
        info = api.model_info(repo, revision=revision, files_metadata=True, token=False)
        files = {item.rfilename: item for item in info.siblings if item.rfilename in wanted}
        missing = wanted - files.keys()
        if missing:
            raise RuntimeError(f'{repo}: pinned revision is missing {sorted(missing)}')
        print(f'{repo}: {len(files)} files; {sum(item.size for item in files.values()):,} bytes', flush=True)
        for name in sorted(wanted):
            metadata = files[name]
            target = destination / name
            if target.exists():
                print(f'Checking existing {target}', flush=True)
                if not verify(target, metadata):
                    raise RuntimeError(f'Existing file has unexpected content; left untouched: {target}')
                continue
            print(f'Downloading {repo}/{name} ({metadata.size:,} bytes)', flush=True)
            path = Path(hf_hub_download(repo_id=repo, filename=name, revision=revision,
                                        local_dir=destination, token=False))
            if not verify(path, metadata):
                raise RuntimeError(f'Download failed verification; left for inspection: {path}')
            print(f'Verified {name}', flush=True)
    print('Public TRELLIS.2 checkpoints verified. Gated DINOv3 is still required.', flush=True)


if __name__ == '__main__':
    main()
