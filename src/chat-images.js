import {
  CHAT_IMAGE_MAX_EDGE_PX,
  CHAT_IMAGE_SOURCE_MAX_BYTES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
} from '../runtime/chat-image-limits.js';

const THUMBNAIL_EDGE_PX = 96;

/**
 * Reads the picture type from the first bytes. The file name and the browser-reported type are
 * never trusted: a text file renamed to .png has to be refused here.
 * @param {Uint8Array} bytes The first bytes of the file (at least 12).
 * @returns {'image/png' | 'image/jpeg' | 'image/webp' | null}
 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) {
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((value, index) => bytes[index] === value)) {
    return 'image/png';
  }
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** @returns {{ width: number, height: number, scale: number }} Fit inside maxEdge, never enlarge. */
export function fitWithin(width, height, maxEdge = CHAT_IMAGE_MAX_EDGE_PX) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error('Could not read the picture.'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error('Could not encode the picture.'))),
      type,
      quality,
    );
  });
}

function drawn(bitmap, width, height, background) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

/**
 * Checks, decodes and shrinks one picture for sending.
 * JPEG pictures are always re-encoded, which applies their EXIF rotation and drops the metadata
 * (including any location). PNG and WebP pictures that already fit are sent unchanged.
 * @param {File} file
 * @returns {Promise<object>} The attachment; `dataUrl` is sent once and never saved.
 */
export async function prepareChatImage(file) {
  if (file.size > CHAT_IMAGE_SOURCE_MAX_BYTES) {
    throw Error(
      `${file.name} is larger than ${CHAT_IMAGE_SOURCE_MAX_BYTES / 1024 / 1024} MiB. Choose a smaller picture.`,
    );
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = sniffImageType(head);
  if (!type) {
    throw Error(`${file.name} is not a PNG, JPEG or WebP picture (checked by its contents).`);
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (cause) {
    throw Error(`${file.name} could not be decoded as a picture.`, { cause });
  }
  try {
    const fit = fitWithin(bitmap.width, bitmap.height);
    let blob = file;
    let mimeType = type;
    const mustEncode = type === 'image/jpeg' || fit.scale < 1 || file.size > MAX_CHAT_IMAGE_BYTES;
    if (mustEncode) {
      const keepsAlpha = type !== 'image/jpeg';
      mimeType = keepsAlpha ? 'image/png' : 'image/jpeg';
      blob = await canvasToBlob(
        drawn(bitmap, fit.width, fit.height, keepsAlpha ? null : '#ffffff'),
        mimeType,
        0.9,
      );
      if (blob.size > MAX_CHAT_IMAGE_BYTES) {
        mimeType = 'image/jpeg';
        blob = await canvasToBlob(drawn(bitmap, fit.width, fit.height, '#ffffff'), mimeType, 0.8);
      }
    }
    if (blob.size > MAX_CHAT_IMAGE_BYTES) {
      throw Error(
        `${file.name} is still larger than 8 MiB after shrinking. Choose another picture.`,
      );
    }
    const thumbFit = fitWithin(bitmap.width, bitmap.height, THUMBNAIL_EDGE_PX);
    const thumbBlob = await canvasToBlob(
      drawn(bitmap, thumbFit.width, thumbFit.height, '#ffffff'),
      'image/jpeg',
      0.7,
    );
    return {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType,
      bytes: blob.size,
      width: fit.width,
      height: fit.height,
      resized: fit.scale < 1,
      dataUrl: await readAsDataUrl(blob),
      thumb: await readAsDataUrl(thumbBlob),
      source: file.forgeSource || null,
    };
  } finally {
    bitmap.close?.();
  }
}

/** Throws when adding `incoming` pictures would pass the per-message count or total size limit. */
export function checkAttachmentRoom(current, incoming) {
  if (current.length + incoming.length > MAX_CHAT_IMAGES) {
    throw Error(`Attach up to ${MAX_CHAT_IMAGES} images per message.`);
  }
  const total = [...current, ...incoming].reduce((sum, image) => sum + image.bytes, 0);
  if (total > MAX_CHAT_IMAGES_TOTAL_BYTES) {
    throw Error(
      `The attached images total more than ${MAX_CHAT_IMAGES_TOTAL_BYTES / 1024 / 1024} MiB.`,
    );
  }
}

/** The small, savable form of an attachment: a thumbnail and where it came from, never the data. */
export function savedImageRecord(image) {
  return {
    name: String(image.name || 'image').slice(0, 200),
    thumb: image.thumb,
    ...(image.source ? { source: image.source } : {}),
  };
}

/**
 * Explains why picture input is unavailable, or returns an empty string when it can be used.
 * @param {{ isLocalQwen: boolean, vision: { available: boolean, message: string } | null }} state
 */
export function imageInputBlock({ isLocalQwen, vision }) {
  if (!isLocalQwen) {
    return 'Image input works only with the local Qwen engine. Choose it in Connection & model.';
  }
  if (!vision) {
    return 'Checking whether the Qwen server accepts images...';
  }
  return vision.available ? '' : vision.message;
}
