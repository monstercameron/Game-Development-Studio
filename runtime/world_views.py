"""Prepare HY-World input views and explain why a reconstruction was skipped."""

import re
from pathlib import Path

from PIL import Image

# Views whose proportions differ by more than this are cropped to match the first one.
SHAPE_TOLERANCE = 0.01
# A very large first view would otherwise make every other view huge too.
LONGEST_SIDE = 1536


def normalize_views(sources, destination):
    """Write the views as numbered PNGs that all share the first view's shape.

    WorldMirror rejects views of different proportions, so any view that differs is
    centre-cropped to the first view's proportions. Every view is then resized to
    one common size. Returns the indexes of the views that had to be cropped.
    """
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    size = None
    cropped = []
    for index, source in enumerate(sources):
        with Image.open(source) as opened:
            image = opened.convert("RGB")
        if size is None:
            scale = min(1.0, LONGEST_SIDE / max(image.size))
            size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        wanted = size[0] / size[1]
        actual = image.width / image.height
        if abs(actual / wanted - 1) > SHAPE_TOLERANCE:
            if actual > wanted:
                width = round(image.height * wanted)
                left = (image.width - width) // 2
                image = image.crop((left, 0, left + width, image.height))
            else:
                height = round(image.width / wanted)
                top = (image.height - height) // 2
                image = image.crop((0, top, image.width, top + height))
            cropped.append(index)
        if image.size != size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        image.save(destination / f"{index:03d}.png")
    return cropped


def skip_reason(log_text):
    """The reason HY-World printed when it skipped a scene, or None."""
    match = re.search(r"\[Pipeline\] Skipping .*?: (.+)", log_text)
    return match.group(1).strip() if match else None


class Tee:
    """Pass output through while keeping a copy to search afterwards."""

    def __init__(self, stream):
        self.stream = stream
        self.text = ""

    def write(self, value):
        self.text += value
        return self.stream.write(value)

    def flush(self):
        self.stream.flush()
