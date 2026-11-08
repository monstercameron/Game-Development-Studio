"""Compatibility for loading WorldGen's local LoRA files with offline diffusers."""

import os
from pathlib import Path


def support_offline_lora(pipeline_class):
    """Patch pipeline_class.load_lora_weights in place to accept a local LoRA file path.

    Diffusers expects a folder plus weight_name, so a single .safetensors path is split
    into those two parts. Other sources pass through unchanged.
    """
    original = pipeline_class.load_lora_weights

    def load_local_lora(self, source, *args, **kwargs):
        if (
            isinstance(source, (str, os.PathLike))
            and Path(source).is_file()
            and "weight_name" not in kwargs
        ):
            source = Path(source)
            kwargs["weight_name"] = source.name
            source = str(source.parent)
        return original(self, source, *args, **kwargs)

    pipeline_class.load_lora_weights = load_local_lora
