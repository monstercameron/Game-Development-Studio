/**
 * Saves generated or transcribed text as a project asset.
 *
 * @param {string} projectId Project that owns the asset; required.
 * @param {string} kind Asset kind label sent to the server.
 * @param {string} content Text body to store.
 * @param {object} [provenance] Model, prompt and settings behind the text, kept so the
 *   text can be reused. Omitted from the request when falsy.
 * @returns {Promise<object>} The parsed server response body.
 * @throws {Error} When no project is chosen, or when the server rejects the request.
 *   The message is the server error text when one is provided.
 */
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
