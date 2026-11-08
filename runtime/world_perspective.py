"""Restore perspective rays for WorldGen's Windows single-image adapter."""

import math


def perspective_rays(height, width, *, device, torch_module, horizontal_fov=90.0):
    """Assume a 90° horizontal field of view when a photo has no camera metadata.

    Returns unit direction rays shaped (height, width, 3) in camera space with z forward.
    """
    torch = torch_module
    half_fov_tangent = math.tan(math.radians(horizontal_fov) / 2)
    x = (
        (torch.arange(width, device=device, dtype=torch.float32) + 0.5) / width * 2 - 1
    ) * half_fov_tangent
    y = (
        ((torch.arange(height, device=device, dtype=torch.float32) + 0.5) / height * 2 - 1)
        * half_fov_tangent
        * height
        / width
    )
    yy, xx = torch.meshgrid(y, x, indexing="ij")
    rays = torch.stack((xx, yy, torch.ones_like(xx)), dim=-1)
    return torch.nn.functional.normalize(rays, dim=-1)


def install_perspective_projection(worldgen_module, torch_module):
    """Patch WorldGen in place so each depth prediction also carries perspective rays.

    Call once per module: a second call wraps the first wrapper.
    """
    original = worldgen_module.pred_depth

    def predict_with_perspective(model, image):
        prediction = original(model, image)
        height, width = prediction["rgb"].shape[:2]
        prediction["rays"] = perspective_rays(
            height, width, device=prediction["rgb"].device, torch_module=torch_module
        )
        return prediction

    def limit_image(image, max_size=1024):
        # Work on a copy so the caller's image is not resized in place; max_size is in pixels.
        image = image.copy()
        image.thumbnail((max_size, max_size))
        return image

    worldgen_module.pred_depth = predict_with_perspective
    worldgen_module.resize_img = limit_image
