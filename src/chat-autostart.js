import { createLog } from './app-log.js';

const log = createLog('chat');

// Only the studio-owned local Qwen alias is started automatically. Compatible
// servers at other addresses (and other model IDs) remain user managed.
/**
 * Returns true only for the loopback endpoint that the studio launches itself.
 * Any other provider, model or address returns false and is never auto-started.
 *
 * @param {{ provider: string, endpoint: string, model: string }} settings
 * @returns {boolean} false for a malformed endpoint instead of throwing.
 */
export function isStudioQwen({ provider, endpoint, model }) {
  if (provider !== 'compatible' || model !== 'qwen3.8-27b') {
    return false;
  }
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.port === '8098' &&
      url.pathname.replace(/\/+$/, '') === '/v1' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
    // log-coverage: ignore -- pure check called during render (Chat.jsx); a bad URL is not a fault.
  } catch {
    return false;
  }
}
const aborted = () => new DOMException('Message cancelled.', 'AbortError');
// Resolves after ms milliseconds. Rejects with an AbortError as soon as the signal aborts,
// so a cancelled message never waits out the remaining polling interval.
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

/**
 * Makes sure the studio-owned Qwen server is answering before a chat message is sent.
 * Starts it when it is not running and polls until it is ready. Resolves without action
 * for any endpoint that isStudioQwen does not accept.
 *
 * @param {object} options
 * @param {object} options.connection Provider settings passed to isStudioQwen.
 * @param {string} options.model Model id to check.
 * @param {(signal?: AbortSignal) => Promise<void>} options.probe Rejects while not ready.
 * @param {(signal?: AbortSignal) => Promise<void>} options.start Requests the model start.
 * @param {(signal?: AbortSignal) => Promise<boolean>} options.isLoading Reports an active load.
 * @param {AbortSignal} [options.signal] Cancels the wait; rejects with AbortError.
 * @param {(text: string) => void} [options.onStatus] Receives user-visible progress text.
 * @param {number} [options.timeoutMs=600000] Maximum wait for the model to load, in ms.
 * @throws {Error} When the model stops loading, the wait times out, or an unexpected
 *   probe error occurs. The message is shown to the user.
 */
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
    log.debug('chat.autostart.skipped', { reason: 'not_studio_qwen' });
    return;
  }
  if (signal?.aborted) {
    throw aborted();
  }
  try {
    await probe(signal);
    log.debug('chat.autostart.ready', { reason: 'already_running' });
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
    log.info('chat.autostart.requested', { reason: 'not_running' });
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
      log.debug('chat.autostart.start.failed', {
        reason: 'another_request_loading',
        errorClass: error?.name || 'Error',
      });
    }
  }
  onStatus('Loading Qwen on the GPU. Your message will send when it is ready...');
  const started = now();
  while (now() - started < timeoutMs) {
    await sleep(2000, signal);
    try {
      await probe(signal);
      log.info('chat.autostart.ready', {
        reason: 'loaded_after_start',
        durationMs: now() - started,
      });
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
        log.warn('chat.autostart.failed', {
          reason: 'not_loading',
          durationMs: now() - started,
        });
        throw Error(
          'Qwen did not become ready. Check its engine logs in Diagnostics, then retry your message.',
        );
      }
    }
  }
  log.warn('chat.autostart.failed', { reason: 'timeout', durationMs: now() - started });
  throw Error(
    'Qwen is taking longer than expected to load. Check Diagnostics, then retry your message.',
  );
}
