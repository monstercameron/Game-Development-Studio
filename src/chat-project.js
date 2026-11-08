import { createLog } from './app-log.js';

const log = createLog('chat');

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

/**
 * Keeps the conversations that have the expected shape. A damaged entry (not an object, no id, a
 * message list that is not a list) is dropped instead of discarding every saved conversation.
 */
export function sanitizeSavedChatList(chats) {
  if (!Array.isArray(chats)) {
    return [];
  }
  return chats
    .filter(
      (chat) =>
        chat !== null &&
        typeof chat === 'object' &&
        !Array.isArray(chat) &&
        typeof chat.id === 'string' &&
        Array.isArray(chat.messages),
    )
    .map((chat) => ({
      ...chat,
      title: typeof chat.title === 'string' ? chat.title : 'New conversation',
      messages: chat.messages.filter(
        (message) =>
          message !== null &&
          typeof message === 'object' &&
          !Array.isArray(message) &&
          typeof message.role === 'string',
      ),
    }));
}

// The message being typed. It is kept for the whole browser, not per project, because the chat
// page is mounted again when the project resolves late or is switched, and typed text must
// survive that and a reload.
export const CHAT_DRAFT_KEY = 'forge-chat-draft-v1';
const MAX_CHAT_DRAFT_CHARS = 20000;

export function readChatDraft(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(CHAT_DRAFT_KEY));
    return typeof value?.text === 'string' ? value.text.slice(0, MAX_CHAT_DRAFT_CHARS) : '';
    // log-coverage: ignore -- read in a useState initializer during render; no logging there.
  } catch {
    return '';
  }
}

let isDraftWriteFailureLogged = false;

export function writeChatDraft(text, storage = globalThis.localStorage) {
  try {
    if (!text) {
      storage?.removeItem(CHAT_DRAFT_KEY);
    } else {
      storage?.setItem(
        CHAT_DRAFT_KEY,
        JSON.stringify({ text: String(text).slice(0, MAX_CHAT_DRAFT_CHARS), savedAt: Date.now() }),
      );
    }
  } catch (error) {
    // Storage can be full or blocked; the text is still in the composer.
    if (!isDraftWriteFailureLogged) {
      isDraftWriteFailureLogged = true;
      log.debug('chat.draft.write.failed', {
        target: CHAT_DRAFT_KEY,
        errorClass: error?.name || 'Error',
      });
    }
  }
}
