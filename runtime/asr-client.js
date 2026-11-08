import { createLogger } from './app-log.js';

const log = createLogger('asr');

// Narrow client for the local NeMo-Speech.cpp transcription service.
// Starting the model and GPU admission remain the caller's responsibility.
const MAX_WAV_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const TRANSCRIPTION_ROUTE = '/v1/audio/transcriptions';

// Milliseconds elapsed since a performance.now() reading, rounded for durationMs.
function elapsedMs(startedMs) {
  return Math.round(performance.now() - startedMs);
}

// Logs only the error class and code. Error messages can echo URLs, paths or payloads.
function errorFields(error) {
  const code = error?.cause?.code ?? error?.code;
  return {
    errorClass: String(error?.name || 'Error'),
    ...(typeof code === 'string' && code ? { errorCode: code } : {}),
  };
}

export function localAsrUrl(value = 'http://127.0.0.1:8282') {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    log.warn('asr.request.rejected', { reason: 'non_local_origin' });
    throw Error('Speech service must be a local HTTP origin.');
  }
  return url;
}
function pcmBytes(frame) {
  if (
    !(frame instanceof Uint8Array) ||
    frame.byteLength === 0 ||
    frame.byteLength % 2 ||
    frame.byteLength > MAX_FRAME_BYTES
  ) {
    log.warn('asr.frame.rejected', { reason: 'invalid_frame' });
    throw Error('Audio frames must contain 16-bit PCM samples and be at most 1 MiB.');
  }
  return frame;
}
// Optional per-request recognition settings, validated here so every caller shares the same limits.
// Word boosting is deliberately absent: the installed GGUF has no embedded tokenizer, so the engine
// ignores boost phrases.
export function recognitionOptions({ punctuation = true, wordTimestamps = false } = {}) {
  if (typeof punctuation !== 'boolean' || typeof wordTimestamps !== 'boolean') {
    log.warn('asr.request.rejected', { reason: 'invalid_options' });
    throw Error('Punctuation and word timestamps must be true or false.');
  }
  return { punctuation, wordTimestamps };
}
export async function transcribeWav(
  bytes,
  { baseUrl, timeoutMs = 120000, signal, fetcher = fetch, options } = {},
) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 44 ||
    bytes.byteLength > MAX_WAV_BYTES ||
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'RIFF' ||
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') !== 'WAVE'
  ) {
    log.warn('asr.request.rejected', { reason: 'invalid_wav' });
    throw Error('Provide a RIFF/WAVE file between 44 bytes and 32 MiB.');
  }
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  const settings = recognitionOptions(options);
  if (!settings.punctuation) {
    form.set('automatic_punctuation', 'false');
  }
  if (settings.wordTimestamps) {
    form.set('response_format', 'verbose_json');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestStartedMs = performance.now();
  const response = await fetcher(new URL(TRANSCRIPTION_ROUTE, localAsrUrl(baseUrl)), {
    method: 'POST',
    body: form,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
  }).catch((error) => {
    log.warn('asr.request.failed', {
      route: TRANSCRIPTION_ROUTE,
      durationMs: elapsedMs(requestStartedMs),
      ...errorFields(error),
    });
    throw error;
  });
  const durationMs = elapsedMs(requestStartedMs);
  const body = await response.json();
  if (!response.ok) {
    log.warn('asr.request.failed', {
      route: TRANSCRIPTION_ROUTE,
      httpStatus: response.status,
      durationMs,
    });
    throw Error(
      `Speech service returned HTTP ${response.status}: ${String(body?.error?.message || 'Transcription failed.').slice(0, 500)}`,
    );
  }
  if (typeof body?.text !== 'string') {
    log.warn('asr.response.rejected', {
      reason: 'invalid_transcript',
      httpStatus: response.status,
      durationMs,
    });
    throw Error('Speech service returned an invalid transcript.');
  }
  log.info('asr.request.completed', {
    route: TRANSCRIPTION_ROUTE,
    httpStatus: response.status,
    durationMs,
  });
  if (!settings.wordTimestamps) {
    return { text: body.text };
  }
  // Times come from the model's token timeline, not a forced aligner, so they are approximate.
  const words = Array.isArray(body.words)
    ? body.words
        .filter((word) => typeof word?.word === 'string' && Number.isFinite(word.start))
        .slice(0, 20000)
        .map((word) => ({
          word: word.word,
          start: Math.round(word.start * 1000) / 1000,
          end: Number.isFinite(word.end) ? Math.round(word.end * 1000) / 1000 : null,
        }))
    : [];
  return {
    text: body.text,
    words,
    ...(Number.isFinite(body.duration)
      ? { duration: Math.round(body.duration * 1000) / 1000 }
      : {}),
  };
}

