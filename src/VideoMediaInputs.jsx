import { useState } from 'react';
import { FileAudio, FileImage, FileVideo, FolderOpen, Plus, X } from 'lucide-react';
import AssetPicker from './AssetPicker';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS } from './asset-picker.js';
import { setVideoFrame, useVideoFrames } from './video-media-store';
import {
  MAX_REFERENCE_AUDIOS,
  MAX_REFERENCE_VIDEOS,
  VIDEO_CLIP_EXTENSIONS,
  videoWarnings,
} from '../runtime/video-options.js';
import { videoAspectId, videoFramesFor } from './imageVideoInputs';
import './video-media.css';

const MiB = 1024 * 1024;
export const VIDEO_SOURCES = [
  {
    id: 'references',
    title: 'Reference images',
    help: 'Keep characters, props or a style from 1–9 pictures. You can also add reference videos (a motion or look to follow) and reference audio (a voice to follow).',
  },
  {
    id: 'frames',
    title: 'First and last frame',
    help: 'Start from a picture and, if you like, end on another one; H3 invents the motion between them. This cannot be combined with reference images, videos or audio. MiniMax trains this into a separate FL2VA checkpoint that is not installed, so Forge tries the installed Ref2VA weights (untested) unless a minimax_h3_fl2va file is in the H3 model folder.',
  },
  {
    id: 'text',
    title: 'Text only (experimental)',
    help: 'No pictures at all: everything comes from the description. H3 is built to work from references, so results can vary.',
  },
];

