// The compact v1 endpoint cannot take a custom score or sampling overrides, so a request that sets
// them goes to the studio endpoint, with duration expressed as the song-token cap (25 tokens per second).
export function submission(request) {
  const { abc, temperature, top_p, top_k, repetition_penalty, ...rest } = request;
  const sampling = Object.fromEntries(
    Object.entries({ temperature, top_p, top_k, repetition_penalty }).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
  if (!abc && !Object.keys(sampling).length) {
    return { path: '/api/v1/jobs', payload: request };
  }
  const { duration_seconds, ...song } = rest;
  return {
    path: '/api/jobs',
    payload: {
      ...song,
      ...(abc ? { abc } : {}),
      semantic_sampling: {
        ...sampling,
        min_tokens: 0,
        max_tokens: Math.max(1, Math.round(duration_seconds * 25)),
      },
    },
  };
}

// The engine requests for a derived job, given the YuE2 track it found for the source job.
export function derivedSubmission(request, track) {
  if (typeof track !== 'string' || !track || track.length > 300) {
    throw Error('YuE2 did not report a track for the source render.');
  }
  if (request.operation === 'extend') {
    return {
      path: '/api/jobs/extend',
      payload: {
        track,
        add_seconds: request.add_seconds,
        seed: request.seed,
        ...(request.title ? { title: request.title } : {}),
        ...(request.lyrics_addition ? { lyrics_addition: request.lyrics_addition } : {}),
      },
    };
  }
  return {
    path: '/api/jobs/resynth',
    payload: {
      track,
      seed: request.seed,
      ...(request.title ? { title: request.title } : {}),
      ...(request.ode_steps ? { ode_steps: request.ode_steps } : {}),
    },
  };
}

// YuE2 names a finished track in its job record; extend and resynth refer to that track.
export async function sourceTrack(baseUrl, remoteId, fetcher = fetch) {
  const response = await fetcher(`${baseUrl}/api/v1/jobs/${encodeURIComponent(remoteId)}`, {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw Error(`YuE2 returned ${response.status} for the source render.`);
  }
  const state = await response.json();
  if (state.status !== 'done' || typeof state.track !== 'string' || !state.track) {
    throw Error('YuE2 no longer has the finished source track.');
  }
  return state.track;
}
