import {
  CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
} from './chat-image-limits.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL = /^data:(image\/[a-z+.-]{1,20});base64,([A-Za-z0-9+/]+={0,2})$/;

/** Reads the image type from the first bytes. A file name or a claimed type is never trusted. */
export function sniffChatImage(bytes) {
  if (bytes.length < 12) {
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Decodes one base64 data URL and returns a normalised one built from the sniffed type.
 * @param {unknown} value A data URL string.
 * @param {number} index Zero-based position, used only in error text.
 * @returns {{ dataUrl: string, mimeType: string, bytes: number }}
 */
export function checkChatImage(value, index = 0) {
  const label = `Image ${index + 1}`;
  if (typeof value !== 'string' || value.length > Math.ceil((MAX_CHAT_IMAGE_BYTES * 4) / 3) + 64) {
    throw Error(
      `${label} is larger than ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MiB or is not a data URL.`,
    );
  }
  const match = DATA_URL.exec(value);
  if (!match || !CHAT_IMAGE_TYPES.includes(match[1]) || match[2].length % 4 !== 0) {
    throw Error(`${label} must be a base64 PNG, JPEG or WebP data URL.`);
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
    throw Error(`${label} is larger than ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MiB.`);
  }
  const mimeType = sniffChatImage(bytes);
  if (!mimeType) {
    throw Error(`${label} is not a PNG, JPEG or WebP picture (checked by its contents).`);
  }
  return { dataUrl: `data:${mimeType};base64,${match[2]}`, mimeType, bytes: bytes.length };
}

/**
 * Validates the image list of every message and returns the messages with the OpenAI-compatible
 * content-part form (text part first, then image_url parts). Messages without images are returned
 * unchanged, so text-only requests keep their plain string content.
 * @param {Array<{ role: string, content: string, images?: unknown }>} messages
 * @returns {{ messages: object[], imageCount: number, imageBytes: number }}
 */
export function buildImageMessages(messages) {
  let imageCount = 0;
  let imageBytes = 0;
  const built = messages.map((message) => {
    if (message.images === undefined) {
      return message;
    }
    const { images, ...rest } = message;
    if (!Array.isArray(images)) {
      throw Error('Images must be a list.');
    }
    if (!images.length) {
      return rest;
    }
    if (message.role !== 'user') {
      throw Error('Only user messages can include images.');
    }
    if (images.length > MAX_CHAT_IMAGES) {
      throw Error(`Attach up to ${MAX_CHAT_IMAGES} images per message.`);
    }
    const parts = images.map((image, index) => {
      const checked = checkChatImage(image, index);
      imageBytes += checked.bytes;
      return { type: 'image_url', image_url: { url: checked.dataUrl } };
    });
    imageCount += parts.length;
    if (imageBytes > MAX_CHAT_IMAGES_TOTAL_BYTES) {
      throw Error(
        `The attached images total more than ${MAX_CHAT_IMAGES_TOTAL_BYTES / 1024 / 1024} MiB.`,
      );
    }
    return { ...rest, content: [{ type: 'text', text: message.content }, ...parts] };
  });
  return { messages: built, imageCount, imageBytes };
}
