import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_PROJECTOR_MIB } from './chat-image-limits.js';
import { createLogger } from './app-log.js';

const log = createLogger('chat');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The BF16 multimodal projector that ships beside the Qwen3.8-27B GGUF. Its size is the file
// size on disk (about 0.93 GB); the GPU copy is expected to be about that large (see
// CHAT_PROJECTOR_MIB in chat-image-limits.js, which the browser also reads).
export const CHAT_PROJECTOR_PATH = path.join(
  root,
  'models',
  'Qwen3.8-27B-GGUF',
  'mmproj-Qwen3.8-27B-BF16.gguf',
);
export { CHAT_PROJECTOR_MIB };

/** @returns {boolean} True when the projector file exists and is not empty. */
export function chatProjectorExists(projectorPath = CHAT_PROJECTOR_PATH) {
  const hasProjector = projectorFileIsPresent(projectorPath);
  log.debug('chat.vision.projector.checked', { hasProjector });
  return hasProjector;
}

function projectorFileIsPresent(projectorPath) {
  try {
    return existsSync(projectorPath) && statSync(projectorPath).size > 0;
  } catch (error) {
    // A missing or unreadable projector means text-only chat, which is a normal state.
    log.debug('chat.vision.projector.stat.failed', { error });
    return false;
  }
}

/**
 * Asks a llama.cpp server which input types it accepts. The answer comes from the running
 * server's /props, never from which files exist on disk.
 * @param {URL} propsUrl The server's /props URL.
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ reachable: boolean, vision: boolean | null }>}
 */
export async function readServerVision(propsUrl, fetchImpl = fetch, signal) {
  const stop = log.time('chat.vision.props.completed', { route: '/props' });
  try {
    const response = await fetchImpl(propsUrl, {
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(3000),
    });
    stop({ status: response.status });
    if (!response.ok) {
      return { reachable: true, vision: null };
    }
    const props = await response.json();
    const vision = props?.modalities?.vision;
    return { reachable: true, vision: typeof vision === 'boolean' ? vision : null };
  } catch (error) {
    // An unreachable server is expected while the chat model is stopped.
    log.debug('chat.vision.props.failed', { route: '/props', error });
    return { reachable: false, vision: null };
  }
}
