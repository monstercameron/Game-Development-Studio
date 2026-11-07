export function chatProjectKey(projectId) {
  return projectId || 'unassigned';
}

export function chatStorageKey(projectId) {
  return `forge-chat-v1:${chatProjectKey(projectId)}`;
}