// Emits the server's original partial and final events, without inventing
// timestamps or treating partial text as committed. Every session is isolated.
export function openTranscriptionStream({
  baseUrl,
  sampleRate = 16000,
  onEvent = () => {},
  WebSocketImpl = WebSocket,
  timeoutMs = 15000,
  completionTimeoutMs = 120000,
} = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
    throw Error('Sample rate must be 8000 to 96000 Hz.');
  }
  const url = localAsrUrl(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/audio/transcriptions/realtime';
  const socket = new WebSocketImpl(url);
  const streamStartedMs = performance.now();
  log.info('asr.stream.opened', { sampleRate });
  socket.binaryType = 'arraybuffer';
  let settled = false,
    configured = false,
    finished = false,
    closed = false,
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
  // A consumer can attach handlers after opening without triggering an unhandled rejection.
  ready.catch(() => {});
  done.catch(() => {});
  let timer = setTimeout(
    () => fail(Error('Speech session did not become ready.'), 'ready_timeout'),
    timeoutMs,
  );
  timer.unref?.();
  function fail(error, reason) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    const fields = { reason, ...errorFields(error), durationMs: elapsedMs(streamStartedMs) };
    if (reason === 'cancelled') {
      log.info('asr.stream.closed', fields);
    } else {
      log.warn('asr.stream.failed', fields);
    }
    readyReject(error);
    doneReject(error);
    try {
      socket.close();
    } catch (closeError) {
      log.debug('asr.stream.close.failed', errorFields(closeError));
      /* The socket may already be closed. */
    }
  }
  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      log.warn('asr.event.rejected', { reason: 'invalid_json' });
      return fail(Error('Speech service sent an invalid event.'), 'invalid_event');
    }
    if (data.type === 'session.created') {
      socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: sampleRate } }));
      return;
    }
    if (data.type === 'session.updated') {
      configured = true;
      clearTimeout(timer);
      readyResolve();
      return;
    }
    if (data.type === 'error') {
      return fail(
        Error(String(data.message || 'Speech service error.').slice(0, 500)),
        'service_error',
      );
    }
    if (
      data.type === 'conversation.item.input_audio_transcription.delta' ||
      data.type === 'conversation.item.input_audio_transcription.completed'
    ) {
      try {
        onEvent(data);
      } catch (error) {
        log.warn('asr.event.failed', { reason: 'handler_failed', ...errorFields(error) });
        return fail(
          error instanceof Error ? error : Error('Speech event handler failed.'),
          'handler_failed',
        );
      }
      if (data.type.endsWith('.completed') && finished && !settled) {
        settled = true;
        clearTimeout(timer);
        log.info('asr.stream.completed', {
          durationMs: elapsedMs(streamStartedMs),
          audioBytes: total,
        });
        doneResolve(data);
        socket.close();
      }
    }
  });
  socket.addEventListener('error', (event) => {
    log.warn('asr.stream.connection.failed', errorFields(event?.error));
    fail(Error('Speech service connection failed.'), 'connection_failed');
  });
  socket.addEventListener('close', () => {
    closed = true;
    if (!settled) {
      fail(
        Error('Speech service connection closed before transcription completed.'),
        'closed_early',
      );
    }
  });
  return {
    ready,
    done,
    send(frame) {
      if (!configured || settled || closed || finished || socket.readyState !== 1) {
        log.warn('asr.stream.rejected', { reason: 'not_accepting' });
        throw Error('Speech session is not accepting audio.');
      }
      const data = pcmBytes(frame);
      if (socket.bufferedAmount + data.byteLength > MAX_BUFFERED_BYTES) {
        log.warn('asr.stream.rejected', { reason: 'backpressure' });
        throw Error('Speech service is not consuming audio fast enough.');
      }
      if (total + data.byteLength > MAX_SESSION_BYTES) {
        log.warn('asr.stream.rejected', { reason: 'session_limit' });
        throw Error('Speech session audio exceeds 64 MiB.');
      }
      total += data.byteLength;
      log.debug('asr.stream.chunk.sent', { frameBytes: data.byteLength });
      socket.send(data);
    },
    commit() {
      if (!configured || settled || closed || finished || socket.readyState !== 1) {
        log.warn('asr.stream.rejected', { reason: 'not_accepting' });
        throw Error('Speech session is not accepting audio.');
      }
      finished = true;
      timer = setTimeout(
        () => fail(Error('Speech transcription did not finish in time.'), 'completion_timeout'),
        completionTimeoutMs,
      );
      timer.unref?.();
      log.info('asr.stream.committed', { audioBytes: total });
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    },
    close() {
      fail(Error('Speech session was cancelled.'), 'cancelled');
    },
  };
}
