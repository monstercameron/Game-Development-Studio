// Only the studio-owned local Qwen alias is started automatically. Compatible
// servers at other addresses (and other model IDs) remain user managed.
export function isStudioQwen({ provider, endpoint, model }) {
  if (provider !== 'compatible' || model !== 'qwen3.8-27b') {
    return false;
  }
  try {
    const u = new URL(endpoint);
    return (
      u.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(u.hostname) &&
      u.port === '8098' &&
      u.pathname.replace(/\/+$/, '') === '/v1' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
const aborted = () => new DOMException('Message cancelled.', 'AbortError');
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(aborted());
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(aborted());
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function ensureChatReady({
  connection,
  model,
  probe,
  start,
  isLoading,
  signal,
  onStatus = () => {},
  sleep = delay,
  now = Date.now,
  timeoutMs = 600000,
}) {
  if (!isStudioQwen({ ...connection, model })) {
    return;
  }
  if (signal?.aborted) {
    throw aborted();
  }
  try {
    await probe(signal);
    return;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error;
    }
    if (error.code !== 'server_unreachable' && error.status !== 503) {
      throw error;
    }
  }
  let loading = await isLoading(signal);
  if (!loading) {
    onStatus('Starting Qwen on the GPU...');
    try {
      await start(signal);
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) {
        throw error;
      }
      // Another request may have acquired the startup barrier in the meantime.
      if (!(await isLoading(signal))) {
        throw error;
      }
    }
  }
  onStatus('Loading Qwen on the GPU. Your message will send when it is ready...');
  const started = now();
  while (now() - started < timeoutMs) {
    await sleep(2000, signal);
    try {
      await probe(signal);
      return;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      if (error.code !== 'server_unreachable' && error.status !== 503) {
        throw error;
      }
    }
    if (now() - started > 15000) {
      loading = await isLoading(signal);
      if (!loading) {
        throw Error(
          'Qwen did not become ready. Check its engine logs in Diagnostics, then retry your message.',
        );
      }
    }
  }
  throw Error(
    'Qwen is taking longer than expected to load. Check Diagnostics, then retry your message.',
  );
}
