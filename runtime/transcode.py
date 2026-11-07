"""Native Windows asset conversion. Writes a new file; never changes the input."""
import json
import os
import sys
import warnings


def image(source, target, fmt, quality, background):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 100_000_000
    with Image.open(source) as opened:
        opened.seek(0)
        picture = ImageOps.exif_transpose(opened)
        picture.load()
        if fmt in ("jpeg", "bmp"):
            rgba = picture.convert("RGBA")
            canvas = Image.new("RGBA", rgba.size, background + "ff")
            picture = Image.alpha_composite(canvas, rgba).convert("RGB")
        elif picture.mode not in ("RGB", "RGBA", "L", "LA"):
            picture = picture.convert("RGBA")
        if fmt == "jpeg":
            # torchvision uses NVIDIA's nvJPEG for CUDA tensors. Import it only
            # for JPEG so other conversions don't load a GPU runtime unnecessarily.
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    import torch
                    from torchvision.io import encode_jpeg
                import numpy as np
                if torch.cuda.is_available():
                    pixels = np.array(picture.convert("RGB"), copy=True)
                    tensor = torch.from_numpy(pixels).permute(2, 0, 1).contiguous().to("cuda")
                    encoded = encode_jpeg(tensor, quality=quality).cpu().numpy().tobytes()
                    with open(target, "wb") as out:
                        out.write(encoded)
                    return "NVIDIA GPU (nvJPEG)"
            except Exception as exc:
                print("GPU JPEG encoding unavailable; using CPU: " + str(exc), file=sys.stderr)
        options = {"quality": quality} if fmt in ("jpeg", "webp") else {}
        if fmt == "webp":
            options["lossless"] = True
            options.pop("quality", None)
        picture.save(target, format={"jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "bmp": "BMP", "tga": "TGA"}[fmt], **options)
    return "CPU"


def audio(source, target, fmt, quality):
    import soundfile as sf
    specs = {"wav": ("WAV", "PCM_24"), "flac": ("FLAC", "PCM_24"),
             "mp3": ("MP3", "MPEG_LAYER_III"), "ogg": ("OGG", "VORBIS"), "opus": ("OGG", "OPUS")}
    container, subtype = specs[fmt]
    with sf.SoundFile(source) as original:
        # libsndfile's Opus encoder accepts only Opus's supported sample rates.
        rate = original.samplerate
        if fmt == "opus" and rate not in (8000, 12000, 16000, 24000, 48000):
            # Windowed-sinc low-pass resampling in bounded blocks. Avoids loading
            # an entire soundtrack in memory and filters when downsampling.
            import numpy as np
            count = len(original)
            if not count:
                raise ValueError("The audio file is empty.")
            total = round(count * 48000 / rate)
            offsets = np.arange(-15, 17)
            window = np.kaiser(32, 8.0)
            cutoff = min(1.0, 48000 / rate)
            with sf.SoundFile(target, "w", samplerate=48000, channels=original.channels,
                              format=container, subtype=subtype, compression_level=1-quality/100) as output:
                for start in range(0, total, 8192):
                    positions = np.arange(start, min(start + 8192, total), dtype=np.float64) * (rate / 48000)
                    indices = np.floor(positions).astype(np.int64)[:, None] + offsets
                    weights = np.sinc((positions[:, None] - indices) * cutoff) * window
                    weights /= weights.sum(axis=1, keepdims=True)
                    indices = np.clip(indices, 0, count - 1)
                    low, high = int(indices.min()), int(indices.max())
                    original.seek(low)
                    samples = original.read(high - low + 1, dtype="float32", always_2d=True)
                    block = np.einsum('ij,ijk->ik', weights, samples[indices - low], optimize=True).astype('float32')
                    output.write(block)
        else:
            kwargs = {"compression_level": 1-quality/100} if fmt in ("mp3", "ogg", "opus") else {}
            with sf.SoundFile(target, "w", samplerate=rate, channels=original.channels,
                              format=container, subtype=subtype, **kwargs) as output:
                while True:
                    block = original.read(65536, dtype="float32", always_2d=True)
                    if len(block) == 0:
                        break
                    output.write(block)
    return "CPU"


if __name__ == "__main__":
    try:
        config = json.loads(sys.stdin.read())
        if config["kind"] == "image":
            backend = image(config["source"], config["target"], config["format"], config["quality"], config["background"])
        else:
            backend = audio(config["source"], config["target"], config["format"], config["quality"])
        print(json.dumps({"backend": backend}))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
