// Detects whether a picture already has a real transparent background, in the browser, so the 3D
// page can skip background removal. The rule matches the TRELLIS.2 worker: at least 1% of the
// pixels must be mostly transparent and some pixels must be clearly visible.
export const TRANSPARENT_FRACTION = 0.01;
const SAMPLE_SIDE = 256;

/**
 * @param {ArrayLike<number>} rgba RGBA bytes (4 per pixel)
 * @returns {{status: 'transparent'|'opaque', transparentFraction: number}}
 */
export function analyzeAlpha(rgba) {
  const pixels = Math.floor(rgba.length / 4);
  if (!pixels) {
    return { status: 'opaque', transparentFraction: 0 };
  }
  let transparent = 0,
    visible = 0;
  for (let index = 3; index < pixels * 4; index += 4) {
    const alpha = rgba[index];
    if (alpha < 128) {
      transparent += 1;
    }
    if (alpha > 204) {
      visible += 1;
    }
  }
  const transparentFraction = transparent / pixels;
  return {
    status: transparentFraction >= TRANSPARENT_FRACTION && visible >= 4 ? 'transparent' : 'opaque',
    transparentFraction,
  };
}

// 'unknown' means the browser could not decode or inspect the file; the caller should not block.
export async function measureTransparency(file) {
  if (!file) {
    return { status: 'unknown', transparentFraction: 0 };
  }
  // JPEG has no alpha channel at all.
  if (/^image\/jpe?g$/i.test(file.type || '') || /\.jpe?g$/i.test(file.name || '')) {
    return { status: 'opaque', transparentFraction: 0 };
  }
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      return { status: 'unknown', transparentFraction: 0 };
    }
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, SAMPLE_SIDE / Math.max(bitmap.width, bitmap.height, 1));
      const width = Math.max(1, Math.round(bitmap.width * scale)),
        height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        return { status: 'unknown', transparentFraction: 0 };
      }
      context.drawImage(bitmap, 0, 0, width, height);
      return analyzeAlpha(context.getImageData(0, 0, width, height).data);
    } finally {
      bitmap.close?.();
    }
  } catch {
    return { status: 'unknown', transparentFraction: 0 };
  }
}

// Identity of a chosen file, so a stored result is only used for the file it was measured on.
export function fileKey(file) {
  return file ? `${file.name}:${file.size}:${file.lastModified ?? 0}` : '';
}

// The stored measurement for `file`, or 'unknown' when there is none or it belongs to another file.
export function alphaStatusFor(file, stored) {
  return file && stored && stored.key === fileKey(file) ? stored.status : 'unknown';
}
