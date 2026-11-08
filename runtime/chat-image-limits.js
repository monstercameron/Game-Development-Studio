// Limits for chat image input. The browser, the HTTP boundary and the MCP tool share these
// numbers so they cannot drift. Sizes are bytes of the decoded image file, not base64 text.
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
// The browser shrinks larger pictures to this longest edge before sending (pixels).
export const CHAT_IMAGE_MAX_EDGE_PX = 1536;
// A picture picked in the browser may be larger than the upload limit because it is shrunk first.
export const CHAT_IMAGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
// Request body ceiling when images are attached: base64 inflates the images by about 4/3.
export const MAX_CHAT_IMAGE_REQUEST_CHARS =
  Math.ceil((MAX_CHAT_IMAGES_TOTAL_BYTES * 4) / 3) + 2_000_000;
// GPU memory estimate for the multimodal projector (the BF16 file is about 0.93 GB). Uncalibrated.
export const CHAT_PROJECTOR_MIB = 950;
export const CHAT_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
