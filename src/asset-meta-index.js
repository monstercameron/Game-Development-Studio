import { useEffect, useMemo, useState } from 'react';

// One request per project (and per change to its asset list) returns every asset's
// model and the start of its prompt. Failures leave the library working by name only.
export function useAssetMetaIndex(projectId, revision) {
  const [state, setState] = useState({ projectId: '', index: {} });
  useEffect(() => {
    if (!projectId) {
      return undefined;
    }
    const controller = new AbortController();
    fetch(`/api/projects/${encodeURIComponent(projectId)}/assets/details-index`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : { assets: {} }))
      .then((body) => setState({ projectId, index: body?.assets || {} }))
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, revision]);
  return state.projectId === projectId ? state.index : {};
}

// Full-text search of prompts and model names, run on the server (one query).
export function useMetaSearch(projectId, query, revision) {
  const needle = query.trim();
  const [state, setState] = useState({ key: '', paths: null });
  const key = projectId && needle ? `${projectId}\n${needle}\n${revision}` : '';
  useEffect(() => {
    if (!key) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/projects/${encodeURIComponent(projectId)}/assets/search?q=${encodeURIComponent(needle)}`,
        { signal: controller.signal },
      )
        .then((response) => (response.ok ? response.json() : { paths: [] }))
        .then((body) => setState({ key, paths: new Set(body?.paths || []) }))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, projectId, needle]);
  return useMemo(() => (state.key === key ? state.paths : null), [state, key]);
}

// Client-side fallback so typing filters instantly, before the server answers.
export function matchesMeta(summary, needle) {
  if (!summary || !needle) {
    return false;
  }
  const lowerNeedle = needle.toLowerCase();
  return (
    (summary.model || '').toLowerCase().includes(lowerNeedle) ||
    (summary.prompt || '').toLowerCase().includes(lowerNeedle)
  );
}
