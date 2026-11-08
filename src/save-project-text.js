// `provenance` records the model, prompt, and settings behind the text so they can be reused.
export async function saveProjectText(projectId, kind, content, provenance) {
  if (!projectId) {
    throw Error('Choose a project before saving.');
  }
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/assets/create-text`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
      body: JSON.stringify({ kind, content, ...(provenance ? { provenance } : {}) }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(body.error || 'Could not save this text.');
  }
  return body;
}
