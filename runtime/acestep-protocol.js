// ACE-Step 1.5 protocol at upstream commit ca1e85fe9430179831e6bc6be790c332190a3866.
// This module does not submit, poll, or download; callers own queue recovery and transport.
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function aceStepAcceptedTask(body) {
  const id = body?.data?.task_id;
  if (body?.code !== 200 || typeof id !== 'string' || !TASK_ID.test(id)) {
    throw new Error('ACE-Step submission outcome is unknown: no valid task ID was returned.');
  }
  return id;
}

export function aceStepTaskState(body, taskId) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new Error('Invalid ACE-Step task ID.');
  }
  const rows = body?.data;
  if (
    body?.code !== 200 ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.task_id !== taskId
  ) {
    return { status: 'unknown' };
  }
  const row = rows[0];
  let results;
  try {
    results = JSON.parse(row.result);
  } catch {
    return { status: 'unknown' };
  }
  if (
    !Array.isArray(results) ||
    results.length === 0 ||
    !results[0] ||
    typeof results[0] !== 'object'
  ) {
    // Upstream returns status 0 and [] for an ID it no longer knows.
    return { status: 'unknown' };
  }
  const first = results[0];
  if (row.status === 0 && first.status === 0) {
    return { status: 'running' };
  }
  if (row.status === 2 && first.status === 2 && typeof first.error === 'string' && first.error) {
    return { status: 'failed' };
  }
  if (row.status !== 1 || first.status !== 1 || results.length !== 1) {
    return { status: 'unknown' };
  }
  // Never follow an absolute URL or an arbitrary endpoint returned by an engine.
  if (typeof first.file !== 'string' || !first.file.startsWith('/v1/audio?')) {
    return { status: 'unknown' };
  }
  const url = new URL(first.file, 'http://localhost');
  if (
    url.origin !== 'http://localhost' ||
    url.pathname !== '/v1/audio' ||
    url.hash ||
    [...url.searchParams.keys()].length !== 1 ||
    !url.searchParams.get('path')
  ) {
    return { status: 'unknown' };
  }
  return { status: 'succeeded', audioPath: `${url.pathname}${url.search}` };
}
