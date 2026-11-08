import { saveProjectText } from './save-project-text';
import AssetPicker from './AssetPicker';
import { AUDIO_EXTENSIONS } from './asset-picker.js';
import { useSearchParams } from 'react-router';
import { updateSearch } from './useNav';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FolderOpen, LoaderCircle, Mic, Save, Square, X } from 'lucide-react';
import MemoryDialog from './MemoryDialog';
import { openAsrStream } from './asr-stream.js';
import { formatDuration } from './queue-timing.js';
import { formatWordTimes } from './asr-options.js';
import './speech-transcriber.css';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timingKey = 'forge-asr-file-timing-v1';
const phaseLabels = {
  recording: 'Recording. Speak, then choose Stop & finish.',
  transcribing: 'Transcribing file. This can take a while for long audio.',
  finishing: 'Finishing the transcript.',
  starting: 'Starting speech service. This can take up to two minutes while the model loads.',
};
function readFileRates() {
  try {
    const value = JSON.parse(localStorage.getItem(timingKey) || '[]');
    return Array.isArray(value)
      ? value.filter((rate) => Number.isFinite(rate) && rate > 0).slice(-20)
      : [];
  } catch {
    return [];
  }
}
async function post(path) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
    body: '{}',
  });
  const body = await response.json();
  return { response, body };
}

