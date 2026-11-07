"""Verify the native ARM64 image-processing build used for texture export."""
import cv2
import numpy as np

image = np.full((9, 9, 3), (42, 127, 210), dtype=np.uint8)
mask = np.zeros((9, 9), dtype=np.uint8)
mask[4, 4] = 255
image[4, 4] = 0
result = cv2.inpaint(image, mask, 2, cv2.INPAINT_TELEA)
assert result.shape == image.shape
np.testing.assert_array_less(np.abs(result[4, 4].astype(int) - np.array([42, 127, 210])), 2)
print(f'OpenCV {cv2.__version__} ARM64 texture inpainting passed.')
