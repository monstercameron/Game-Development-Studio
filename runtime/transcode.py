"""Native Windows asset conversion. Writes a new file; never changes the input."""

import json
import sys
import warnings
from pathlib import Path

# The conversion runtime may be an embedded Python that omits the script folder from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_log import get_logger  # noqa: E402

log = get_logger("transcode")


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
                log.info("transcode.gpu.unavailable", {"error": exc, "format": fmt})
                print("GPU JPEG encoding unavailable; using CPU: " + str(exc), file=sys.stderr)
        options = {"quality": quality} if fmt in ("jpeg", "webp") else {}
        if fmt == "webp":
            options["lossless"] = True
            options.pop("quality", None)
        picture.save(
            target,
            format={"jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "bmp": "BMP", "tga": "TGA"}[fmt],
            **options,
        )
    return "CPU"


def audio(source, target, fmt, quality):
    import soundfile as sf

    specs = {
        "wav": ("WAV", "PCM_24"),
        "flac": ("FLAC", "PCM_24"),
        "mp3": ("MP3", "MPEG_LAYER_III"),
        "ogg": ("OGG", "VORBIS"),
        "opus": ("OGG", "OPUS"),
    }
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
            with sf.SoundFile(
                target,
                "w",
                samplerate=48000,
                channels=original.channels,
                format=container,
                subtype=subtype,
                compression_level=1 - quality / 100,
            ) as output:
                for start in range(0, total, 8192):
                    positions = np.arange(start, min(start + 8192, total), dtype=np.float64) * (
                        rate / 48000
                    )
                    indices = np.floor(positions).astype(np.int64)[:, None] + offsets
                    weights = np.sinc((positions[:, None] - indices) * cutoff) * window
                    weights /= weights.sum(axis=1, keepdims=True)
                    indices = np.clip(indices, 0, count - 1)
                    low, high = int(indices.min()), int(indices.max())
                    original.seek(low)
                    samples = original.read(high - low + 1, dtype="float32", always_2d=True)
                    block = np.einsum(
                        "ij,ijk->ik", weights, samples[indices - low], optimize=True
                    ).astype("float32")
                    output.write(block)
        else:
            kwargs = (
                {"compression_level": 1 - quality / 100} if fmt in ("mp3", "ogg", "opus") else {}
            )
            with sf.SoundFile(
                target,
                "w",
                samplerate=rate,
                channels=original.channels,
                format=container,
                subtype=subtype,
                **kwargs,
            ) as output:
                while True:
                    block = original.read(65536, dtype="float32", always_2d=True)
                    if len(block) == 0:
                        break
                    output.write(block)
    return "CPU"


def video(source, target, fmt, quality):
    """Re-encode a clip for tools that cannot play WebM: H.264 + AAC MP4, or a looping GIF."""
    from fractions import Fraction

    import av

    if fmt == "gif":
        from PIL import Image

        frames = []
        with av.open(source) as src:
            stream = src.streams.video[0]
            step = max(1, round(float(stream.average_rate or 24) / 12))
            for index, decoded in enumerate(src.decode(stream)):
                if index % step or len(frames) >= 300:
                    continue
                picture = decoded.to_image().convert("RGB")
                scale = min(1.0, 480 / picture.width)
                if scale < 1:
                    picture = picture.resize(
                        (round(picture.width * scale), round(picture.height * scale)),
                        Image.LANCZOS,
                    )
                frames.append(picture.quantize(colors=128, method=Image.Quantize.MEDIANCUT))
        if not frames:
            raise ValueError("The video has no frames.")
        frames[0].save(
            target,
            format="GIF",
            save_all=True,
            append_images=frames[1:],
            duration=round(1000 * step / 24),
            loop=0,
            optimize=True,
        )
        return "CPU (PyAV + Pillow)"
    crf = max(16, min(34, round(36 - quality * 0.18)))
    with av.open(source) as src:
        vin = src.streams.video[0]
        ain = src.streams.audio[0] if src.streams.audio else None
        rate = Fraction(vin.average_rate or 24).limit_denominator(1000)
        with av.open(target, "w", format="mp4", options={"movflags": "+faststart"}) as dst:
            vout = dst.add_stream("libx264", rate=rate)
            vout.width = vin.codec_context.width - vin.codec_context.width % 2
            vout.height = vin.codec_context.height - vin.codec_context.height % 2
            vout.pix_fmt = "yuv420p"
            vout.options = {"crf": str(crf), "preset": "medium"}
            sample_rate = (ain.rate if ain else 0) or 32000
            aout = dst.add_stream("aac", rate=sample_rate, layout="stereo") if ain else None
            resampler = (
                av.AudioResampler(format="fltp", layout="stereo", rate=sample_rate, frame_size=1024)
                if ain
                else None
            )
            count = samples = 0
            streams = [vin] + ([ain] if ain else [])
            for decoded in src.decode(*streams):
                if isinstance(decoded, av.VideoFrame):
                    out = decoded.reformat(width=vout.width, height=vout.height, format="yuv420p")
                    out.pts = count
                    out.time_base = 1 / rate
                    count += 1
                    dst.mux(vout.encode(out))
                else:
                    decoded.pts = None
                    for chunk in resampler.resample(decoded):
                        chunk.pts = samples
                        chunk.time_base = Fraction(1, sample_rate)
                        samples += chunk.samples
                        dst.mux(aout.encode(chunk))
            dst.mux(vout.encode(None))
            if aout:
                for chunk in resampler.resample(None):
                    chunk.pts = samples
                    chunk.time_base = Fraction(1, sample_rate)
                    samples += chunk.samples
                    dst.mux(aout.encode(chunk))
                dst.mux(aout.encode(None))
    return "CPU (PyAV, x264)"


if __name__ == "__main__":
    try:
        config = json.loads(sys.stdin.read())
        if config["kind"] == "image":
            backend = image(
                config["source"],
                config["target"],
                config["format"],
                config["quality"],
                config["background"],
            )
        elif config["kind"] == "video":
            backend = video(config["source"], config["target"], config["format"], config["quality"])
        else:
            backend = audio(config["source"], config["target"], config["format"], config["quality"])
        print(json.dumps({"backend": backend}))
    except Exception as exc:
        log.error("transcode.conversion.failed", {"error": exc})
        print(str(exc), file=sys.stderr)
        sys.exit(1)
