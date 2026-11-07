export async function saveProjectText(projectId, kind, content) {
  if (!projectId) {
    throw Error('Choose a project before saving.');
  }
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/assets/create-text`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
      body: JSON.stringify({ kind, content }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(body.error || 'Could not save this text.');
  }
  return body;
}
