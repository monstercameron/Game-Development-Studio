export function chatProjectKey(projectId) {
  return projectId || 'unassigned';
}

export function chatStorageKey(projectId) {
  return `forge-chat-v1:${chatProjectKey(projectId)}`;
}

export function normalizeSavedChats(chats) {
  return chats.map((chat) => ({
    ...chat,
    messages: (chat.messages || []).map((message) =>
      message.streamStatus === 'streaming' ? { ...message, streamStatus: 'interrupted' } : message,
    ),
  }));
}
