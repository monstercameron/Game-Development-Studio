"""Prepare reference inputs for MiniMax H3 (sd-cli) without loading any model.

Reads one JSON request on stdin and writes one JSON result on stdout. It only decodes media
with PyAV and Pillow (the same runtime the asset converter uses); it never touches the GPU.

Tasks:
  frame       Crop-resize a first or last frame image to the exact render size (PNG).
  clip_frames Decode a video to PNG frames at 24 fps, cropped to the render size.
  clip_audio  Decode audio (or a video's soundtrack) to a 32 kHz stereo 16-bit WAV.
"""

import json
import os
import sys
import wave

FPS = 24
SAMPLE_RATE = 32000
MIN_FRAMES = 5
MIN_AUDIO_SECONDS = 0.5


def cover(image, width, height):
    """Scale to cover the target and crop the centre, so nothing is stretched."""
    from PIL import Image

    scale = max(width / image.width, height / image.height)
    size = (max(width, round(image.width * scale)), max(height, round(image.height * scale)))
    image = image.resize(size, Image.LANCZOS)
    left, top = (size[0] - width) // 2, (size[1] - height) // 2
    return image.crop((left, top, left + width, top + height))


def flatten(image):
    from PIL import Image

    rgba = image.convert("RGBA")
    canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(canvas, rgba).convert("RGB")


def frame(task):
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 100_000_000
    with Image.open(task["source"]) as opened:
        opened.seek(0)
        picture = ImageOps.exif_transpose(opened)
        picture.load()
    cover(flatten(picture), task["width"], task["height"]).save(task["target"], format="PNG")
    return {"width": task["width"], "height": task["height"]}


def usable_frames(count):
    """The largest 17 * k + 5 frame count that fits (MiniMax's frame rule)."""
    return 0 if count < MIN_FRAMES else 17 * ((count - MIN_FRAMES) // 17) + MIN_FRAMES


def clip_frames(task):
    import av

    directory = task["directory"]
    os.makedirs(directory, exist_ok=True)
    width, height, limit = task["width"], task["height"], task["max_frames"]
    written = 0
    with av.open(task["source"]) as container:
        if not container.streams.video:
            raise ValueError("The reference video has no picture track.")
        stream = container.streams.video[0]
        has_audio = bool(container.streams.audio)
        origin = None
        previous = None

        def emit(source):
            nonlocal written
            cover(flatten(source.to_image()), width, height).save(
                os.path.join(directory, f"{written:05d}.png"), format="PNG"
            )
            written += 1

        for decoded in container.decode(stream):
            if decoded.pts is None:
                continue
            seconds = float(decoded.pts * stream.time_base)
            origin = seconds if origin is None else origin
            seconds -= origin
            # Output frame n is shown at n / 24 s: use the nearest decoded picture.
            while written < limit and previous is not None and written / FPS < seconds - 0.5 / FPS:
                emit(previous)
            previous = decoded
            if written >= limit:
                break
        if previous is not None and written < limit:
            emit(previous)
    keep = usable_frames(written)
    if not keep:
        raise ValueError("The reference video needs at least 5 frames (about 0.2 seconds).")
    for index in range(keep, written):
        os.remove(os.path.join(directory, f"{index:05d}.png"))
    return {"frames": keep, "seconds": round(keep / FPS, 2), "has_audio": has_audio}


def clip_audio(task):
    import av

    limit = int(task["max_seconds"] * SAMPLE_RATE)
    samples = 0
    with av.open(task["source"]) as container:
        if not container.streams.audio:
            return {"has_audio": False}
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="stereo", rate=SAMPLE_RATE)
        with wave.open(task["target"], "wb") as out:
            out.setnchannels(2)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)

            def write(frames):
                nonlocal samples
                for item in frames:
                    if samples >= limit:
                        return
                    data = item.to_ndarray().tobytes()
                    count = min(len(data) // 4, limit - samples)
                    out.writeframes(data[: count * 4])
                    samples += count

            for decoded in container.decode(stream):
                write(resampler.resample(decoded))
                if samples >= limit:
                    break
            if samples < limit:
                write(resampler.resample(None))
    seconds = samples / SAMPLE_RATE
    if seconds < MIN_AUDIO_SECONDS:
        raise ValueError("The reference audio must be at least half a second long.")
    return {"has_audio": True, "seconds": round(seconds, 2)}


OPERATIONS = {"frame": frame, "clip_frames": clip_frames, "clip_audio": clip_audio}

if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read())
        results = []
        for item in request["tasks"]:
            results.append(OPERATIONS[item["op"]](item))
        print(json.dumps({"results": results}))
    except Exception as exc:
        print(str(exc) or exc.__class__.__name__, file=sys.stderr)
        sys.exit(1)
