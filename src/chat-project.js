export function chatProjectKey(projectId) {
  return projectId || 'unassigned';
}

export function chatStorageKey(projectId) {
  return `forge-chat-v1:${chatProjectKey(projectId)}`;
}

// Saved history keeps a small thumbnail and where the picture came from, never the picture itself.
const MAX_SAVED_THUMBNAIL_CHARS = 60000;
const MAX_SAVED_IMAGES = 4;

export function sanitizeSavedImages(images) {
  if (!Array.isArray(images)) {
    return [];
  }
  return images.slice(0, MAX_SAVED_IMAGES).map((image) => {
    const thumb =
      typeof image?.thumb === 'string' &&
      image.thumb.startsWith('data:image/jpeg;base64,') &&
      image.thumb.length <= MAX_SAVED_THUMBNAIL_CHARS
        ? image.thumb
        : '';
    const source =
      typeof image?.source?.projectId === 'string' && typeof image.source.path === 'string'
        ? { projectId: image.source.projectId, path: image.source.path }
        : null;
    return {
      name: String(image?.name || 'image').slice(0, 200),
      thumb,
      ...(source ? { source } : {}),
    };
  });
}

function savedMessage(message) {
  if (message.images === undefined) {
    return message;
  }
  const { images, ...rest } = message;
  const kept = sanitizeSavedImages(images);
  return kept.length ? { ...rest, images: kept } : rest;
}

/** The form of the conversations written to browser storage. */
export function chatsForStorage(chats) {
  return chats.map((chat) => ({ ...chat, messages: (chat.messages || []).map(savedMessage) }));
}

export function normalizeSavedChats(chats) {
  return chatsForStorage(chats).map((chat) => ({
    ...chat,
    messages: chat.messages.map((message) =>
      message.streamStatus === 'streaming' ? { ...message, streamStatus: 'interrupted' } : message,
    ),
  }));
}
