// Checks the required fields of a creation page before anything is queued. Every problem names
// the field it belongs to, so the page can show the message beside that field and focus it.
// The server validates every request again; these checks only keep an obvious mistake from
// becoming a toast that disappears before it can be read.

const TEN_MIB = 10 * 1024 * 1024;
const FORTY_MIB = 40 * 1024 * 1024;

// Where each message appears (`id`) and which control receives focus (`focusId`).
export const FIELD_TARGETS = {
  prompt: { id: 'prompt-error', focusId: 'prompt' },
  lyrics: { id: 'extra-error', focusId: 'extra' },
  description: { id: 'three-d-text-prompt-error', focusId: 'three-d-text-prompt' },
  reference: { id: 'reference-error', focusId: 'reference-file' },
  pose: { id: 'motionbricks-source-error', focusId: 'motionbricks-file' },
  firstFrame: { id: 'video-first-frame-error', focusId: 'video-first-frame' },
  lastFrame: { id: 'video-last-frame-error', focusId: 'video-last-frame' },
};

const PROMPT_MESSAGES = {
  images: 'Add an image description to queue a render.',
  video: 'Add a video description to queue a render.',
  sfx: 'Add a sound description to queue a render.',
  music: 'Add a music style to queue a render.',
  voices: 'Add dialogue to queue a voice render.',
  segmentation: 'Describe what to isolate.',
  motion: 'Describe the human motion.',
};
const DRAFT_PROMPT_MESSAGE = 'Add a description to create a draft.';
const IMAGE_SIZE_MESSAGE = 'Use reference images under 10 MiB each and 40 MiB in total.';
const SINGLE_IMAGE_SIZE_MESSAGE = 'Use an image, up to 10 MiB.';
const REFRESH_HINT = 'Files are not kept after a page refresh.';

const hasText = (value) => String(value ?? '').trim() !== '';
const tooLarge = (files) =>
  files.some((file) => file.size > TEN_MIB) ||
  files.reduce((total, file) => total + file.size, 0) > FORTY_MIB;

// Returns the problems in form order: [{ field, id, focusId, message }]. Empty means ready.
//   files: { imageFiles, videoFiles, shapeFiles, segmentationFiles, motionPoseFile,
//            videoFrames: { first, last } }
//   model: the selected 3D or motion model, because TRELLIS.2 takes a different image format.
//   forDraft: the "save a draft" path, which only needs a description (or a 3D reference).
export function creationFieldErrors({ section, draft, files = {}, model = '', forDraft = false }) {
  const errors = [];
  const add = (field, message) => errors.push({ field, ...FIELD_TARGETS[field], message });
  const references = draft.refs || [];
  const motionBricks = section === 'motion' && model === 'NVIDIA MotionBricks';

  if (forDraft) {
    if (section === '3d' && draft.threeDMode !== 'text' && !references.length) {
      add('reference', 'Add a reference image for your 3D draft.');
    } else if (section === '3d' && draft.threeDMode === 'text' && !hasText(draft.prompt)) {
      add('description', 'Describe the object you want to create.');
    } else if (section !== '3d' && !motionBricks && !hasText(draft.prompt)) {
      add('prompt', DRAFT_PROMPT_MESSAGE);
    }
    return errors;
  }

  if (PROMPT_MESSAGES[section] && !motionBricks && section !== '3d' && !hasText(draft.prompt)) {
    add('prompt', PROMPT_MESSAGES[section]);
  }
  if (section === 'music' && !hasText(draft.second)) {
    add('lyrics', 'Add lyrics to queue a render. Write [Instrumental] for an instrumental track.');
  }

  if (section === '3d') {
    if (draft.threeDMode === 'text') {
      if (!hasText(draft.prompt)) {
        add('description', 'Describe the object you want to create.');
      }
    } else {
      const shapeFiles = files.shapeFiles || [];
      if (!references.length) {
        add('reference', 'Choose a reference image before rendering.');
      } else if (shapeFiles.length !== 1 || references.length !== 1) {
        add('reference', `Choose the reference image again before rendering. ${REFRESH_HINT}`);
      } else if (shapeFiles[0].size > TEN_MIB) {
        add('reference', SINGLE_IMAGE_SIZE_MESSAGE);
      } else if (
        model === 'TRELLIS.2' &&
        !draft.removeBackground &&
        !/\.(png|webp)$/i.test(shapeFiles[0].name || '')
      ) {
        add(
          'reference',
          'TRELLIS.2 needs a transparent PNG or WebP. Choose one, or tick “Remove the background first”.',
        );
      }
    }
  }

  if (section === 'segmentation') {
    const segmentationFiles = files.segmentationFiles || [];
    if (!references.length && !segmentationFiles.length) {
      add('reference', 'Choose a reference image to segment.');
    } else if (segmentationFiles.length !== 1 || references.length !== 1) {
      add('reference', `Choose the reference image again before segmenting. ${REFRESH_HINT}`);
    } else if (segmentationFiles[0].size > TEN_MIB) {
      add('reference', SINGLE_IMAGE_SIZE_MESSAGE);
    }
  }

  if (section === 'images') {
    const imageFiles = files.imageFiles || [];
    if (references.length !== imageFiles.length) {
      add('reference', `Choose the image references again before rendering. ${REFRESH_HINT}`);
    } else if (tooLarge(imageFiles)) {
      add('reference', IMAGE_SIZE_MESSAGE);
    }
  }

  if (section === 'video') {
    const source = ['frames', 'text'].includes(draft.videoSource)
      ? draft.videoSource
      : 'references';
    if (source === 'frames') {
      const { first, last } = files.videoFrames || {};
      if (!first) {
        add(
          'firstFrame',
          draft.videoFirstFrame
            ? `Choose the first frame file again before queuing. ${REFRESH_HINT}`
            : 'Add a first frame to queue a video from frames.',
        );
      }
      if (draft.videoLastFrame && !last) {
        add('lastFrame', `Choose the last frame file again before queuing. ${REFRESH_HINT}`);
      }
    } else if (source === 'references') {
      const videoFiles = files.videoFiles || [];
      const hasClips = Boolean(draft.videoClips?.length || draft.videoAudios?.length);
      if (!references.length && !hasClips) {
        add(
          'reference',
          'Add 1–9 reference images, or a reference video or audio clip, to queue a video.',
        );
      } else if (references.length !== videoFiles.length) {
        add('reference', `Choose the video reference images again before queuing. ${REFRESH_HINT}`);
      } else if (tooLarge(videoFiles)) {
        add('reference', IMAGE_SIZE_MESSAGE);
      }
    }
  }

  if (motionBricks) {
    if (!files.motionPoseFile) {
      add('pose', 'Choose a SOMA BVH file before rendering.');
    } else if (files.motionPoseFile.size > TEN_MIB) {
      add('pose', 'Use a BVH under 10 MiB.');
    }
  }
  return errors;
}

// One short toast line that points at the inline messages instead of repeating them.
export function validationSummary(errors) {
  return errors.length === 1
    ? 'One field needs attention before this can be queued.'
    : `${errors.length} fields need attention before this can be queued.`;
}