function FrameSlot({ slot, label, optional, draft, update, openPicker }) {
  const frames = useVideoFrames();
  const file = frames[slot];
  const descriptor = draft[slot === 'first' ? 'videoFirstFrame' : 'videoLastFrame'];
  const key = slot === 'first' ? 'videoFirstFrame' : 'videoLastFrame';
  const [problem, setProblem] = useState('');
  const choose = (chosen) => {
    setProblem('');
    if (!chosen) {
      return;
    }
    if (
      !/^image\/(png|jpeg|webp)$/.test(chosen.type) &&
      !/\.(png|jpe?g|webp)$/i.test(chosen.name)
    ) {
      setProblem('Choose a PNG, JPEG or WebP image.');
      return;
    }
    if (chosen.size > 10 * MiB) {
      setProblem('Choose an image under 10 MiB.');
      return;
    }
    setVideoFrame(slot, chosen);
    update({ [key]: { name: chosen.name, size: chosen.size } });
  };
  const remove = () => {
    setProblem('');
    setVideoFrame(slot, null);
    update({ [key]: null });
  };
  return (
    <div className="video-frame-slot" data-slot={slot}>
      <div className="field-label reference-heading">
        {label} <span>{optional ? 'OPTIONAL' : 'REQUIRED'}</span>
      </div>
      {descriptor ? (
        <div className="ref-list">
          <span>
            <FileImage size={13} />
            {descriptor.name}
            <button type="button" aria-label={`Remove ${descriptor.name}`} onClick={remove}>
              <X size={13} />
            </button>
          </span>
        </div>
      ) : (
        <>
          <label className="upload-box">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={`Choose the ${label.toLowerCase()} image`}
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="upload-icon">
              <Plus size={19} />
            </div>
            <div>
              <strong>{`Choose the ${label.toLowerCase()}`}</strong>
              <small>PNG, JPEG or WebP from your computer</small>
            </div>
            <span className="upload-action">BROWSE FILES</span>
          </label>
          <button
            type="button"
            className="outline-button asset-library-button"
            onClick={openPicker}
          >
            <FolderOpen size={15} /> Choose from asset library
          </button>
        </>
      )}
      {descriptor && !file && (
        <p className="helper" role="status">
          {descriptor.name} is listed from a saved draft or reused settings, but the file is not
          attached. Choose it again before queuing.
        </p>
      )}
      {problem && (
        <p className="video-media-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function ClipList({ kind, items, max, noun, onAdd, onRemove }) {
  const Icon = kind === 'video' ? FileVideo : FileAudio;
  return (
    <div className="video-clip-list" data-kind={kind}>
      <div className="field-label reference-heading">
        {noun} <span>OPTIONAL · UP TO {max}</span>
      </div>
      {items.length > 0 && (
        <div className="ref-list">
          {items.map((item, index) => (
            <span key={item.path}>
              <Icon size={13} />
              {`<${kind === 'video' ? 'Video' : 'Audio'} ${index + 1}> `}
              {item.name}
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => onRemove(item)}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        className="outline-button asset-library-button"
        disabled={items.length >= max}
        onClick={onAdd}
      >
        <FolderOpen size={15} />
        {kind === 'video'
          ? ' Choose reference video from library'
          : ' Choose reference audio from library'}
      </button>
    </div>
  );
}

// part="source" is the choice of what the video starts from; part="details" holds the pictures and
// clips that choice needs. They sit on either side of the reference image uploader.
export default function VideoMediaInputs({ draft, update, projects, project, part = 'all' }) {
  const [picker, setPicker] = useState(null);
  const source = ['frames', 'text'].includes(draft.videoSource) ? draft.videoSource : 'references';
  const videos = draft.videoClips || [];
  const audios = draft.videoAudios || [];
  const warnings = videoWarnings({
    aspect: videoAspectId(draft.options?.[0]),
    resolution: draft.videoResolution || 'standard',
    frames: videoFramesFor(draft.options?.[1]),
    cfg_scale: Number(draft.videoCfg) || (draft.videoNegative?.trim() ? 2 : 1),
    reference_detail: draft.videoRefDetail,
    reference_videos: source === 'references' ? videos : [],
  });
  const addClips = (key, current, max, files) => {
    const next = [...current];
    for (const file of files) {
      const path = file.forgeSource?.path;
      if (path && !next.some((item) => item.path === path) && next.length < max) {
        next.push({ name: file.name, path, size: file.size });
      }
    }
    update({ [key]: next });
    setPicker(null);
  };
  const removeClip = (key, current, item) =>
    update({
      [key]: current.filter((entry) => entry.path !== item.path),
      ...(key === 'videoClips' && current.length <= 1 ? { videoClipAudio: false } : {}),
    });
  const active = project || projects?.[0];
  return (
    <section className="video-media" aria-label="What the video starts from" data-part={part}>
      {part !== 'details' && (
        <fieldset className="video-source">
          <legend className="field-label">Start the video from</legend>
          {VIDEO_SOURCES.map((option) => (
            <label key={option.id} className="video-source-option">
              <input
                type="radio"
                name="video-source"
                value={option.id}
                checked={source === option.id}
                onChange={() => update({ videoSource: option.id })}
              />
              <span>
                <strong>{option.title}</strong>
                <small>{option.help}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {part === 'source' ? null : (
        <>
          {source === 'frames' && (
            <>
              <FrameSlot
                slot="first"
                label="First frame"
                draft={draft}
                update={update}
                openPicker={() => setPicker('first')}
              />
              <FrameSlot
                slot="last"
                label="Last frame"
                optional
                draft={draft}
                update={update}
                openPicker={() => setPicker('last')}
              />
              <p className="helper">
                The pictures are cropped to the video shape (centre crop) so nothing is stretched.
                With only a first frame the clip starts there and moves on freely. Describe the
                action between the frames in the description.
              </p>
            </>
          )}
          {source === 'references' && (
            <>
              <ClipList
                kind="video"
                items={videos}
                max={MAX_REFERENCE_VIDEOS}
                noun="Reference videos"
                onAdd={() => setPicker('video')}
                onRemove={(item) => removeClip('videoClips', videos, item)}
              />
              <ClipList
                kind="audio"
                items={audios}
                max={MAX_REFERENCE_AUDIOS}
                noun="Reference audio (voice)"
                onAdd={() => setPicker('audio')}
                onRemove={(item) => removeClip('videoAudios', audios, item)}
              />
              {(videos.length > 0 || audios.length > 0) && (
                <p className="helper">
                  Refer to them in the description as &lt;Video 1&gt; and &lt;Audio 1&gt;, in this
                  order. Only the first 3 seconds of a video and the first 15 seconds of audio are
                  used. Choose clips from this project&rsquo;s library; they are copied when you
                  queue the render.
                </p>
              )}
              {videos.length > 0 && (
                <label className="video-media-check">
                  <input
                    type="checkbox"
                    checked={draft.videoClipAudio === true}
                    onChange={(e) => update({ videoClipAudio: e.target.checked })}
                  />
                  <span>
                    <strong>Also use the sound of the reference videos</strong>
                    <small>
                      Every reference video must have a sound track, or the render stops.
                    </small>
                  </span>
                </label>
              )}
            </>
          )}
          {source === 'text' && (
            <p className="helper">
              Describe the scene, the camera and the sound. Nothing is attached to this render.
            </p>
          )}
          {warnings.length > 0 && (
            <ul className="video-media-warnings" role="status">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {picker && active && (
        <AssetPicker
          title={
            picker === 'first'
              ? 'Choose the first frame'
              : picker === 'last'
                ? 'Choose the last frame'
                : picker === 'video'
                  ? 'Choose a reference video'
                  : 'Choose reference audio'
          }
          description={
            picker === 'video'
              ? 'WebM or MP4 videos from this project, up to 64 MiB.'
              : picker === 'audio'
                ? 'WAV, MP3, FLAC, OGG or Opus files from this project, up to 32 MiB.'
                : undefined
          }
          projects={picker === 'video' || picker === 'audio' ? [active] : projects}
          project={active}
          extensions={
            picker === 'video'
              ? VIDEO_CLIP_EXTENSIONS
              : picker === 'audio'
                ? AUDIO_EXTENSIONS
                : IMAGE_EXTENSIONS
          }
          maxFiles={
            picker === 'video'
              ? MAX_REFERENCE_VIDEOS - videos.length
              : picker === 'audio'
                ? MAX_REFERENCE_AUDIOS - audios.length
                : 1
          }
          maxBytes={picker === 'video' ? 64 * MiB : picker === 'audio' ? 32 * MiB : 10 * MiB}
          totalBytes={
            picker === 'video' ? 64 * MiB * 3 : picker === 'audio' ? 32 * MiB * 3 : 10 * MiB
          }
          onSelect={(files) => {
            if (picker === 'video') {
              addClips('videoClips', videos, MAX_REFERENCE_VIDEOS, files);
            } else if (picker === 'audio') {
              addClips('videoAudios', audios, MAX_REFERENCE_AUDIOS, files);
            } else {
              const slot = picker;
              setVideoFrame(slot, files[0]);
              update({
                [slot === 'first' ? 'videoFirstFrame' : 'videoLastFrame']: {
                  name: files[0].name,
                  size: files[0].size,
                },
              });
              setPicker(null);
            }
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}