export default function SpeechTranscriber({
  onUseText,
  projects = [],
  project = null,
  renderLatency = null,
}) {
  const [params, setParams] = useSearchParams();
  const [libraryAudio, setLibraryAudio] = useState(null);
  const [phase, setPhase] = useState('idle'),
    [transcript, setTranscript] = useState(''),
    [partial, setPartial] = useState(''),
    [error, setError] = useState(''),
    [completionNotice, setCompletionNotice] = useState(''),
    [copied, setCopied] = useState(false),
    [conflict, setConflict] = useState(null),
    [working, setWorking] = useState(false),
    [punctuation, setPunctuation] = useState(true),
    [wordTiming, setWordTiming] = useState(false),
    [words, setWords] = useState([]),
    [progress, setProgress] = useState(0);
  const [fileRates, setFileRates] = useState(readFileRates);
  const [saving, setSaving] = useState(false),
    [savedPath, setSavedPath] = useState('');
  const sortedRates = [...fileRates].sort((a, b) => a - b),
    fileRate = sortedRates.length ? sortedRates[Math.floor((sortedRates.length - 1) / 2)] : null;
  const current = useRef(null),
    mounted = useRef(true),
    pendingFile = useRef(null),
    projectRef = useRef(project?.id);
  projectRef.current = project?.id;
  useEffect(() => setSavedPath(''), [project?.id]);
  const [micBlocked, setMicBlocked] = useState(false);
  useEffect(() => {
    let status = null,
      cancelled = false;
    const sync = () => {
      if (!cancelled) {
        setMicBlocked(status?.state === 'denied');
      }
    };
    navigator.permissions
      ?.query({ name: 'microphone' })
      .then((result) => {
        if (cancelled) {
          return;
        }
        status = result;
        status.onchange = sync;
        sync();
      })
      .catch(() => {
        // Some browsers do not expose microphone permission state; the start error still explains denial.
      });
    return () => {
      cancelled = true;
      if (status) {
        status.onchange = null;
      }
    };
  }, []);
  function cleanup(run) {
    if (!run) {
      return;
    }
    run.cancelled = true;
    run.abort?.abort();
    clearTimeout(run.flushTimer);
    try {
      run.source?.disconnect();
    } catch {
      // Cleanup and local status updates continue if browser APIs are unavailable.
    }
    try {
      run.node?.disconnect();
    } catch {
      // Cleanup and local status updates continue if browser APIs are unavailable.
    }
    try {
      run.gain?.disconnect();
    } catch {
      // Cleanup and local status updates continue if browser APIs are unavailable.
    }
    run.media?.getTracks().forEach((track) => track.stop());
    run.stream?.cancel();
    run.context?.close().catch(() => {
      // The stream error handler already reports failures through fail().
    });
    if (current.current === run) {
      current.current = null;
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanup(current.current);
    };
  }, []);
  const active = (run) => mounted.current && current.current === run && !run.cancelled;
  function fail(run, message) {
    if (!active(run)) {
      return;
    }
    cleanup(run);
    setPhase('idle');
    setPartial('');
    setError(message);
  }
  async function start(inputFile = null) {
    if (current.current) {
      return;
    }
    if (inputFile && inputFile.size > 25 * 1024 * 1024) {
      setError('Choose an audio file smaller than 25 MiB.');
      return;
    }
    // Word timing needs the whole file in one request, which only works for WAV files that live in
    // a project. Everything else is streamed through the browser, which keeps punctuation better.
    const whole = Boolean(wordTiming && inputFile?.forgeSource && /\.wav$/i.test(inputFile.name));
    pendingFile.current = inputFile;
    setError('');
    setWords([]);
    setCompletionNotice('');
    setPartial('');
    setCopied(false);
    setSavedPath('');
    setConflict(null);
    setPhase('starting');
    const run = { cancelled: false, finalText: '', partialText: '' };
    current.current = run;
    try {
      if (
        !whole &&
        (!window.AudioContext ||
          (!inputFile && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)))
      ) {
        throw Error(
          inputFile
            ? 'This browser cannot decode audio files.'
            : 'This browser does not support the microphone features needed for live transcription.',
        );
      }
      if (!whole) {
        run.context = new AudioContext();
        await run.context.resume();
        if (!active(run)) {
          return;
        }
      }
      const status = await fetch('/api/runtime/services');
      const services = status.ok ? (await status.json()).services : [];
      if (!active(run)) {
        return;
      }
      let ready = services?.some(
        (service) =>
          service.id === 'asr' && service.status === 'reachable' && service.modelLoaded === true,
      );
      if (!ready) {
        const healthResponse = await fetch('/api/runtime/health');
        const health = healthResponse.ok ? await healthResponse.json() : null;
        if (!active(run)) {
          return;
        }
        if (health?.modelLoadEngine !== 'asr' || health.modelLoadBarrier === 'idle') {
          const { response, body } = await post('/api/runtime/models/asr/load');
          if (!active(run)) {
            return;
          }
          if (body.code === 'insufficient_gpu_memory') {
            cleanup(run);
            setPhase('idle');
            setConflict(body);
            return;
          }
          if (!response.ok) {
            throw Error(body.message || body.error || 'Could not start speech recognition.');
          }
        }
      }
      const deadline = Date.now() + 120000;
      while (active(run) && Date.now() < deadline) {
        if (ready) {
          break;
        }
        const status = await fetch('/api/runtime/services');
        if (status.ok) {
          const data = await status.json();
          ready = data.services?.some(
            (service) =>
              service.id === 'asr' &&
              service.status === 'reachable' &&
              service.modelLoaded === true,
          );
          if (ready) {
            break;
          }
        }
        await pause(1000);
      }
      if (!active(run)) {
        return;
      }
      if (!ready) {
        throw Error(
          'Speech recognition is still starting. Check Models & services before trying again.',
        );
      }
      if (whole) {
        setTranscript('');
        setPhase('transcribing');
        run.abort = new AbortController();
        const response = await fetch('/api/runtime/asr/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
          body: JSON.stringify({
            ...inputFile.forgeSource,
            punctuation,
            wordTimestamps: wordTiming,
          }),
          signal: run.abort.signal,
        });
        const result = await response.json().catch(() => ({}));
        if (!active(run)) {
          return;
        }
        if (!response.ok || typeof result.text !== 'string') {
          throw Error(result.error || result.message || 'Could not transcribe this audio file.');
        }
        setTranscript(result.text.trim());
        setWords(Array.isArray(result.words) ? result.words : []);
        cleanup(run);
        setPhase('idle');
        setCompletionNotice(
          result.text.trim() ? 'Transcription complete.' : 'No speech was recognized in this file.',
        );
        return;
      }
      const url = new URL('/api/asr/realtime', window.location.href);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      run.stream = openAsrStream({
        url: url.href,
        sampleRate: run.context.sampleRate,
        session: {
          ...(punctuation ? {} : { automatic_punctuation: false }),
        },
        onDelta: (delta) => {
          if (!active(run)) {
            return;
          }
          run.partialText += delta;
          if (run.partialText.length + run.finalText.length > 100000) {
            throw Error('Transcript is too long. Stop and copy it before continuing.');
          }
          setPartial(run.partialText);
        },
        onFinal: (text) => {
          if (!active(run)) {
            return;
          }
          const finalText = text.trim();
          if (run.finalText.length + run.partialText.length + finalText.length > 100000) {
            throw Error('Transcript is too long. Stop and copy it before continuing.');
          }
          if (finalText) {
            run.finalText = [run.finalText, finalText].filter(Boolean).join(' ');
          }
          run.partialText = '';
          setTranscript(run.finalText);
          setPartial('');
        },
      });
      run.stream.done.catch((reason) => fail(run, reason.message));
      await run.stream.ready;
      if (!active(run)) {
        return;
      }
      if (inputFile) {
        const audio = await run.context.decodeAudioData(await inputFile.arrayBuffer());
        if (!active(run)) {
          return;
        }
        if (audio.duration > 120) {
          throw Error('Choose an audio file no longer than two minutes.');
        }
        setTranscript('');
        setProgress(0);
        setPhase('transcribing');
        const started = performance.now();
        const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
          audio.getChannelData(index),
        );
        for (let offset = 0; offset < audio.length && active(run); offset += 2048) {
          const count = Math.min(2048, audio.length - offset),
            buffer = new ArrayBuffer(count * 2),
            view = new DataView(buffer);
          for (let i = 0; i < count; i++) {
            let value = 0;
            for (const channel of channels) {
              value += channel[offset + i] || 0;
            }
            value = Math.max(-1, Math.min(1, value / channels.length));
            view.setInt16(
              i * 2,
              value < 0 ? Math.round(value * 32768) : Math.round(value * 32767),
              true,
            );
          }
          run.stream.send(buffer);
          setProgress(Math.floor(((offset + count) / audio.length) * 100));
          await pause(10);
        }
        if (!active(run)) {
          return;
        }
        setPhase('finishing');
        run.stream.commit();
        await run.stream.done;
        if (active(run)) {
          const rate = (performance.now() - started) / 1000 / audio.duration;
          if (Number.isFinite(rate) && rate > 0) {
            setFileRates((previous) => {
              const next = [...previous, rate].slice(-20);
              try {
                localStorage.setItem(timingKey, JSON.stringify(next));
              } catch {
                // Cleanup and local status updates continue if browser APIs are unavailable.
              }
              return next;
            });
          }
          cleanup(run);
          setPhase('idle');
          setCompletionNotice('Transcription complete.');
        }
        return;
      }
      await run.context.audioWorklet.addModule('/pcm16-worklet.js');
      if (!active(run)) {
        return;
      }
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!active(run)) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      run.media = media;
      run.source = run.context.createMediaStreamSource(media);
      run.node = new AudioWorkletNode(run.context, 'forge-pcm16');
      run.gain = run.context.createGain();
      run.gain.gain.value = 0;
      run.node.port.onmessage = (event) => {
        if (!active(run)) {
          return;
        }
        try {
          if (event.data?.type === 'audio') {
            run.stream.send(event.data.buffer);
          } else if (event.data?.type === 'flushed') {
            clearTimeout(run.flushTimer);
            run.media?.getTracks().forEach((track) => track.stop());
            run.stream.commit();
          }
        } catch (reason) {
          fail(run, reason.message);
        }
      };
      media
        .getAudioTracks()
        .forEach((track) =>
          track.addEventListener('ended', () => fail(run, 'The microphone stopped unexpectedly.')),
        );
      run.source.connect(run.node);
      run.node.connect(run.gain);
      run.gain.connect(run.context.destination);
      setTranscript('');
      setPhase('recording');
    } catch (reason) {
      fail(
        run,
        reason?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow microphone access in your browser and try again.'
          : reason?.message ||
              (inputFile
                ? 'Could not transcribe this audio file.'
                : 'Could not start the microphone.'),
      );
    }
  }
  function stop() {
    const run = current.current;
    if (!active(run) || !run.node) {
      return;
    }
    setPhase('finishing');
    try {
      run.source.disconnect();
      run.node.port.postMessage('flush');
      run.flushTimer = setTimeout(
        () => fail(run, 'Microphone audio could not be finalized.'),
        5000,
      );
    } catch (reason) {
      fail(run, reason.message);
      return;
    }
    run.stream.done
      .then(() => {
        if (!active(run)) {
          return;
        }
        cleanup(run);
        setPhase('idle');
        setCompletionNotice('Transcription complete.');
      })
      .catch(() => {
        // The stream error handler already reports failures through fail().
      });
  }
  function cancel() {
    const run = current.current;
    cleanup(run);
    setPhase('idle');
    setPartial('');
    setError('');
  }
  // Older or non-secure pages (such as a remote http address) have no async clipboard.
  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy');
    } finally {
      area.remove();
    }
  }
  async function copy() {
    try {
      try {
        await navigator.clipboard.writeText(transcript);
      } catch (reason) {
        if (!legacyCopy(transcript)) {
          throw reason;
        }
      }
      setCopied(true);
      setTimeout(() => {
        if (mounted.current) {
          setCopied(false);
        }
      }, 2000);
    } catch {
      setError('Could not copy the transcript. Select the text and copy it instead.');
    }
  }
  function clearTranscript() {
    setTranscript('');
    setWords([]);
    setCopied(false);
    setSavedPath('');
    setCompletionNotice('');
    setError('');
  }
  async function saveTranscript() {
    setSaving(true);
    setError('');
    try {
      const projectId = project?.id;
      const result = await saveProjectText(projectId, 'transcript', transcript);
      if (projectRef.current === projectId) {
        setSavedPath(result.path);
      }
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }
  async function offload(id) {
    setWorking(true);
    setError('');
    try {
      const { response, body } = await post(`/api/runtime/models/${id}/offload`);
      if (!response.ok) {
        throw Error(body.error || 'Could not stop the selected service.');
      }
      setConflict(null);
      await start(pendingFile.current);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="panel speech-transcriber" aria-label="Live speech to text">
      <div className="panel-heading">
        <div>
          <span className="mini-label">NEMOTRON ASR · ENGLISH</span>
          <h2>Live speech to text</h2>
        </div>
        <Mic size={19} aria-hidden="true" />
      </div>
      <p className="helper">
        Speak live or choose an audio file. Audio stays on this computer; recording starts only
        after you allow microphone access.
      </p>
      <details className="speech-options">
        <summary>
          Recognition options
          {(!punctuation || wordTiming) && <span className="speech-options-badge">Customized</span>}
        </summary>
        <div className="speech-options-body">
          <label className="speech-check">
            <input
              type="checkbox"
              checked={punctuation}
              disabled={phase !== 'idle'}
              onChange={(event) => setPunctuation(event.target.checked)}
            />
            <span>
              Punctuation and capitalization
              <small>Turn off for plain lowercase text without punctuation.</small>
            </span>
          </label>
          <label className="speech-check">
            <input
              type="checkbox"
              checked={wordTiming}
              disabled={phase !== 'idle'}
              onChange={(event) => setWordTiming(event.target.checked)}
            />
            <span>
              Word timing
              <small>
                Lists roughly when each word starts. Only for WAV files from the asset library (up
                to 25 MiB). Times can be off by up to a second, and long files may lose some
                punctuation.
              </small>
            </span>
          </label>
          {renderLatency?.({ disabled: phase !== 'idle' })}
          <p className="speech-options-note">
            Not available: other languages (this model is English only), word boosting for names
            (the installed model file lacks the tokenizer it needs), and speaker labels, profanity
            masking and spoken-number formatting (their add-on models are not installed).
          </p>
        </div>
      </details>
      <details className="speech-estimate">
        <summary>Audio-file timing details</summary>
        <div className="speech-estimate-copy">
          <strong>
            Audio-file estimate:{' '}
            {fileRate === null
              ? 'Not enough history'
              : `~${formatDuration(fileRate * 60)} per minute of audio`}
          </strong>
          <span>
            {fileRate === null
              ? 'Transcribe a file to build an estimate.'
              : `Based on ${fileRates.length} previous ${fileRates.length === 1 ? 'file' : 'files'}; model loading and audio decoding are extra.`}{' '}
            Live microphone timing depends on how long you speak.
          </span>
        </div>
      </details>
      <div className="speech-actions" role="group" aria-label="Transcription controls">
        {phase === 'recording' ? (
          <button className="outline-button" onClick={stop}>
            <Square size={15} /> Stop & finish
          </button>
        ) : (
          <button
            className="outline-button"
            onClick={() => start()}
            disabled={phase !== 'idle' || micBlocked}
            aria-describedby={micBlocked ? 'mic-blocked-help' : undefined}
          >
            {phase === 'idle' ? (
              <Mic size={16} />
            ) : (
              <LoaderCircle size={16} className="motion-spinner" />
            )}
            {phase === 'idle'
              ? 'Start microphone'
              : phase === 'starting'
                ? 'Starting speech service…'
                : phase === 'transcribing'
                  ? 'Transcribing file…'
                  : 'Finishing transcript…'}
          </button>
        )}
        <label className={'outline-button speech-file ' + (phase !== 'idle' ? 'disabled' : '')}>
          Choose audio file
          <input
            type="file"
            accept="audio/*"
            disabled={phase !== 'idle'}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) {
                start(file);
              }
            }}
          />
        </label>
        <button
          type="button"
          className="outline-button"
          disabled={phase !== 'idle'}
          onClick={() => updateSearch(setParams, { picker: 'audio' })}
        >
          <FolderOpen size={15} /> Choose from asset library
        </button>
        {phase !== 'idle' && (
          <button className="ghost-button" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
      <p className={'speech-status ' + phase} role="status" aria-live="polite">
        {phase === 'idle'
          ? completionNotice || 'Microphone off. Your browser asks for access when you start.'
          : phase === 'transcribing' && progress > 0 && progress < 100
            ? `Transcribing file, ${progress}% sent. Audio streams to the model faster than real time.`
            : phaseLabels[phase]}
      </p>
      {micBlocked && phase === 'idle' && (
        <p className="speech-blocked" id="mic-blocked-help">
          Microphone access is blocked for this site. Allow it in your browser's site settings;
          Start microphone becomes available once it is allowed.
        </p>
      )}
      {libraryAudio && (
        <div className="speech-actions">
          <span>{libraryAudio.name}</span>
          <button
            className="outline-button"
            disabled={phase !== 'idle'}
            onClick={() => start(libraryAudio)}
          >
            Transcribe selected audio
          </button>
          <button
            className="icon-outline"
            disabled={phase !== 'idle'}
            aria-label="Remove selected audio"
            onClick={() => setLibraryAudio(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <p className="helper">
        Audio files are streamed: up to two minutes and 25 MiB, with formats depending on your
        browser. Live microphone sessions stop after roughly ten minutes.
      </p>
      <div className="speech-output" role="region" aria-label="Transcript">
        <span>{transcript}</span>
        {partial && (
          <span className="speech-partial">
            {transcript ? ' ' : ''}
            {partial}
          </span>
        )}
        {!transcript && !partial && (
          <span className="speech-placeholder">Your transcript will appear here.</span>
        )}
      </div>
      {words.length > 0 && (
        <details className="speech-words">
          <summary>Word timing, approximate ({words.length} words)</summary>
          <pre aria-label="Word start times">{formatWordTimes(words)}</pre>
        </details>
      )}
      {transcript && (
        <>
          <div className="speech-actions">
            <button className="icon-outline" onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy text'}
            </button>
            <button
              className="icon-outline"
              disabled={saving || phase !== 'idle' || !project}
              title={
                !project
                  ? 'Choose a project to save the transcript.'
                  : 'Save the transcript to this project.'
              }
              onClick={saveTranscript}
            >
              <Save size={14} /> {saving ? 'Saving…' : 'Save to project'}
            </button>
            <button
              className="icon-outline"
              disabled={transcript.length > 1000 || phase !== 'idle'}
              aria-describedby={transcript.length > 1000 ? 'voice-limit-help' : undefined}
              onClick={() => onUseText(transcript)}
            >
              Use as voice text
            </button>
            <button className="ghost-button" disabled={phase !== 'idle'} onClick={clearTranscript}>
              Clear transcript
            </button>
          </div>
          {!project && (
            <p className="helper speech-limit">Choose a project to save this transcript.</p>
          )}
          {transcript.length > 1000 && (
            <p className="helper speech-limit" id="voice-limit-help">
              Voice text allows 1,000 characters; this transcript has {transcript.length}. Trim it
              or copy it instead.
            </p>
          )}
        </>
      )}
      {savedPath && (
        <p className="speech-save-status" role="status">
          Saved to {savedPath}
        </p>
      )}
      {error && !conflict && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {params.get('picker') === 'audio' && (
        <AssetPicker
          title="Choose audio to transcribe"
          projects={projects}
          project={project}
          extensions={AUDIO_EXTENSIONS}
          maxBytes={25 * 1024 * 1024}
          onSelect={(files) => {
            setLibraryAudio(files[0]);
            updateSearch(setParams, { picker: null });
          }}
          onClose={() => updateSearch(setParams, { picker: null })}
        />
      )}
      {conflict && (
        <MemoryDialog
          target="Nemotron ASR"
          conflict={conflict}
          onClose={() => {
            setConflict(null);
            setError('');
          }}
          onRetry={async () => {
            setConflict(null);
            await start(pendingFile.current);
          }}
          onOffload={offload}
          working={working}
          error={error}
        />
      )}
    </section>
  );
}
