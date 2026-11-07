"""Download the approved DINOv3 dependency; receive the token only on stdin."""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "forge_trellis_download", ROOT / "runtime" / "trellis-download.py"
)
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
# Loading the shared downloader first configures Hugging Face cache/privacy.
from huggingface_hub import HfApi, hf_hub_download  # noqa: E402

REPO = "facebook/dinov3-vitl16-pretrain-lvd1689m"
REVISION = "ea8dc2863c51be0a264bab82070e3e8836b02d51"
WANTED = {"config.json", "model.safetensors", "preprocessor_config.json"}
DESTINATION = ROOT / "models" / "dinov3-vitl16-pretrain-lvd1689m"


def main(token):
    info = HfApi().model_info(REPO, revision=REVISION, files_metadata=True, token=token)
    files = {item.rfilename: item for item in info.siblings if item.rfilename in WANTED}
    if WANTED - files.keys():
        raise RuntimeError("The pinned DINOv3 revision is missing required files.")
    for name in sorted(WANTED):
        target = DESTINATION / name
        item = files[name]
        if target.exists():
            print(f"Checking existing {name}", flush=True)
            if not common.verify(target, item):
                raise RuntimeError(f"Existing file has unexpected content; left untouched: {name}")
            continue
        print(f"Downloading {name} ({item.size:,} bytes)", flush=True)
        downloaded = Path(
            hf_hub_download(
                repo_id=REPO, filename=name, revision=REVISION, local_dir=DESTINATION, token=token
            )
        )
        if not common.verify(downloaded, item):
            raise RuntimeError(f"Download failed verification; left for inspection: {name}")
        print(f"Verified {name}", flush=True)
    print("DINOv3 checkpoints verified.", flush=True)


if __name__ == "__main__":
    token = sys.stdin.readline().strip()
    if not token:
        sys.exit("No Hugging Face token was provided.")
    try:
        main(token)
    except Exception as error:
        # Never echo the credential even if an upstream exception contains it.
        print(f"DINOv3 download failed: {str(error).replace(token, '[redacted]')}", file=sys.stderr)
        sys.exit(1)
