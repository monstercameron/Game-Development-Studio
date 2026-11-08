// Browser client for Forge's same-origin PCM16 transcription proxy.
import { createLog } from './app-log.js';

const log = createLog('asr');

// Byte limits for one session. Units are bytes; the names say what each limit bounds.
const MAX_FRAME_BYTES = 1024 * 1024;
// Caps audio queued in the socket but not yet sent, so a slow service cannot grow memory
// without bound.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MIN_SAMPLE_RATE_HZ = 8000;
const MAX_SAMPLE_RATE_HZ = 96000;

/**
 * Opens a transcription session on the same-origin PCM16 proxy.
 *
 * Call send() with ArrayBuffer audio frames, then commit() once. done resolves with the
 * final transcript event after the commit. ready and done reject on service errors, socket
 * failure, timeouts or cancel(). send() and commit() throw synchronously when the session is
 * not accepting audio or a frame is invalid.
 *
 * @param {object} options
 * @param {string} options.url WebSocket URL of the proxy.
 * @param {number} options.sampleRate Integer sample rate in Hz, from 8000 to 96000.
 * @param {object} [options.session] Extra fields merged into the session.update event.
 * @param {(delta: string) => void} [options.onDelta] Receives partial transcript text.
 * @param {(transcript: string) => void} [options.onFinal] Receives each completed transcript.
 * @param {number} [options.timeoutMs] Maximum wait, in ms, for the session to become ready.
 * @param {number} [options.completionTimeoutMs] Maximum wait, in ms, after commit().
 * @returns {{ready: Promise<void>, done: Promise<object>, send: Function,
 *   commit: Function, cancel: Function}}
 */
export function openAsrStream({
  url,
  sampleRate,
  session = {},
  onDelta = () => {},
  onFinal = () => {},
  WebSocketImpl = WebSocket,
  timeoutMs = 15000,
  completionTimeoutMs = 120000,
}) {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE_HZ ||
    sampleRate > MAX_SAMPLE_RATE_HZ
  ) {
    throw Error('Microphone sample rate must be between 8 and 96 kHz.');
  }
  const socket = new WebSocketImpl(url);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    log.info('asr.socket.opened');
  });
  let configured = false,
    committed = false,
    settled = false,
    total = 0,
    readyResolve,
    readyReject,
    doneResolve,
    doneReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  // Rejections also reach callers through ready and done. These no-op handlers only stop
  // an unawaited promise from being reported as unhandled.
  ready.catch(() => {});
  done.catch(() => {});
  let timer = setTimeout(
    () => fail(Error('Speech session did not become ready.'), 'ready_timeout'),
    timeoutMs,
  );
  function fail(error, reason) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    log.warn('asr.session.failed', { reason, wasConfigured: configured, wasCommitted: committed });
    readyReject(error);
    doneReject(error);
    try {
      socket.close();
    } catch (closeError) {
      log.debug('asr.socket.close.failed', { errorClass: closeError?.name || 'Error' });
      // The socket may already be closed; the original failure is reported above.
    }
  }
  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      log.debug('asr.event.parse.failed', { errorClass: error?.name || 'Error' });
      return fail(Error('Speech service sent an invalid event.'), 'invalid_event');
    }
    try {
      if (data.type === 'session.created') {
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: { ...session, sample_rate: sampleRate },
          }),
        );
        return;
      }
      if (data.type === 'session.updated') {
        if (!configured) {
          configured = true;
          clearTimeout(timer);
          readyResolve();
          log.info('asr.session.ready');
        }
        return;
      }
      if (data.type === 'error') {
        return fail(
          Error(String(data.message || 'Speech service error.').slice(0, 500)),
          'service_error',
        );
      }
      if (data.type === 'conversation.item.input_audio_transcription.delta') {
        if (typeof data.delta === 'string') {
          onDelta(data.delta);
        }
        return;
      }
      if (data.type === 'conversation.item.input_audio_transcription.completed') {
        if (typeof data.transcript !== 'string') {
          return fail(
            Error('Speech service returned an invalid transcript.'),
            'invalid_transcript',
          );
        }
        onFinal(data.transcript);
        if (committed && !settled) {
          settled = true;
          clearTimeout(timer);
          log.info('asr.session.completed', { audioBytes: total });
          doneResolve(data);
          socket.close();
        }
      }
    } catch (error) {
      log.warn('asr.event.handler.failed', { errorClass: error?.name || 'Error' });
      fail(error instanceof Error ? error : Error('Speech session failed.'), 'handler_error');
    }
  });
  socket.addEventListener('error', () =>
    fail(Error('Could not connect to the speech service.'), 'socket_error'),
  );
  socket.addEventListener('close', () => {
    log.info('asr.socket.closed', { isSettled: settled });
    if (!settled) {
      fail(Error('Speech service disconnected before the transcript finished.'), 'socket_closed');
    }
  });
  return {
    ready,
    done,
    send(bytes) {
      if (!configured || committed || settled || socket.readyState !== 1) {
        throw Error('Speech session is not accepting audio.');
      }
      if (
        !(bytes instanceof ArrayBuffer) ||
        !bytes.byteLength ||
        bytes.byteLength % 2 ||
        bytes.byteLength > MAX_FRAME_BYTES
      ) {
        throw Error('Invalid microphone audio frame.');
      }
      if (socket.bufferedAmount + bytes.byteLength > MAX_BUFFERED_BYTES) {
        throw Error('Speech service is not consuming audio fast enough.');
      }
      if (total + bytes.byteLength > MAX_SESSION_BYTES) {
        throw Error('Speech session exceeded its audio limit.');
      }
      total += bytes.byteLength;
      socket.send(bytes);
    },
    commit() {
      if (!configured || committed || settled || socket.readyState !== 1) {
        throw Error('Speech session is not accepting audio.');
      }
      committed = true;
      // The ready timer was cleared once configured, so this timer bounds the final transcript.
      timer = setTimeout(
        () => fail(Error('Speech transcription did not finish in time.'), 'completion_timeout'),
        completionTimeoutMs,
      );
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    },
    cancel() {
      fail(Error('Speech session cancelled.'), 'cancelled');
    },
  };
}
