import CredentialSettings from './CredentialSettings';
import AssetPicker from './AssetPicker';
import { IMAGE_EXTENSIONS, TRELLIS_EXTENSIONS, POSE_EXTENSIONS } from './asset-picker.js';
import FieldHelp from './tooltips/FieldHelp';
import SegmentationMatchControls from './SegmentationMatchControls.jsx';
import {
  SEGMENTATION_CONFIDENCE_DEFAULT,
  SEGMENTATION_EXPORTS,
  confidenceProblem,
} from './segmentation-settings.js';
import fieldTooltips from './tooltips';
import { chatProjectKey } from './chat-project';
import {
  sanitizeDrafts,
  sanitizeJobList,
  sanitizeSelectedProject,
  sanitizeSwitches,
} from './storage-tolerance.js';
import RecoveryPanel from './RecoveryPanel';
import ConnectionStatus from './ConnectionStatus';
import AssetThumbnail, { isVisualAsset } from './AssetThumbnail';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useNav, updateSearch, useRouteToggle, routeDetails } from './useNav';
import { BrowserRouter, Routes, Route } from 'react-router';
import {
  notificationSettingsKey,
  defaultNotifications,
  showCompletionNotification,
} from './notifications';
import useDialogFocus from './useDialogFocus';
import Diagnostics from './Diagnostics';
import { RecentProjects, NewProjectDialog } from './Projects';
import Gallery from './Gallery';
import Megascans from './Megascans';
import PreviewArea from './PreviewArea';
import { draftJob, reusePlan } from './generation-details';
import Models from './Models';
import RuntimeQueue, {
  enqueueMusic,
  enqueueSound,
  enqueueImage,
  enqueueVideo,
  enqueueVoice,
  enqueueSegmentation,
  enqueueMotion,
  enqueueMotionBricks,
  estimateRender,
  estimatePayload,
} from './RuntimeQueue';
import { useRuntimeNotifications } from './useRuntimeNotifications';
import GameDecision from './GameDecision';
import HunyuanControls from './HunyuanControls';
import TrellisControls from './TrellisControls';
import { ThreeDBackgroundOption, ThreeDModeSwitch } from './ThreeDInputs';
import { enqueueTextTo3d, enqueueThreeD } from './three-d-enqueue';
import { alphaStatusFor } from './image-alpha';
import HyMotionControls from './HyMotionControls';
import { hyMotionVariationCount } from './hymotion-settings.js';
import MotionBricksControls from './MotionBricksControls';
import SpeechTranscriber from './SpeechTranscriber';
import AudioSettings from './AudioSettings';
import ImageVideoSettings from './ImageVideoSettings';
import VideoMediaInputs from './VideoMediaInputs';
import { clearVideoFrames, getVideoFrames } from './video-media-store';
import SoundSource from './SoundSource';
import VoiceModeControls from './VoiceModeControls';
import { firstVoiceModeError, voiceModeFieldErrors } from './voice-modes.js';
import FieldError from './FieldError';
import { creationFieldErrors, validationSummary } from './creation-validation.js';
import AsrLatency from './AsrLatency';
import { useImageLoras } from './useImageLoras.js';
import MemoryAlerts from './MemoryAlerts';
import MiniPlayer from './MiniPlayer';
import PageErrorBoundary from './PageErrorBoundary';
import ModelPlaque from './ModelPlaque';
import WorldStudio from './WorldStudio';
import Vegetation from './Vegetation';
import { stashReuse } from './vegetation-settings';
import {
  QueueTimingProvider,
  QueueTimingBadge,
  CreationQueueTiming,
  useQueueTiming,
} from './QueueTiming';
import { estimateFromNearbyHistory, formatDuration } from './queue-timing.js';
import { pageQueueStatus } from './nav-queue-status';
import './clientLogging';
import './app-log-install.js';
import { reportNoticeError } from './error-capture.js';
import ErrorsButton from './ErrorsButton';
import ErrorsDialog from './ErrorsDialog';
import AiAssistSettings from './AiAssistSettings';
import StudioBehaviourSettings from './StudioBehaviourSettings';
import { I18nProvider } from './i18n/index.js';
import LanguageMenu from './i18n/LanguageMenu';
import { shippedCatalogs } from './i18n/shipped-catalogs.js';
import { createLog } from './app-log.js';
import {
  ArrowRight,
  AudioLines,
  Box,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Clapperboard,
  Clock3,
  Cloud,
  FileImage,
  FolderOpen,
  Gamepad2,
  Image as ImageIcon,
  Layers3,
  LayoutGrid,
  ListChecks,
  ListMusic,
  MessageSquareText,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Mic2,
  Music2,
  PackageOpen,
  PersonStanding,
  Plus,
  Radio,
  RotateCcw,
  Scissors,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trees,
  X,
  Zap,
} from 'lucide-react';
import './style.css';
import './settings-page.css';
import './theme.css';
import './responsive.css';
import './refinement.css';
import './desktop-rhythm.css';
import './mobile-spacing.css';
import './navigation.css';
import './creation-panels.css';
import './page-error.css';
import './ux-tokens.css';
import './ux-polish.css';
import './ux-creation.css';
import './ux-world-motion.css';
import './ux-chat.css';
import './ux-library.css';
import './ux-system.css';
import './ux-page-overview.css';
import './ux-page-chat.css';
import './ux-page-images.css';
import './ux-page-3d.css';
import './ux-page-world.css';
import './ux-page-motion.css';
import './ux-page-video.css';
import { videoBudgetLabel, videoFormatSummary } from './imageVideoInputs';
import './ux-page-music.css';
import './ux-page-sfx.css';
import './ux-page-voices.css';
import './ux-page-segmentation.css';
import './ux-page-game.css';
import './ux-page-assets.css';
import './ux-page-models.css';
import './ux-page-diagnostics.css';
import './ux-mobile-shell.css';
import './ux-mobile-creation.css';
import './ux-mobile-world-motion.css';
import './ux-mobile-chat.css';
import './ux-mobile-library.css';
import './ux-mobile-system.css';

const log = createLog('ui');

// Log fields for a failed call: the error class and HTTP status only, never the message text.
function errorFields(error) {
  const fields = { errorClass: typeof error?.name === 'string' ? error.name : 'Error' };
  if (Number.isFinite(error?.status)) {
    fields.httpStatus = error.status;
  }
  return fields;
}

// A render that was not queued: 'http_error' when the server answered, 'not_sent' otherwise.
function queueRejection(kind, projectId, error) {
  const reason = Number.isFinite(error?.status) ? 'http_error' : 'not_sent';
  return { kind, projectId, reason, ...errorFields(error) };
}

// Chat's Markdown renderer is only needed when the user opens that workspace.
const Chat = React.lazy(() => import('./Chat'));

const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'images', label: 'Images', icon: ImageIcon },
  { id: '3d', label: '3D models', icon: Box },
  { id: 'vegetation', label: 'Vegetation', icon: Trees },
  { id: 'world', label: 'Worlds', icon: Cloud },
  { id: 'motion', label: 'Motion', icon: PersonStanding },
  { id: 'video', label: 'Video', icon: Clapperboard },
  { id: 'music', label: 'Music', icon: Music2 },
  { id: 'sfx', label: 'Sound effects', icon: AudioLines },
  { id: 'voices', label: 'Voices', icon: Mic2 },
  { id: 'segmentation', label: 'Segmentation', icon: Scissors },
  { id: 'game', label: 'Game logic', icon: Gamepad2 },
];
const configs = {
  images: {
    title: 'Image studio',
    eyebrow: 'IMAGE GENERATION',
    description: 'Turn your ideas into worlds, characters, and everything in between.',
    icon: ImageIcon,
    model: 'Qwen Image 2.1',
    prompt: 'Describe what you want to create',
    placeholder:
      'A weathered potion shop tucked away in an enchanted forest, warm light spilling from the windows, painterly fantasy game concept art...',
    button: 'Add image to queue',
    options: [
      ['Aspect ratio', 'Landscape · 16:9', 'Square · 1:1', 'Portrait · 9:16'],
      ['Quality', 'Balanced', 'Draft', 'High quality'],
    ],
    tip: 'Be descriptive. Include a subject, art style, lighting, and mood.',
  },
  '3d': {
    title: '3D model studio',
    eyebrow: 'OBJECTS & CHARACTERS',
    description: 'Turn a reference image into the beginnings of a 3D game asset.',
    icon: Box,
    model: 'Hunyuan3D 2.1',
    prompt: 'Creative notes',
    placeholder: 'Optional notes about this character or object...',
    button: 'Add 3D draft to queue',
    options: [
      ['Asset type', 'Object / prop', 'Character'],
      ['Detail', 'Balanced', 'Draft', 'High detail'],
    ],
    tip: 'Start with a clear reference image showing your subject.',
  },
  motion: {
    title: 'Character motion',
    eyebrow: 'CHARACTER ANIMATION',
    description:
      'Generate motion clips for your characters. Automatic rigging is not available yet.',
    icon: PersonStanding,
    model: 'HY-Motion 1.0',
    prompt: 'Describe the motion',
    placeholder: 'A knight walks cautiously through a dark forest, then draws a sword...',
    button: 'Add motion draft to queue',
    options: [
      ['Character input', 'Rigged character', 'Unrigged mesh'],
      ['Output intent', 'Animation clip', 'Motion exploration'],
    ],
    tip: 'Describe an action, its pace, and the feeling of the movement.',
  },
  video: {
    title: 'Video studio',
    eyebrow: 'VIDEO GENERATION',
    description: 'Bring your characters and scenes to life.',
    icon: Clapperboard,
    model: 'MiniMax H3 Ref2VA',
    prompt: 'Describe your scene',
    placeholder: 'A brave knight approaches the castle gates as the camera slowly moves forward...',
    button: 'Add video to queue',
    options: [
      [
        'Aspect ratio',
        'Landscape · 16:9',
        'Square · 1:1',
        'Portrait · 9:16',
        'Photo · 4:3',
        'Photo portrait · 3:4',
        'Cinema · 21:9',
      ],
      [
        'Duration',
        'About 5 seconds',
        'About 2 seconds',
        'About 7 seconds',
        'About 10 seconds',
        'About 13 seconds',
        'About 15 seconds',
      ],
    ],
    tip: 'Add a reference image and describe the action, camera, and sound.',
  },
  music: {
    title: 'Music studio',
    eyebrow: 'MUSIC GENERATION',
    description: 'Create the soundtrack to your next great adventure.',
    icon: Music2,
    model: 'YuE2',
    prompt: 'Describe the sound and style',
    placeholder:
      'A sweeping orchestral theme with soft piano, distant strings, and a sense of discovery...',
    button: 'Add music to queue',
    options: [
      ['Duration', '15 seconds', '30 seconds', '60 seconds'],
      ['Planning', 'Full arrangement', 'Melody', 'Off'],
    ],
    tip: 'Describe instruments, mood, genre, and how the music should evolve.',
  },
  sfx: {
    title: 'Sound effects',
    eyebrow: 'SOUND GENERATION',
    description: 'Give every action, environment, and interaction a sound.',
    icon: AudioLines,
    model: 'Stable Audio 3',
    prompt: 'Describe the sound',
    placeholder: 'A single magical sword impact with a crystalline shimmer and a short echo...',
    button: 'Add sound to queue',
    options: [
      ['Duration', '5 seconds', '10 seconds', '20 seconds'],
      ['Quality', 'Balanced · 8 steps', 'Draft · 4 steps', 'Detailed · 20 steps'],
    ],
    tip: 'Be specific about the action, texture, and environment.',
  },
  voices: {
    title: 'Voice studio',
    eyebrow: 'SPEECH & DIALOGUE',
    description: 'Find a voice for every character in your world.',
    icon: Mic2,
    model: 'Qwen3-TTS 1.7B · Preset, clone or design',
    prompt: 'What should your character say?',
    placeholder: 'The forest remembers everyone who passes through it...',
    button: 'Add voice to queue',
    options: [
      [
        'Voice',
        'Ryan',
        'Aiden',
        'Vivian',
        'Serena',
        'Uncle_Fu',
        'Dylan',
        'Eric',
        'Ono_Anna',
        'Sohee',
      ],
      [
        'Language',
        'English',
        'Auto',
        'Chinese',
        'Japanese',
        'Korean',
        'German',
        'French',
        'Russian',
        'Portuguese',
        'Spanish',
        'Italian',
      ],
    ],
    tip: 'Add direction for tone, pace, and personality to shape the performance.',
  },
  segmentation: {
    title: 'Segmentation',
    eyebrow: 'IMAGE TOOLS',
    description: 'Isolate the pieces that make your world.',
    icon: Scissors,
    model: 'Meta SAM 3.1',
    prompt: 'What would you like to isolate?',
    placeholder: 'The character in the foreground...',
    button: 'Add segmentation to queue',
    options: [
      ['Selection', 'Text prompt'],
      ['Export', ...SEGMENTATION_EXPORTS.map(([label]) => label)],
    ],
    tip: 'Use a short description of the object you want to select.',
  },
  game: {
    title: 'Game logic',
    eyebrow: 'DECISION SERVER',
    description: 'Give your game characters a world to respond to.',
    icon: Gamepad2,
    model: 'Mammoth-1 · OneJev',
    prompt: 'Describe the current game state',
    placeholder:
      'The player approaches a guarded gate carrying a lantern. The guard has been warned about intruders...',
    button: 'Save test draft',
    options: [
      ['Question type', 'Choice', 'Score', 'Yes / No'],
      ['Result view', 'Structured', 'Compact'],
    ],
    tip: 'Describe the state, then define a decision for the model to make.',
  },
};
const templates = [
  {
    tag: 'CHARACTER',
    title: 'The wandering alchemist',
    subtitle: 'Character concept',
    className: 'art-character',
    image: '/samples/alchemist.png',
    prompt: 'A traveling alchemist in an enchanted forest, detailed fantasy game concept art',
  },
  {
    tag: 'ENVIRONMENT',
    title: 'A world worth exploring',
    subtitle: 'Environment concept',
    className: 'art-world',
    image: '/samples/forest-bridge.png',
    prompt: 'A weathered bridge leading into a forgotten forest, detailed fantasy game concept art',
  },
  {
    tag: 'OBJECT',
    title: 'Small details, big stories',
    subtitle: 'Game asset concept',
    className: 'art-object',
    image: '/samples/potion.png',
    prompt: 'A luminous potion ready for a fantasy inventory, detailed fantasy game concept art',
  },
];
const sampleAssets = [
  {
    id: 'alchemist',
    title: 'Wandering alchemist',
    category: 'Images',
    type: 'CHARACTER',
    file: '/samples/alchemist.png',
    detail: 'Character concept · PNG',
    description: 'A traveling alchemist in an enchanted forest.',
  },
  {
    id: 'bridge',
    title: 'The mistwood crossing',
    category: 'Images',
    type: 'ENVIRONMENT',
    file: '/samples/forest-bridge.png',
    detail: 'Environment concept · PNG',
    description: 'A weathered bridge leading into a forgotten forest.',
  },
  {
    id: 'potion',
    title: 'Potion of the grove',
    category: 'Images',
    type: 'GAME ITEM',
    file: '/samples/potion.png',
    detail: 'Item concept · PNG',
    description: 'A luminous potion ready for a fantasy inventory.',
  },
  {
    id: 'chime',
    title: 'Forest discovery',
    category: 'Audio',
    type: 'SOUND EFFECT',
    file: '/samples/forest-chime.wav',
    detail: 'Sound effect · WAV',
    description: 'A short, synthesized discovery chime.',
  },
];
const initialDrafts = Object.fromEntries(
  Object.keys(configs).map((k) => [
    k,
    { prompt: '', second: '', options: configs[k].options.map((o) => o[1]), seed: '', refs: [] },
  ]),
);
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (error) {
    log.debug('ui.storage.read.failed', { settingKey: key, error });
    return fallback;
  }
}
function App() {
  useRuntimeNotifications();
  const { jobs: runtimeJobs, loading: queueLoading, error: queueError } = useQueueTiming();
  const queueStatus = (id) =>
    pageQueueStatus(id, runtimeJobs, { loading: queueLoading, error: queueError });
  const activeRenderCount = runtimeJobs.filter(
    (job) => !['completed', 'failed', 'cancelled'].includes(job.status),
  ).length;
  const completedHistory = runtimeJobs
    .filter((job) => job.status === 'completed')
    .map((job) => `${job.id}:${job.finishedAt}`)
    .join('|');
  const [section, navigate, routeParams, setRouteParams] = useNav();
  const [drafts, setDrafts] = useState(() => {
    // Damaged or wrongly shaped saved drafts fall back to the defaults field by field.
    return sanitizeDrafts(load('forge-drafts', null), initialDrafts);
  });
  const [renderQueueVersion, setRenderQueueVersion] = useState(0);
  const [submittingMusic, setSubmittingMusic] = useState(false);
  const [renderEstimate, setRenderEstimate] = useState(null),
    [estimateError, setEstimateError] = useState('');
  // Scope and request keys keep the last estimate on screen while a new one loads.
  const estimateScope = useRef('');
  const estimateRequestKey = useRef('');
  const isEstimateFailing = useRef(false);
  const [videoFiles, setVideoFiles] = useState([]);
  const [imageFiles, setImageFiles] = useState([]);
  const imageLoras = useImageLoras(section === 'images');
  const [shapeFiles, setShapeFiles] = useState([]);
  const [segmentationFiles, setSegmentationFiles] = useState([]);
  const [motionPoseFile, setMotionPoseFile] = useState(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  // Compact mode shrinks the desktop menu to an icon rail; the full menu is one click away.
  const [navCompact, setNavCompact] = useState(() => load('forge-nav-compact', false) === true);
  useEffect(() => {
    try {
      localStorage.setItem('forge-nav-compact', JSON.stringify(navCompact));
    } catch (error) {
      log.debug('ui.storage.write.failed', { settingKey: 'forge-nav-compact', error });
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [navCompact]);
  const [desktopNavHidden, setDesktopNavHidden] = useState(
    () => load('forge-nav-hidden', false) === true,
  );
  useEffect(() => {
    try {
      localStorage.setItem('forge-nav-hidden', JSON.stringify(desktopNavHidden));
    } catch (error) {
      log.debug('ui.storage.write.failed', { settingKey: 'forge-nav-hidden', error });
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [desktopNavHidden]);
  const [mobileNavigation, setMobileNavigation] = useState(
    () => window.matchMedia('(max-width: 850px)').matches,
  );
  const menuButtonRef = useRef(null);
  const navigationRef = useRef(null);
  const projectSelectRef = useRef(null);
  const [jobs, setJobs] = useState(() => sanitizeJobList(load('forge-queue', [])));
  const [notice, setNotice] = useState('');
  // Counts failed Voices submits. The voice fields show their errors only after the first one.
  const [voiceSubmitAttempts, setVoiceSubmitAttempts] = useState(0);
  // The last failed submit: which page, which field to focus, and how many attempts so far.
  const [submitAttempt, setSubmitAttempt] = useState({
    section: '',
    forDraft: false,
    count: 0,
    focusId: '',
    errorId: '',
  });
  const [advanced, setAdvanced] = useRouteToggle('advanced');
  const settingsOpen = routeParams.get('dialog') === 'settings';
  const setSettingsOpen = (value) =>
    updateSearch(setRouteParams, { dialog: value ? 'settings' : null });
  const errorsOpen = routeParams.get('dialog') === 'errors';
  const setErrorsOpen = (value) =>
    updateSearch(setRouteParams, { dialog: value ? 'errors' : null, error: null });
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const selectedProjectId = routeParams.get('project') || null;
  const setSelectedProjectId = (id) =>
    updateSearch(setRouteParams, {
      project: id,
      collection: null,
      asset: null,
      preview: null,
      inspect: null,
      convert: null,
      refine: null,
      trashPreview: null,
    });
  const newProjectOpen = routeParams.get('dialog') === 'new-project';
  const setNewProjectOpen = (value) =>
    updateSearch(setRouteParams, { dialog: value ? 'new-project' : null });
  const [draftQueueOpen, setDraftQueueOpen] = useRouteToggle('draftQueue');
  const initialSavedProject = useRef(sanitizeSelectedProject(load('forge-selected-project', null)));
  useEffect(() => {
    if (
      window.location.pathname === '/' &&
      !window.location.search &&
      !window.location.hash &&
      initialSavedProject.current
    ) {
      updateSearch(setRouteParams, { project: initialSavedProject.current }, { replace: true });
    }
  }, [setRouteParams]);
  useEffect(() => {
    try {
      localStorage.setItem('forge-selected-project', JSON.stringify(selectedProjectId));
    } catch (error) {
      log.debug('ui.storage.write.failed', { settingKey: 'forge-selected-project', error });
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [selectedProjectId]);
  const latestProjectsRequest = useRef(0);
  const isProjectsRefreshFailing = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem('forge-drafts', JSON.stringify(drafts));
    } catch (error) {
      log.debug('ui.storage.write.failed', { settingKey: 'forge-drafts', error });
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [drafts]);
  useEffect(() => {
    try {
      localStorage.setItem('forge-queue', JSON.stringify(jobs));
    } catch (error) {
      log.debug('ui.storage.write.failed', { settingKey: 'forge-queue', error });
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [jobs]);
  async function refreshProjects() {
    const request = ++latestProjectsRequest.current;
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) {
        throw Error('Project service unavailable.');
      }
      const data = await response.json();
      if (request === latestProjectsRequest.current) {
        setProjects(data.projects);
        setProjectsError('');
        setProjectsLoading(false);
        if (isProjectsRefreshFailing.current) {
          isProjectsRefreshFailing.current = false;
          log.info('ui.projects.refresh.recovered');
        }
      } else {
        log.debug('ui.projects.refresh.stale', { outcome: 'completed' });
      }
      return data.projects;
    } catch (error) {
      if (request === latestProjectsRequest.current) {
        // Logged once when the poll starts failing, not on every 5 second retry.
        if (!isProjectsRefreshFailing.current) {
          isProjectsRefreshFailing.current = true;
          log.warn('ui.projects.refresh.failed', { error });
        }
        setProjectsError('Could not load projects. Restart the studio.');
        setProjectsLoading(false);
      } else {
        log.debug('ui.projects.refresh.stale', { outcome: 'failed' });
      }
      throw error;
    }
  }
  useEffect(() => {
    const latestProjectsRequestRef = latestProjectsRequest;
    refreshProjects().catch(() => {});
    // log-coverage: ignore -- refreshProjects logs the first failure and the recovery itself
    const timer = setInterval(() => refreshProjects().catch(() => {}), 5000);
    return () => {
      latestProjectsRequestRef.current++;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(''), 2800);
      return () => clearTimeout(t);
    }
  }, [notice]);
  // Error toasts are also kept in the Errors review (src/error-capture.js decides which are errors).
  useEffect(() => {
    reportNoticeError(notice);
  }, [notice]);
  useEffect(() => {
    const onComplete = (e) => {
      showCompletionNotification(e.detail);
      if (e.detail?.type === 'render') {
        setRenderQueueVersion((v) => v + 1);
      }
    };
    window.addEventListener('forge:completion', onComplete);
    return () => window.removeEventListener('forge:completion', onComplete);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 850px)');
    const changed = () => {
      setMobileNavigation(media.matches);
      if (!media.matches) {
        setNavigationOpen(false);
      }
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    setNavigationOpen(false);
  }, [section]);
  useEffect(() => {
    if (!navigationOpen || !mobileNavigation) {
      return;
    }
    const container = navigationRef.current;
    container?.querySelector('.mobile-nav-close')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setNavigationOpen(false);
        menuButtonRef.current?.focus();
      } else if (e.key === 'Tab' && container) {
        const items = [
          ...container.querySelectorAll(
            'button:not([disabled]), select:not([disabled]), a[href], input:not([disabled])',
          ),
        ];
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigationOpen, mobileNavigation]);
  const switchTo = (id, options) => {
    setNavigationOpen(false);
    navigate(id, options);
    if (mobileNavigation) {
      menuButtonRef.current?.focus();
    }
  };
  const activeProject = projects.find((p) => p.id === selectedProjectId) || null;
  async function createProject(name) {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
      body: JSON.stringify({ name }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw Error('The project service is unavailable. Restart the studio.');
    }
    if (!response.ok) {
      throw Error(result.error || 'Could not create the project.');
    }
    setProjects((items) => [result.project, ...items]);
    log.info('ui.project.created', { projectId: result.project.id });
    updateSearch(setRouteParams, {
      project: result.project.id,
      collection: null,
      asset: null,
      dialog: null,
    });
    setNotice('Project created.');
  }
  const current = configs[section];
  const modelParam = routeParams.get('model');
  const draft = useMemo(() => {
    if (!current) {
      return null;
    }
    const allowedModels =
      section === '3d'
        ? ['TRELLIS.2', 'Hunyuan3D 2.1']
        : section === 'motion'
          ? ['HY-Motion 1.0', 'NVIDIA MotionBricks']
          : [];
    return {
      ...initialDrafts[section],
      ...drafts[section],
      ...(allowedModels.length
        ? { model: allowedModels.includes(modelParam) ? modelParam : current.model }
        : {}),
    };
  }, [current, section, drafts, modelParam]);
  const supportsRender =
    ['images', 'music', 'sfx', 'video', 'voices', 'segmentation'].includes(section) ||
    (section === '3d' && ['Hunyuan3D 2.1', 'TRELLIS.2'].includes(draft.model || current.model)) ||
    (section === 'motion' &&
      ['HY-Motion 1.0', 'NVIDIA MotionBricks'].includes(draft.model || current.model));
  const estimateProjectId = activeProject?.id;
  const currentModel = current?.model;
  const selectProject = () => {
    if (activeProject) {
      return true;
    }
    log.info('ui.submit.rejected', { reason: 'no_project', hasProjects: projects.length > 0 });
    setNotice(
      projects.length ? 'Choose a project for this creation.' : 'Create a project to get started.',
    );
    if (projects.length) {
      projectSelectRef.current?.focus();
    } else {
      setNewProjectOpen(true);
    }
    return false;
  };
  useEffect(() => {
    let active = true;
    // Clear the estimate only when the page, project or model changes. Typing in a field or a
    // queue poll must not flash "Checking…" while the next estimate is fetched.
    const scopeKey = `${section}|${estimateProjectId || ''}|${draft?.model || currentModel || ''}`;
    if (estimateScope.current !== scopeKey) {
      estimateScope.current = scopeKey;
      estimateRequestKey.current = '';
      setRenderEstimate(null);
      setEstimateError('');
    }
    if (!supportsRender) {
      return;
    }
    const type =
      section === '3d' && (draft.model || currentModel) === 'TRELLIS.2'
        ? 'trellis'
        : section === 'motion' && draft.model === 'NVIDIA MotionBricks'
          ? 'motion-bricks'
          : section;
    const timer = setTimeout(() => {
      try {
        const input = estimatePayload(
          type,
          estimateProjectId || '00000000-0000-0000-0000-000000000000',
          draft,
        );
        const nearby = estimateFromNearbyHistory(type, input.request, runtimeJobs);
        if (!estimateProjectId) {
          if (active) {
            setRenderEstimate(nearby);
            setEstimateError(nearby ? '' : 'Select a project to check for matching renders.');
          }
          return;
        }
        // Skip the request when nothing that affects the estimate changed (for example a queue
        // poll that returned the same jobs).
        const requestKey = JSON.stringify([
          type,
          estimateProjectId,
          input.request,
          renderQueueVersion,
          completedHistory?.length ?? 0,
        ]);
        if (estimateRequestKey.current === requestKey) {
          return;
        }
        estimateRequestKey.current = requestKey;
        estimateRender(type, estimateProjectId, draft)
          .then((result) => {
            if (estimateRequestKey.current === requestKey) {
              setRenderEstimate(result.available ? result : nearby || result);
              setEstimateError('');
              if (isEstimateFailing.current) {
                isEstimateFailing.current = false;
                log.info('ui.estimate.recovered', { kind: type });
              }
            } else {
              log.debug('ui.estimate.stale', { kind: type, outcome: 'completed' });
            }
          })
          .catch((error) => {
            if (estimateRequestKey.current === requestKey) {
              // Logged once per run of failures, not on every edit that triggers a new estimate.
              if (!isEstimateFailing.current) {
                isEstimateFailing.current = true;
                log.warn('ui.estimate.failed', {
                  kind: type,
                  hasFallback: Boolean(nearby),
                  ...errorFields(error),
                });
              }
              setRenderEstimate(nearby);
              setEstimateError(nearby ? '' : 'Could not check render timing.');
            } else {
              log.debug('ui.estimate.stale', { kind: type, outcome: 'failed' });
            }
          });
      } catch (reason) {
        log.debug('ui.estimate.payload.failed', { kind: type, ...errorFields(reason) });
        if (active) {
          setEstimateError(reason.message || 'Check the render settings.');
        }
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    section,
    estimateProjectId,
    currentModel,
    draft,
    runtimeJobs,
    supportsRender,
    renderQueueVersion,
    completedHistory,
  ]);
  const update = (values) =>
    setDrafts((d) => ({
      ...d,
      [section]: { ...initialDrafts[section], ...d[section], ...values },
    }));
  // Reset to defaults is gated twice: it stays disabled while the page already matches its defaults,
  // and an enabled click only arms an inline confirmation instead of discarding work immediately.
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => setResetArmed(false), [section]);
  const pageIsDirty = (() => {
    if (!current) {
      return false;
    }
    const base = initialDrafts[section];
    const saved = drafts[section] || {};
    const changedDraft = Object.keys({ ...base, ...saved }).some(
      (key) =>
        key !== 'refs' && JSON.stringify(saved[key] ?? base[key]) !== JSON.stringify(base[key]),
    );
    const filesChosen =
      (section === 'video' && videoFiles.length > 0) ||
      (section === 'images' && imageFiles.length > 0) ||
      (section === '3d' && shapeFiles.length > 0) ||
      (section === 'segmentation' && segmentationFiles.length > 0) ||
      (section === 'motion' && Boolean(motionPoseFile));
    const modelChanged = Boolean(modelParam) && modelParam !== current.model;
    return changedDraft || filesChosen || modelChanged;
  })();
  const resetToDefaults = () => {
    setDrafts((d) => ({ ...d, [section]: { ...initialDrafts[section] } }));
    if (section === 'video') {
      setVideoFiles([]);
      clearVideoFrames();
    }
    if (section === 'images') {
      setImageFiles([]);
    }
    if (section === '3d') {
      setShapeFiles([]);
    }
    if (section === 'segmentation') {
      setSegmentationFiles([]);
    }
    if (section === 'motion') {
      setMotionPoseFile(null);
    }
    if (modelParam) {
      updateSearch(setRouteParams, { model: null });
    }
    setResetArmed(false);
    setNotice(`${current.title} settings were reset to their defaults.`);
    // The confirm buttons just unmounted; give keyboard focus back to the first field instead of losing it.
    setTimeout(() => {
      document
        .querySelector('.editor-page .form-panel :is(textarea, select, input:not([type=hidden]))')
        ?.focus();
    }, 0);
  };
  // Required-field problems are collected on a failed submit and shown beside each field. They
  // are recomputed on every render, so a message clears as soon as its field is fixed.
  const validationInput = (forDraft) => ({
    section,
    draft,
    forDraft,
    model: draft.model || current.model,
    files: {
      imageFiles,
      videoFiles,
      shapeFiles,
      segmentationFiles,
      motionPoseFile,
      videoFrames: getVideoFrames(),
    },
  });
  const shownProblems =
    submitAttempt.section === section && submitAttempt.count > 0
      ? creationFieldErrors(validationInput(submitAttempt.forDraft))
      : [];
  const problemFor = (field) => shownProblems.find((problem) => problem.field === field);
  const describedBy = (field, ...others) =>
    [...others, problemFor(field)?.id].filter(Boolean).join(' ') || undefined;
  // Returns true when the page is not ready: the toast only summarises, the messages sit beside
  // the fields, and focus moves to the first invalid one.
  const blockInvalidSubmit = (forDraft = false) => {
    const problems = creationFieldErrors(validationInput(forDraft));
    if (!problems.length) {
      return false;
    }
    setSubmitAttempt((previous) => ({
      section,
      forDraft,
      count: previous.count + 1,
      focusId: problems[0].focusId,
      errorId: problems[0].id,
    }));
    if (section === 'voices') {
      setVoiceSubmitAttempts((count) => count + 1);
    }
    log.info('ui.submit.rejected', {
      page: section,
      reason: 'invalid_fields',
      count: problems.length,
      isDraft: forDraft,
    });
    setNotice(validationSummary(problems));
    return true;
  };
  useEffect(() => {
    if (!submitAttempt.count) {
      return;
    }
    const target =
      document.getElementById(submitAttempt.focusId) ||
      document.getElementById(submitAttempt.errorId);
    target?.focus();
  }, [submitAttempt]);
  const addJob = () => {
    if (blockInvalidSubmit(true)) {
      return;
    }
    if (section === 'game') {
      setNotice('Game logic draft saved in this browser.');
      return;
    }
    if (!selectProject()) {
      return;
    }
    setJobs((q) => [
      ...q,
      {
        id: crypto.randomUUID(),
        kind: section,
        draftSnapshot: { ...draft },
        prompt:
          draft.prompt ||
          (section === '3d' ? `3D model from ${draft.refs[0].name}` : 'MotionBricks motion draft'),
        second: draft.second,
        model: ['3d', 'motion'].includes(section) ? draft.model || current.model : current.model,
        options: draft.options,
        refs: draft.refs,
        characterFile: draft.characterFile || null,
        poseFile: draft.poseFile || null,
        motionRig: draft.motionRig || 'SOMA human',
        seed: draft.seed,
        projectId: activeProject.id,
        projectName: activeProject.name,
        created: Date.now(),
      },
    ]);
    log.info('ui.draft.added', { kind: section, projectId: activeProject.id });
    setNotice('Added to your project draft queue.');
  };
  const addReferenceFiles = (files) => {
    const refs = files.map((f) => ({ name: f.name, size: f.size }));
    let skippedNote = '',
      addedNothing = false;
    if (files.length) {
      if (section === 'video' || section === 'images') {
        const isVideo = section === 'video',
          limit = isVideo ? 9 : 10,
          current = isVideo ? videoFiles : imageFiles;
        // Say what was left out instead of silently dropping files.
        const wrongType = files.filter(
          (f) => !/^image\/(png|jpeg|webp)$/.test(f.type) && !/\.(png|jpe?g|webp)$/i.test(f.name),
        );
        const tooBig = files.filter((f) => !wrongType.includes(f) && f.size > 10 * 1024 * 1024);
        const usable = files.filter((f) => !wrongType.includes(f) && !tooBig.includes(f));
        const overflow = Math.max(0, usable.length - Math.max(0, limit - current.length));
        const skipped = [
          wrongType.length ? `${wrongType.length} not PNG, JPEG, or WebP` : '',
          tooBig.length ? `${tooBig.length} over 10 MiB` : '',
          overflow ? `${overflow} beyond the ${limit}-image limit` : '',
        ].filter(Boolean);
        skippedNote = skipped.length ? ` Skipped: ${skipped.join(', ')}.` : '';
        const combined = [...current, ...usable].slice(0, limit);
        addedNothing = combined.length === current.length;
        if (isVideo) {
          setVideoFiles(combined);
        } else {
          setImageFiles(combined);
        }
        update({ refs: combined.map((f) => ({ name: f.name, size: f.size })) });
      } else if (section === '3d' || section === 'segmentation') {
        if (section === '3d') {
          setShapeFiles(files.slice(0, 1));
        } else {
          setSegmentationFiles(files.slice(0, 1));
        }
        update({ refs: refs.slice(0, 1) });
      } else {
        update({ refs: [...draft.refs, ...refs].slice(0, 10) });
      }
    }
    if (files.length) {
      setNotice(
        addedNothing && skippedNote
          ? `No reference images added.${skippedNote}`
          : `Reference images selected.${skippedNote}`,
      );
    }
  };
  const addRefs = (event) => {
    addReferenceFiles(Array.from(event.target.files || []));
    event.target.value = '';
  };
  const renderMusic = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueMusic(activeProject.id, draft);
      setRenderQueueVersion((v) => v + 1);
      log.info('ui.queue.submitted', { kind: 'music', projectId: activeProject.id });
      setNotice('Music render added to the durable queue.');
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('music', activeProject.id, error));
      setNotice(`Could not queue music: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderSound = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueSound(activeProject.id, draft);
      setRenderQueueVersion((v) => v + 1);
      log.info('ui.queue.submitted', { kind: 'sfx', projectId: activeProject.id });
      setNotice('Sound effect added to the durable queue.');
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('sfx', activeProject.id, error));
      setNotice(`Could not queue sound: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderShape = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    const fromText = draft.threeDMode === 'text';
    setSubmittingMusic(true);
    try {
      const fallbackModel = current.model;
      const alphaStatus = fromText ? 'unknown' : alphaStatusFor(shapeFiles[0], draft.refAlpha);
      const queued = fromText
        ? await enqueueTextTo3d(activeProject.id, draft, { fallbackModel })
        : await enqueueThreeD(activeProject.id, draft, shapeFiles[0], {
            fallbackModel,
            alphaStatus,
          });
      setRenderQueueVersion((v) => v + 1);
      log.info('ui.queue.submitted', {
        kind: '3d',
        projectId: activeProject.id,
        mode: fromText ? 'text' : 'image',
        isChained: Boolean(queued.chained),
      });
      setNotice(
        queued.chained
          ? fromText
            ? 'Picture and 3D model added to the durable queue. The model waits for the picture.'
            : 'Cutout and 3D model added to the durable queue. The model waits for the cutout.'
          : draft.removeBackground && alphaStatus === 'transparent'
            ? '3D shape added to the durable queue. The picture already had a transparent background, so nothing was cut out.'
            : '3D shape added to the durable queue.',
      );
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('3d', activeProject.id, error));
      setNotice(`Could not queue 3D shape: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderSegmentation = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueSegmentation(activeProject.id, draft, segmentationFiles[0]);
      setRenderQueueVersion((v) => v + 1);
      log.info('ui.queue.submitted', { kind: 'segmentation', projectId: activeProject.id });
      setNotice('Segmentation added to the durable queue.');
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('segmentation', activeProject.id, error));
      setNotice(`Could not queue segmentation: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderMotion = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    const bricks = draft.model === 'NVIDIA MotionBricks';
    setSubmittingMusic(true);
    try {
      if (bricks) {
        await enqueueMotionBricks(activeProject.id, draft, motionPoseFile);
        setNotice('Motion clip added to the durable queue.');
      } else {
        const variations = hyMotionVariationCount(draft);
        await enqueueMotion(activeProject.id, draft);
        setNotice(
          variations > 1
            ? `${variations} motion clips added to the durable queue.`
            : 'Motion clip added to the durable queue.',
        );
      }
      log.info('ui.queue.submitted', {
        kind: 'motion',
        projectId: activeProject.id,
        mode: bricks ? 'motionbricks' : 'hymotion',
      });
      setRenderQueueVersion((v) => v + 1);
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('motion', activeProject.id, error));
      setNotice(`Could not queue motion: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderVoice = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    const voiceError = firstVoiceModeError(voiceModeFieldErrors(draft));
    if (voiceError) {
      setVoiceSubmitAttempts((count) => count + 1);
      log.info('ui.submit.rejected', { page: 'voices', reason: 'invalid_voice_mode' });
      setNotice(voiceError);
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueVoice(activeProject.id, draft);
      setRenderQueueVersion((v) => v + 1);
      log.info('ui.queue.submitted', { kind: 'voices', projectId: activeProject.id });
      setNotice('Voice added to the durable queue.');
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('voices', activeProject.id, error));
      setNotice(`Could not queue voice: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderImage = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueImage(activeProject.id, draft, imageFiles);
      setRenderQueueVersion((v) => v + 1);
      const variations = Number(draft.imageVariations) || 1;
      log.info('ui.queue.submitted', {
        kind: 'images',
        projectId: activeProject.id,
        variationCount: variations,
      });
      setNotice(
        variations > 1
          ? `${variations} image variations added to the durable queue.`
          : 'Image added to the durable queue.',
      );
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('images', activeProject.id, error));
      setNotice(`Could not queue image: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  // First/last frame and text-only videos take no reference images.
  // The 3D page hides the reference picker when the model starts from a description.
  const showRefs =
    !(section === 'video' && ['frames', 'text'].includes(draft.videoSource)) &&
    !(section === '3d' && draft.threeDMode === 'text');
  const renderVideo = async () => {
    if (!selectProject() || blockInvalidSubmit()) {
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueVideo(activeProject.id, draft, videoFiles);
      setRenderQueueVersion((v) => v + 1);
      log.info('ui.queue.submitted', { kind: 'video', projectId: activeProject.id });
      setNotice('Video added to the durable queue.');
    } catch (error) {
      log.warn('ui.queue.rejected', queueRejection('video', activeProject.id, error));
      setNotice(`Could not queue video: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const openDraft = (job) => {
    if (!configs[job.kind]) {
      log.warn('ui.draft.open.rejected', { reason: 'unknown_kind' });
      setNotice('This draft type is unavailable.');
      return;
    }
    log.info('ui.draft.opened', { kind: job.kind });
    setDrafts((d) => ({
      ...d,
      [job.kind]: {
        ...initialDrafts[job.kind],
        ...d[job.kind],
        ...(job.draftSnapshot || {}),
        prompt: job.draftSnapshot?.prompt ?? job.prompt ?? '',
        second: job.second || '',
        options: job.options || initialDrafts[job.kind].options,
        refs: job.refs || [],
        model: job.model,
        seed: job.seed ?? '',
        characterFile: job.characterFile || null,
        poseFile: job.poseFile || null,
        motionRig: job.motionRig,
      },
    }));
    if (job.kind === 'video') {
      setVideoFiles([]);
      clearVideoFrames();
    }
    if (job.kind === 'images') {
      setImageFiles([]);
    }
    if (job.kind === '3d') {
      setShapeFiles([]);
    }
    if (job.kind === 'segmentation') {
      setSegmentationFiles([]);
    }
    if (job.kind === 'motion') {
      setMotionPoseFile(null);
    }
    switchTo(job.kind, {
      project: projects.some((project) => project.id === job.projectId) ? job.projectId : null,
      model: ['3d', 'motion'].includes(job.kind) ? job.model : null,
    });
    setNotice(
      ['video', 'images', '3d', 'segmentation'].includes(job.kind) && job.refs?.length
        ? 'Draft opened. Select reference images again before rendering.'
        : 'Draft opened for editing.',
    );
  };
  // Reuse an asset's recorded model, prompt and settings. Reference files are never attached.
  const reuseSettings = (meta, projectId) => {
    const plan = reusePlan(meta);
    if (!plan) {
      log.info('ui.settings.reuse.rejected', { reason: 'no_plan' });
      setNotice('These settings cannot be reused on a creation page.');
      return;
    }
    if (plan.section === 'vegetation') {
      // The Vegetation page reads this once when it opens and moves it into its address.
      stashReuse(plan.vegetation);
      switchTo('vegetation', { project: projectId || null });
      setNotice('Vegetation page opened with the settings from the asset.');
      return;
    }
    if (plan.section === 'world') {
      try {
        // The World page reads this once when it opens; the prompt can be too long for the address.
        window.sessionStorage.setItem('forge-world-reuse', JSON.stringify(plan.world));
      } catch (error) {
        log.debug('ui.storage.write.failed', { settingKey: 'forge-world-reuse', error });
        // Without session storage only the generator is selected.
      }
      switchTo('world', { project: projectId || null, model: plan.model });
      setNotice('World page opened with the settings from the asset. Choose reference images again.');
      return;
    }
    openDraft(draftJob(plan, projectId));
    setNotice(
      meta.references?.length
        ? 'Settings reused. Reference files are not attached automatically; choose them again.'
        : 'Settings reused from the asset.',
    );
  };
  return (
    <div className={'app-shell ' + (!mobileNavigation && desktopNavHidden ? 'nav-hidden' : '')}>
      <a className="skip-link" href="#studio-main">
        Skip to content
      </a>
      {mobileNavigation && navigationOpen && (
        <button
          className="mobile-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => {
            setNavigationOpen(false);
            menuButtonRef.current?.focus();
          }}
        />
      )}
      <aside
        ref={navigationRef}
        id="studio-navigation"
        className={
          'sidebar ' +
          (navigationOpen ? 'sidebar-open ' : '') +
          (!mobileNavigation && navCompact ? 'is-compact' : '')
        }
        inert={mobileNavigation ? !navigationOpen : desktopNavHidden}
      >
        <div className="brand">
          <div className="brand-mark">
            <span>✳</span>
          </div>
          <div>
            <strong>
              forge<span className="brand-dot">.</span>
            </strong>
            <small>GAME DEVELOPMENT STUDIO</small>
          </div>
          <button
            className="mobile-nav-close icon-btn"
            aria-label="Close navigation"
            onClick={() => {
              setNavigationOpen(false);
              menuButtonRef.current?.focus();
            }}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace">
          <label className="workspace-label" htmlFor="sidebar-project-select">
            Current project
          </label>
          <select
            id="sidebar-project-select"
            title={activeProject?.name || 'Select a project'}
            value={activeProject?.id || ''}
            onChange={(e) => setSelectedProjectId(e.target.value || null)}
          >
            <option value="">Select a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="nav-heading">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {nav.map(({ id, label, icon: Icon }) => {
            const status = queueStatus(id);
            return (
              <button
                key={id}
                aria-label={status ? `${label}. ${status.detail}` : label}
                title={status ? `${label}: ${status.detail}` : label}
                className={'nav-item ' + (section === id ? 'active' : '')}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => switchTo(id)}
              >
                <Icon size={17} />
                <span>{label}</span>
                {status && (
                  <span className={`nav-queue-status ${status.state}`} aria-hidden="true">
                    <i />
                    {status.state === 'free' ? 'No jobs' : status.short}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="nav-heading lower">YOUR STUDIO</div>
        <button
          aria-label={
            activeRenderCount
              ? `Render queue, ${activeRenderCount} active or waiting`
              : 'Render queue'
          }
          title="Render queue"
          className={'nav-item ' + (section === 'queue' ? 'active' : '')}
          aria-current={section === 'queue' ? 'page' : undefined}
          onClick={() => switchTo('queue')}
        >
          <ListChecks size={17} />
          <span>Render queue</span>
          {activeRenderCount > 0 && (
            <span className="nav-queue-count" aria-hidden="true">
              {activeRenderCount}
            </span>
          )}
        </button>
        <button
          aria-label="Asset library"
          title="Asset library"
          className={'nav-item ' + (section === 'assets' ? 'active' : '')}
          aria-current={section === 'assets' ? 'page' : undefined}
          onClick={() => switchTo('assets')}
        >
          <FolderOpen size={17} />
          <span>Asset library</span>
        </button>
        <button
          aria-label="Megascans"
          title="Megascans"
          className={'nav-item ' + (section === 'megascans' ? 'active' : '')}
          aria-current={section === 'megascans' ? 'page' : undefined}
          onClick={() => switchTo('megascans')}
        >
          <PackageOpen size={17} />
          <span>Megascans</span>
        </button>
        <button
          aria-label="Models and services"
          title="Models and services"
          className={'nav-item ' + (section === 'models' ? 'active' : '')}
          aria-current={section === 'models' ? 'page' : undefined}
          onClick={() => switchTo('models')}
        >
          <Layers3 size={17} />
          <span>Models & services</span>
        </button>
        <button
          aria-label="Diagnostics"
          title="Diagnostics"
          className={'nav-item ' + (section === 'diagnostics' ? 'active' : '')}
          aria-current={section === 'diagnostics' ? 'page' : undefined}
          onClick={() => switchTo('diagnostics')}
        >
          <Terminal size={17} />
          <span>Diagnostics</span>
        </button>
        {!mobileNavigation && (
          <button
            type="button"
            className="nav-item nav-compact-toggle"
            aria-pressed={navCompact}
            data-log-action="nav.compact.toggle"
            aria-label={navCompact ? 'Expand menu' : 'Make menu smaller'}
            title={navCompact ? 'Expand menu' : 'Make menu smaller'}
            onClick={() => setNavCompact((value) => !value)}
          >
            {navCompact ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
            <span>{navCompact ? 'Expand menu' : 'Make menu smaller'}</span>
          </button>
        )}
      </aside>
      <main id="studio-main" className="main" tabIndex={-1}>
        <header className="topbar">
          <div className="topbar-location">
            <button
              ref={menuButtonRef}
              className="mobile-nav-toggle icon-btn"
              aria-label={
                (mobileNavigation ? !navigationOpen : desktopNavHidden)
                  ? 'Open navigation'
                  : 'Close navigation'
              }
              title={
                (mobileNavigation ? !navigationOpen : desktopNavHidden)
                  ? 'Open navigation'
                  : 'Close navigation'
              }
              aria-expanded={mobileNavigation ? navigationOpen : !desktopNavHidden}
              aria-controls="studio-navigation"
              data-log-action="nav.menu.toggle"
              onClick={() =>
                mobileNavigation
                  ? setNavigationOpen((value) => !value)
                  : setDesktopNavHidden((value) => !value)
              }
            >
              {mobileNavigation ? (
                <Menu size={22} />
              ) : desktopNavHidden ? (
                <PanelLeftOpen size={21} />
              ) : (
                <PanelLeftClose size={21} />
              )}
            </button>
            <div className="breadcrumb">
              Workspace <span>/</span>{' '}
              <strong>
                {section === 'overview'
                  ? 'Overview'
                  : current?.title ||
                    (section === 'megascans'
                    ? 'Megascans'
                    : section === 'chat'
                      ? 'Chat'
                      : section === 'world'
                        ? 'Worlds'
                        : section === 'vegetation'
                          ? 'Vegetation'
                        : section === 'queue'
                          ? 'Render queue'
                          : section === 'assets'
                            ? 'Asset library'
                            : section === 'diagnostics'
                              ? 'Diagnostics'
                              : section === 'models'
                                ? 'Models & services'
                                : 'Page not found')}
              </strong>
            </div>
            {queueStatus(section) && !['free', 'unknown'].includes(queueStatus(section).state) && (
              <span
                className={`page-queue-status ${queueStatus(section).state}`}
                title={queueStatus(section).detail}
                aria-label={`This page: ${queueStatus(section).detail}`}
              >
                <i />
                {queueStatus(section).short}
              </span>
            )}
          </div>
          <div className="top-actions">
            <LanguageMenu section={section} allowPseudo={import.meta.env.DEV} />
            <ErrorsButton onOpen={() => setErrorsOpen(true)} isOpen={errorsOpen} />
            <QueueTimingBadge onOpen={() => switchTo('queue')} />
            <ConnectionStatus />
            <button
              type="button"
              className="prototype prototype-button"
              title="Early access: see which panels render and which are previews"
              aria-label="About this preview"
              onClick={() =>
                setNotice(
                  'Early access. Images, video, music, sound effects, voices, Hunyuan shapes, HY-Motion, SAM segmentation, and game decisions have initial integrations; other panels remain previews.',
                )
              }
            >
              Early access
            </button>
            <button
              className="icon-btn"
              title="Studio settings"
              aria-label="Studio settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>
        <RecoveryPanel />
        {section === 'overview' ? (
          <div className="page overview">
            <div className="intro-row">
              <div>
                <div className="overline">
                  <span className="overline-line" /> Welcome to Forge
                </div>
                <h1>
                  Your ideas, <em>in the making.</em>
                </h1>
                <p className="lead">
                  A creative workspace for the assets that bring your game to life.
                </p>
              </div>
            </div>
            <section className="workspace-hero">
              <div className="workspace-hero-copy">
                <div className="hero-eyebrow">
                  <span className="hero-spark">✳</span>{' '}
                  {activeProject ? 'Current project' : 'Your workspace'}
                </div>
                <h2>{activeProject ? activeProject.name : 'A home for your next world.'}</h2>
                <p>
                  {activeProject
                    ? 'Your assets, renders, and ideas are together in this project.'
                    : 'Create or select a project to keep everything you make together.'}
                </p>
                <div className="hero-actions">
                  <button
                    className="primary"
                    onClick={() => (activeProject ? switchTo('images') : setNewProjectOpen(true))}
                  >
                    {activeProject ? 'Create an asset' : 'Create a project'}{' '}
                    <ArrowRight size={16} />
                  </button>
                  <button className="hero-link" onClick={() => switchTo('assets')}>
                    {activeProject ? 'Open asset library' : 'Explore the library'}{' '}
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
              <div className="workspace-hero-aside">
                {activeProject?.assets.some(isVisualAsset) ? (
                  <AssetThumbnail
                    asset={activeProject.assets.find(isVisualAsset)}
                    project={activeProject}
                  />
                ) : (
                  <img src="/samples/forest-bridge.png" alt="" />
                )}
                <span>
                  {activeProject?.assets.some(isVisualAsset)
                    ? 'From your project'
                    : 'Sample artwork'}
                </span>
              </div>
            </section>
            {projectsError && (
              <p className="project-error" role="alert">
                {projectsError}
              </p>
            )}
            <RecentProjects
              projects={projects}
              loading={projectsLoading}
              onNew={() => setNewProjectOpen(true)}
              onOpen={(project) => switchTo('assets', { project: project.id })}
              onViewAll={() => switchTo('assets', { project: selectedProjectId })}
            />
            <div className="section-title">
              <div>
                <h2>Choose a tool</h2>
              </div>
            </div>
            <div className="tool-grid">
              {[
                ['images', ImageIcon, 'Images', 'Characters, environments & assets', 'mint'],
                [
                  'video',
                  Clapperboard,
                  'Video',
                  'Animate reference images into short clips',
                  'violet',
                ],
                ['music', Music2, 'Music', 'Soundtracks for every story', 'peach'],
                ['sfx', AudioLines, 'Sound effects', 'The details you can hear', 'blue'],
                [
                  '3d',
                  Box,
                  '3D models',
                  'Shapes from a reference image, optionally painted',
                  'yellow',
                ],
                ['vegetation', Trees, 'Vegetation', 'Procedural trees and shrubs, no GPU', 'mint'],
                ['world', Cloud, 'Worlds', 'Explorable 3D scenes from text or images', 'violet'],
                [
                  'motion',
                  PersonStanding,
                  'Character motion',
                  'Experimental clips, no auto-rigging',
                  'mint',
                ],
                ['voices', Mic2, 'Voices', 'Preset character voices and transcription', 'rose'],
                [
                  'segmentation',
                  Scissors,
                  'Segmentation',
                  'Cut out objects in images with text',
                  'yellow',
                ],
                ['game', Gamepad2, 'Game logic', 'Decisions for your game world', 'blue'],
              ].map(([id, Icon, title, desc, color]) => (
                <button className="tool-card" key={id} onClick={() => switchTo(id)}>
                  <div className={'tool-icon ' + color}>
                    <Icon size={20} />
                  </div>
                  {id === 'game' && <span className="tool-availability">DECISIONS</span>}
                  <strong>{title}</strong>
                  <span className="tool-description">{desc}</span>
                  <ArrowRight size={15} className="tool-arrow" />
                </button>
              ))}
            </div>
            <div className="bottom-grid">
              <section className="panel inspiration">
                <div className="panel-heading">
                  <div>
                    <span className="mini-label">A LITTLE INSPIRATION</span>
                    <h2>Start with a spark</h2>
                  </div>
                  <button className="link-button" onClick={() => switchTo('images')}>
                    Create an image <ArrowRight size={14} />
                  </button>
                </div>
                <div className="inspiration-grid">
                  {templates.map((t) => (
                    <button
                      className="inspo-card"
                      key={t.tag}
                      onClick={() => {
                        const hadPrompt = Boolean(drafts.images?.prompt?.trim());
                        setDrafts((d) => ({
                          ...d,
                          images: { ...d.images, prompt: t.prompt },
                        }));
                        setNotice(
                          hadPrompt
                            ? 'Sample prompt replaced your image prompt.'
                            : 'Sample prompt added to Images.',
                        );
                        switchTo('images');
                      }}
                    >
                      <div className={'inspo-art ' + t.className}>
                        <img src={t.image} alt="" loading="lazy" />
                      </div>
                      <span className="inspo-tag">{t.tag} · SAMPLE</span>
                      <strong>{t.title}</strong>
                      <small>{t.subtitle}</small>
                    </button>
                  ))}
                </div>
              </section>
              <Queue jobs={jobs} setJobs={setJobs} compact onOpenDraft={openDraft} />
            </div>
          </div>
        ) : current ? (
          <div className="page editor-page">
            <div className="editor-title">
              <div>
                <div className="overline">
                  <span className="overline-line" /> {current.eyebrow}
                </div>
                <h1>
                  {current.title}
                  <em>.</em>
                </h1>
                <p className="lead">{current.description}</p>
              </div>
              <ModelPlaque
                model={
                  ['3d', 'motion'].includes(section) ? draft.model || current.model : current.model
                }
                supportsRender={supportsRender}
                isGame={section === 'game'}
                hasModelSelector={['3d', 'motion'].includes(section)}
                budget={section === 'video' ? videoBudgetLabel(draft) : null}
              />
            </div>
            <div className={'creation-context' + (activeProject ? ' has-project' : '')}>
              <div className="creation-context-icon">
                <FolderOpen size={19} />
              </div>
              <div className="creation-context-copy">
                <span>Project</span>
                <strong>{activeProject ? activeProject.name : 'Choose where this belongs'}</strong>
                <small>
                  {activeProject
                    ? 'Your creations are saved in this project.'
                    : 'Select a project or create a new one.'}
                </small>
              </div>
              <select
                ref={projectSelectRef}
                aria-label="Project for this creation"
                value={activeProject?.id || ''}
                onChange={(e) => setSelectedProjectId(e.target.value || null)}
              >
                <option value="">Select a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="context-new" onClick={() => setNewProjectOpen(true)}>
                <Plus size={15} /> New <span>project</span>
              </button>
            </div>
            <div className="editor-layout">
              <div>
                <section className="panel form-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        {section === 'segmentation' ? 'Object selection' : 'Creative direction'}
                      </h2>
                    </div>
                    <div className="subtle-icon">
                      <current.icon size={18} />
                    </div>
                  </div>
                  {section === '3d' && (
                    <>
                      <label htmlFor="model3d" className="field-label">
                        3D model
                      </label>
                      <select
                        id="model3d"
                        className="model3d-select"
                        value={draft.model || current.model}
                        onChange={(e) => {
                          update({ model: e.target.value });
                          updateSearch(setRouteParams, { model: e.target.value });
                        }}
                      >
                        <option value="Hunyuan3D 2.1">
                          Hunyuan3D 2.1 · shape, optional texture
                        </option>
                        <option value="TRELLIS.2">TRELLIS.2 · experimental textured model</option>
                      </select>
                      <p className="helper">
                        Hunyuan creates an untextured shape and can optionally paint it
                        (experimental). TRELLIS.2 creates an experimental textured model and
                        needs a transparent PNG or WebP, or an image whose background Forge
                        removes first. Both save a GLB; the asset library can convert it to
                        OBJ, PLY, STL or glTF. Multi-view input is not supported.
                      </p>
                      <ThreeDModeSwitch
                        draft={draft}
                        onChange={update}
                        descriptionError={problemFor('description')?.message}
                        trellis={(draft.model || current.model) === 'TRELLIS.2'}
                      />
                    </>
                  )}
                  {section === 'motion' && (
                    <>
                      <label htmlFor="motion-model" className="field-label">
                        Motion model
                      </label>
                      <select
                        id="motion-model"
                        className="model3d-select"
                        value={draft.model || current.model}
                        onChange={(e) => {
                          update({ model: e.target.value });
                          // The page reads the model from the link, like the 3D model picker.
                          updateSearch(setRouteParams, { model: e.target.value });
                        }}
                      >
                        <option>HY-Motion 1.0</option>
                        <option>NVIDIA MotionBricks</option>
                      </select>
                      <p className="helper">
                        {draft.model === 'NVIDIA MotionBricks'
                          ? 'MotionBricks generates transitions from recent and target poses.'
                          : 'HY-Motion generates human motion from a text description.'}{' '}
                        These models create motion; automatic skeleton creation and retargeting
                        require separate tools.
                      </p>
                    </>
                  )}
                  {!(section === 'motion' && draft.model === 'NVIDIA MotionBricks') &&
                    !(section === '3d' && supportsRender) && (
                      <>
                        <label htmlFor="prompt" className="field-label">
                          {section === '3d' && supportsRender
                            ? 'Creative notes (draft only)'
                            : section === 'motion' && draft.model === 'NVIDIA MotionBricks'
                              ? 'Motion notes'
                              : current.prompt}
                          <span>
                            {section === '3d' ||
                            (section === 'motion' && draft.model === 'NVIDIA MotionBricks')
                              ? 'OPTIONAL'
                              : 'REQUIRED'}
                          </span>
                        </label>
                        <textarea
                          id="prompt"
                          maxLength={
                            section === 'segmentation' ||
                            section === 'motion' ||
                            section === 'voices'
                              ? 1000
                              : ['video', 'images', 'sfx'].includes(section)
                                ? 4000
                                : section === 'music'
                                  ? 2000
                                  : undefined
                          }
                          value={draft.prompt}
                          onChange={(e) => update({ prompt: e.target.value })}
                          aria-invalid={problemFor('prompt') ? 'true' : undefined}
                          aria-describedby={describedBy('prompt')}
                          placeholder={
                            section === 'motion' && draft.model === 'NVIDIA MotionBricks'
                              ? 'Optional notes about the target pose or scene...'
                              : current.placeholder
                          }
                        />
                        <FieldError id="prompt-error" message={problemFor('prompt')?.message} />
                        <div className="prompt-foot">
                          <span>
                            <Sparkles size={13} />{' '}
                            {section === 'motion' && draft.model === 'NVIDIA MotionBricks'
                              ? 'Provide recent and target pose data to guide a transition.'
                              : current.tip}
                          </span>
                          <span>
                            {section === 'segmentation' || section === 'motion'
                              ? `${draft.prompt.length} / 1000 characters`
                              : section === 'music'
                                ? `${draft.prompt.length} / 2000 characters`
                                : section === 'sfx'
                                  ? `${draft.prompt.length} / 4000 characters`
                                  : `${draft.prompt.length} characters`}
                          </span>
                        </div>
                      </>
                    )}
                  {section === 'motion' && draft.model === 'NVIDIA MotionBricks' && (
                    <MotionBricksControls
                      draft={draft}
                      onChange={update}
                      file={motionPoseFile}
                      onFile={setMotionPoseFile}
                      sourceError={problemFor('pose')?.message}
                      onLibrary={() => updateSearch(setRouteParams, { picker: 'pose' })}
                    />
                  )}
                  {section === 'music' && (
                    <>
                      <label className="field-label" htmlFor="extra">
                        Lyrics <span>REQUIRED FOR RENDER</span>
                      </label>
                      <textarea
                        id="extra"
                        className="short-text"
                        value={draft.second}
                        onChange={(e) => update({ second: e.target.value })}
                        maxLength={20000}
                        aria-invalid={problemFor('lyrics') ? 'true' : undefined}
                        aria-describedby={describedBy('lyrics')}
                        placeholder="[Verse] Write your lyrics here..."
                      />
                      <FieldError id="extra-error" message={problemFor('lyrics')?.message} />
                      <p className="helper">
                        Use section tags such as [Verse] or [Chorus]. Write [Instrumental] for an
                        instrumental track.
                      </p>
                    </>
                  )}
                  {section === 'voices' && (
                    <VoiceModeControls
                      project={activeProject}
                      projects={projects}
                      draft={draft}
                      update={update}
                      submitAttempts={voiceSubmitAttempts}
                    />
                  )}
                  {section === 'game' && (
                    <>
                      <label className="field-label" htmlFor="extra">
                        {draft.options[0] === 'Yes / No' ? 'Question' : 'Question and choices'}{' '}
                        <span>REQUIRED FOR A TEST</span>
                      </label>
                      <textarea
                        id="extra"
                        className="short-text"
                        value={draft.second}
                        onChange={(e) => update({ second: e.target.value })}
                        placeholder={
                          draft.options[0] === 'Yes / No'
                            ? 'Should the guard allow the player through?'
                            : draft.options[0] === 'Score'
                              ? 'How dangerous is the situation?\n1. Safe\n2. Cautious\n3. Dangerous'
                              : 'What should the guard do?\n1. Let the player pass\n2. Ask for identification'
                        }
                        aria-describedby="extra-help"
                      />
                      <p id="extra-help" className="helper">
                        {draft.options[0] === 'Yes / No'
                          ? 'One question. Mammoth returns the probability that the answer is yes.'
                          : `First line is the question. Put each ${draft.options[0] === 'Score' ? 'score level (2 to 10)' : 'choice (2 to 255)'} on its own line; numbers are optional.`}
                      </p>
                    </>
                  )}
                  {section === 'video' && (
                    <VideoMediaInputs
                      part="source"
                      draft={draft}
                      update={update}
                      projects={projects}
                      project={activeProject}
                    />
                  )}
                  {['images', '3d', 'video', 'segmentation'].includes(section) && showRefs && (
                    <>
                      <div className="field-label reference-heading">
                        {['3d', 'segmentation'].includes(section)
                          ? 'Reference image'
                          : 'Reference images'}{' '}
                        <span>
                          {section === '3d'
                            ? 'REQUIRED FOR 3D'
                            : section === 'segmentation'
                              ? 'REQUIRED FOR SEGMENTATION'
                              : section === 'video'
                                ? 'REQUIRED, OR ADD A CLIP BELOW'
                                : 'OPTIONAL'}
                        </span>
                      </div>
                      <label className="upload-box">
                        <input
                          id="reference-file"
                          type="file"
                          aria-invalid={problemFor('reference') ? 'true' : undefined}
                          aria-describedby={describedBy('reference')}
                          accept={
                            section === '3d' &&
                            (draft.model || current.model) === 'TRELLIS.2' &&
                            !draft.removeBackground
                              ? 'image/png,image/webp'
                              : 'image/png,image/jpeg,image/webp'
                          }
                          multiple={section !== 'segmentation' && section !== '3d'}
                          onChange={addRefs}
                        />
                        <div className="upload-icon">
                          <Plus size={19} />
                        </div>
                        <div>
                          <strong>
                            {['3d', 'segmentation'].includes(section)
                              ? 'Choose a reference image'
                              : 'Add reference images'}
                          </strong>
                          <small>Choose images from your computer</small>
                        </div>
                        <span className="upload-action">BROWSE FILES</span>
                      </label>
                      <button
                        type="button"
                        className="outline-button asset-library-button"
                        onClick={() => updateSearch(setRouteParams, { picker: 'images' })}
                        disabled={
                          (section === 'images' && imageFiles.length >= 10) ||
                          (section === 'video' && videoFiles.length >= 9)
                        }
                      >
                        <FolderOpen size={15} /> Choose from asset library
                      </button>
                      <FieldError id="reference-error" message={problemFor('reference')?.message} />
                      {draft.refs.length > 0 && (
                        <div className="ref-list">
                          {draft.refs.map((ref, i) => (
                            <span key={i}>
                              <FileImage size={13} />
                              {ref.name}
                              <button
                                type="button"
                                aria-label={'Remove ' + ref.name}
                                onClick={() => {
                                  // Match by name and size rather than by the rendered index: two quick
                                  // clicks can arrive before React re-renders, and a stale index would
                                  // remove the wrong file and desync the list from the staged files.
                                  const dropFirst = (list) => {
                                    const at = list.findIndex(
                                      (item) => item.name === ref.name && item.size === ref.size,
                                    );
                                    return at < 0 ? list : list.filter((_, n) => n !== at);
                                  };
                                  if (section === 'video') {
                                    setVideoFiles(dropFirst);
                                  }
                                  if (section === 'images') {
                                    setImageFiles(dropFirst);
                                  }
                                  if (section === '3d') {
                                    setShapeFiles([]);
                                  }
                                  if (section === 'segmentation') {
                                    setSegmentationFiles([]);
                                  }
                                  setDrafts((all) => ({
                                    ...all,
                                    [section]: {
                                      ...initialDrafts[section],
                                      ...all[section],
                                      refs: dropFirst(all[section]?.refs || []),
                                    },
                                  }));
                                }}
                              >
                                <X size={13} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {section === 'video' && (
                        <p className="helper ref-count" role="status">
                          {draft.refs.length !== videoFiles.length
                            ? `${draft.refs.length} reference image${draft.refs.length === 1 ? '' : 's'} listed from a saved draft or reused settings, but the files are not attached. Choose them again before queuing.`
                            : `${draft.refs.length} of 9 reference images selected${
                                draft.refs.length > 1
                                  ? '. In the description, call them <Picture 1>, <Picture 2> and so on, in this order.'
                                  : '. In the description, call it <Picture 1>.'
                              }`}
                        </p>
                      )}
                      <p className="helper">{`Choose ${section === 'video' ? '1–9 PNG, JPEG, or WebP images, up to 10 MiB each and 40 MiB total' : section === 'images' ? 'up to 10 PNG, JPEG, or WebP images, up to 10 MiB each and 40 MiB total' : `one ${section === '3d' && (draft.model || current.model) === 'TRELLIS.2' && !draft.removeBackground ? 'transparent PNG or WebP' : 'PNG, JPEG, or WebP'} image, up to 10 MiB${section === 'segmentation' ? ' and 20 megapixels' : ''}`}. Files are saved with the project when you queue a render; select them again after refreshing.`}</p>
                    </>
                  )}
                  {section === 'video' && (
                    <VideoMediaInputs
                      part="details"
                      frameErrors={{
                        first: problemFor('firstFrame')?.message,
                        last: problemFor('lastFrame')?.message,
                      }}
                      draft={draft}
                      update={update}
                      projects={projects}
                      project={activeProject}
                    />
                  )}
                  {section === '3d' && supportsRender && draft.threeDMode !== 'text' && (
                    <ThreeDBackgroundOption
                      draft={draft}
                      onChange={update}
                      file={shapeFiles[0]}
                      trellis={(draft.model || current.model) === 'TRELLIS.2'}
                    />
                  )}
                  {section === '3d' && supportsRender ? (
                    (draft.model || current.model) === 'TRELLIS.2' ? (
                      <TrellisControls draft={draft} onChange={update} />
                    ) : (
                      <HunyuanControls draft={draft} onChange={update} />
                    )
                  ) : section === 'motion' &&
                    draft.model === 'NVIDIA MotionBricks' ? null : section === 'motion' &&
                    supportsRender ? (
                    <HyMotionControls draft={draft} onChange={update} />
                  ) : (
                    <div className="options" data-section={section}>
                      {current.options.map((o, i) =>
                        (section === 'segmentation' && i === 0) ||
                        // Cloned and designed voices come from the clip or description, not a preset.
                        (section === 'voices' &&
                          i === 0 &&
                          ['clone', 'design'].includes(draft.voiceMode)) ? null : (
                          <label key={o[0]} htmlFor={`option-${section}-${i}`}>
                            <span className="field-label">{o[0]}</span>
                            <select
                              id={`option-${section}-${i}`}
                              value={o.includes(draft.options[i]) ? draft.options[i] : o[1]}
                              onChange={(e) =>
                                update({
                                  options: draft.options.map((v, j) =>
                                    j === i ? e.target.value : v,
                                  ),
                                })
                              }
                            >
                              {(section === 'video' && o[0] === 'Duration'
                                ? [...o.slice(1)].sort(
                                    (a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)),
                                  )
                                : o.slice(1)
                              ).map((v) => (
                                <option key={v}>{v}</option>
                              ))}
                            </select>
                          </label>
                        ),
                      )}
                    </div>
                  )}
                  {section === 'video' && (
                    <p className="helper" id="video-format-summary">
                      {videoFormatSummary(draft.options, draft)}
                    </p>
                  )}
                  {section === 'segmentation' && (
                    <label htmlFor="segmentation-confidence">
                      <span className="field-label">Confidence threshold</span>
                      <input
                        id="segmentation-confidence"
                        className="segmentation-confidence"
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        inputMode="decimal"
                        value={draft.confidence ?? SEGMENTATION_CONFIDENCE_DEFAULT}
                        aria-invalid={confidenceProblem(draft.confidence) ? 'true' : undefined}
                        aria-describedby="segmentation-confidence-help"
                        onChange={(e) => update({ confidence: e.target.value })}
                      />
                      <p
                        id="segmentation-confidence-help"
                        className={
                          confidenceProblem(draft.confidence) ? 'helper field-error' : 'helper'
                        }
                        role={confidenceProblem(draft.confidence) ? 'alert' : undefined}
                      >
                        {confidenceProblem(draft.confidence) ||
                          'Use 0 to 1 (default 0.5). Lower values can include more objects, and 0 selects almost everything; higher values are more selective, and 1 usually finds nothing.'}
                      </p>
                    </label>
                  )}
                  {section === 'segmentation' && (
                    <SegmentationMatchControls draft={draft} onChange={update} />
                  )}
                  <AudioSettings
                    section={section}
                    draft={draft}
                    update={update}
                    sourcePicker={
                      section === 'sfx' ? (
                        <SoundSource
                          project={activeProject}
                          projects={projects}
                          draft={draft}
                          update={update}
                        />
                      ) : null
                    }
                  />
                  <ImageVideoSettings
                    section={section}
                    draft={draft}
                    update={update}
                    loras={imageLoras}
                  />
                  {!['voices', 'video', 'segmentation', 'game', 'images', 'music', 'sfx'].includes(
                    section,
                  ) &&
                    section !== 'motion' && (
                      <button
                        className="advanced"
                        aria-expanded={Boolean(advanced)}
                        aria-controls="advanced-settings-body"
                        onClick={() => setAdvanced(!advanced)}
                      >
                        <SlidersHorizontal size={15} /> Advanced settings{' '}
                        <ChevronDown size={14} className={advanced ? 'rotate' : ''} />
                      </button>
                    )}
                  {advanced &&
                    !['voices', 'video', 'segmentation', 'game', 'images', 'music', 'sfx'].includes(
                      section,
                    ) &&
                    section !== 'motion' && (
                      <div className="advanced-body" id="advanced-settings-body">
                        <label className="field-label" htmlFor="seed">
                          Seed <span>OPTIONAL</span>
                        </label>
                        <input
                          id="seed"
                          type="number"
                          min={0}
                          max={2147483647}
                          step={1}
                          placeholder="Random"
                          value={draft.seed}
                          onChange={(e) => update({ seed: e.target.value })}
                        />
                        <p className="helper">
                          Use a whole number from 0 to 2147483647 to help reproduce a result when
                          the model supports it.
                        </p>
                      </div>
                    )}
                  {/* The submit bar comes last in the DOM so keyboard users reach it after the fields (CSS keeps it visually pinned). */}
                  {section !== 'game' && (
                    <div className="form-bottom">
                      <div>
                        <span className="estimate-label">
                          <Clock3 size={14} /> ESTIMATED RENDER TIME
                        </span>
                        {renderEstimate?.available ? (
                          <strong>
                            {renderEstimate.confidence === 'rough' ? 'Roughly' : 'About'}{' '}
                            {formatDuration(renderEstimate.typicalSeconds)}{' '}
                            <span>
                              · {renderEstimate.sampleCount}{' '}
                              {renderEstimate.confidence === 'rough' ? 'nearby' : 'matching'}{' '}
                              {renderEstimate.sampleCount === 1 ? 'render' : 'renders'}
                            </span>
                          </strong>
                        ) : (
                          <strong className="estimate-note">
                            {supportsRender
                              ? estimateError
                                ? 'Estimate unavailable'
                                : renderEstimate
                                  ? 'Not enough history'
                                  : 'Checking…'
                              : 'Not available'}{' '}
                            <span>{supportsRender ? estimateError || '' : 'for preview'}</span>
                          </strong>
                        )}
                      </div>
                      <button
                        className="primary create-action"
                        onClick={
                          supportsRender
                            ? section === 'music'
                              ? renderMusic
                              : section === 'sfx'
                                ? renderSound
                                : section === 'video'
                                  ? renderVideo
                                  : section === 'voices'
                                    ? renderVoice
                                    : section === '3d'
                                      ? renderShape
                                      : section === 'segmentation'
                                        ? renderSegmentation
                                        : section === 'motion'
                                          ? renderMotion
                                          : renderImage
                            : addJob
                        }
                        disabled={supportsRender && submittingMusic}
                      >
                        <Plus size={16} />{' '}
                        {submittingMusic
                          ? 'Queuing…'
                          : supportsRender
                            ? 'Add to render queue'
                            : 'Save draft'}{' '}
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                  {section !== 'game' && supportsRender && (
                    <CreationQueueTiming estimate={renderEstimate} estimateError={estimateError} />
                  )}{' '}
                  {section !== 'game' && renderEstimate?.available && (
                    <p className="helper">
                      {renderEstimate.confidence === 'rough'
                        ? 'Roughly scaled from similar settings; actual times vary.'
                        : renderEstimate.confidence === 'limited'
                          ? 'Based on limited history; actual times vary.'
                          : 'Based on previous renders; actual times vary.'}
                    </p>
                  )}
                  <div className="creation-action-note">
                    <span>
                      {supportsRender
                        ? section === 'segmentation'
                          ? "Results are saved as PNGs in this project's masks folder."
                          : 'Renders are saved to the selected project.'
                        : section === 'game'
                          ? 'Drafts stay in this browser; run a live decision in the panel.'
                          : 'Preview only · Drafts are stored in this browser.'}
                    </span>
                    {supportsRender && (
                      <button className="text-action" onClick={addJob}>
                        Save as a draft instead
                      </button>
                    )}
                    {section === 'game' && (
                      <button className="text-action" onClick={addJob}>
                        Save setup draft
                      </button>
                    )}
                    {resetArmed ? (
                      <span
                        className="reset-confirm"
                        role="group"
                        aria-label="Confirm reset"
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setResetArmed(false);
                            setTimeout(() => document.querySelector('.reset-defaults')?.focus(), 0);
                          }
                        }}
                      >
                        <span>Discard this page&apos;s settings?</span>
                        <button className="text-action danger" onClick={resetToDefaults} autoFocus>
                          Yes, reset
                        </button>
                        <button
                          className="text-action"
                          onClick={() => {
                            setResetArmed(false);
                            setTimeout(() => document.querySelector('.reset-defaults')?.focus(), 0);
                          }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="text-action reset-defaults"
                        disabled={!pageIsDirty}
                        title={
                          pageIsDirty
                            ? 'Restore every setting on this page to its default'
                            : 'Nothing to reset: this page already uses its defaults'
                        }
                        onClick={() => setResetArmed(true)}
                      >
                        <RotateCcw size={14} aria-hidden="true" /> Reset to defaults
                      </button>
                    )}
                  </div>
                  {supportsRender && (
                    <p className="helper creation-model-note">
                      {section === 'music'
                        ? 'Enter a style and lyrics (use [Instrumental] for instrumental music). Forge starts YuE2 and checks GPU memory before loading it.'
                        : section === 'sfx'
                          ? 'Stable Audio 3 Medium needs approved Hugging Face access. If renders fail with an access error, add a token in Models & services, then queue again. Forge checks GPU memory before loading.'
                          : section === 'video'
                            ? 'Forge checks GPU memory before H3 loads and renders.'
                            : section === 'voices'
                              ? 'Forge loads the Qwen3-TTS checkpoint your voice mode needs and checks GPU memory first. Switching between preset, clone and design unloads the previous checkpoint.'
                              : section === '3d'
                                ? (draft.model || current.model) === 'TRELLIS.2'
                                  ? 'TRELLIS.2 is experimental and its memory use is not calibrated. Forge checks GPU and system memory before loading.'
                                  : draft.texture === true
                                    ? 'Forge checks GPU and system memory before loading the shape and texture models. Painting takes several extra minutes.'
                                    : 'Forge checks GPU and system memory before loading the shape model. The GLB has no texture.'
                                : section === 'segmentation'
                                  ? 'SAM 3.1 selects objects matching your description. Forge checks GPU and system memory before loading.'
                                  : section === 'motion'
                                    ? draft.model === 'NVIDIA MotionBricks'
                                      ? 'MotionBricks creates an experimental SOMA transition. Forge checks GPU and system memory before loading.'
                                      : 'HY-Motion creates a skeletal BVH clip; retargeting and automatic rigging are separate. Forge checks GPU and system memory before loading.'
                                    : 'Forge checks GPU memory before the first render loads the model. Reference images are optional.'}
                    </p>
                  )}
                </section>
              </div>
              <div className="right-column">
                {section === 'voices' && (
                  <SpeechTranscriber
                    projects={projects}
                    project={activeProject}
                    renderLatency={(props) => <AsrLatency {...props} />}
                    onUseText={(text) => {
                      if (
                        draft.prompt.trim() &&
                        !window.confirm('Replace the dialogue text with this transcript?')
                      ) {
                        return;
                      }
                      update({ prompt: text });
                      setNotice(
                        draft.prompt.trim()
                          ? 'Transcript replaced the voice text.'
                          : 'Transcript added to voice text.',
                      );
                    }}
                  />
                )}
                {section === 'game' && (
                  <GameDecision
                    draft={draft}
                    project={activeProject}
                    onSaved={() => refreshProjects().catch(() => {})}
                  />
                )}
                <PreviewArea
                  section={section}
                  project={activeProject}
                  onRefresh={refreshProjects}
                  onOpenLibrary={() => switchTo('assets')}
                  onQueued={() => setRenderQueueVersion((v) => v + 1)}
                  refreshKey={renderQueueVersion}
                  onReuse={(meta) => reuseSettings(meta, activeProject?.id)}
                />
                {supportsRender && (
                  <RuntimeQueue refreshKey={renderQueueVersion} projects={projects} />
                )}
                <details
                  className="draft-disclosure"
                  {...routeDetails(draftQueueOpen, setDraftQueueOpen)}
                >
                  <summary>
                    Draft queue <span>{jobs.length}</span>
                  </summary>
                  <Queue jobs={jobs} setJobs={setJobs} onOpenDraft={openDraft} />
                </details>
              </div>
            </div>
          </div>
        ) : section === 'vegetation' ? (
          <PageErrorBoundary name="Vegetation">
            <Vegetation
              project={activeProject}
              projects={projects}
              onRefresh={refreshProjects}
              onNewProject={() => setNewProjectOpen(true)}
              onOpenLibrary={() => switchTo('assets')}
            />
          </PageErrorBoundary>
        ) : section === 'world' ? (
          <PageErrorBoundary name="World studio">
            <WorldStudio
              project={activeProject}
              projects={projects}
              onRefresh={refreshProjects}
              onNewProject={() => setNewProjectOpen(true)}
              onOpenLibrary={() => switchTo('assets')}
            />
          </PageErrorBoundary>
        ) : section === 'chat' ? (
          <PageErrorBoundary name="Chat">
            <React.Suspense
              fallback={
                <div className="page" role="status">
                  Opening chat…
                </div>
              }
            >
              <Chat key={chatProjectKey(activeProject?.id)} project={activeProject} />
            </React.Suspense>
          </PageErrorBoundary>
        ) : section === 'diagnostics' ? (
          <Diagnostics />
        ) : section === 'assets' ? (
          <Gallery
            project={activeProject}
            projects={projects}
            onSelect={setSelectedProjectId}
            onNew={() => setNewProjectOpen(true)}
            sampleAssets={sampleAssets}
            loading={projectsLoading}
            error={projectsError}
            onReuse={reuseSettings}
          />
        ) : section === 'megascans' ? (
          <PageErrorBoundary name="Megascans">
            <Megascans
              project={activeProject}
              projects={projects}
              onSelect={setSelectedProjectId}
              onRefresh={refreshProjects}
              onOpenLibrary={() => switchTo('assets')}
            />
          </PageErrorBoundary>
        ) : section === 'queue' ? (
          <div className="page queue-page">
            <div className="editor-title">
              <div>
                <div className="overline">
                  <span className="overline-line" /> ALL PROJECTS
                </div>
                <h1>
                  Render queue<em>.</em>
                </h1>
                <p className="lead">
                  What is processing right now, what is waiting, and what finished. Renders run one
                  at a time.
                </p>
              </div>
            </div>
            <RuntimeQueue expanded projects={projects} refreshKey={renderQueueVersion} />
          </div>
        ) : section === 'models' ? (
          <Models
            onNavigate={(panel, modelName) => {
              if (panel === '3d' || panel === 'motion') {
                setDrafts((d) => ({ ...d, [panel]: { ...d[panel], model: modelName } }));
              }
              switchTo(panel, {
                model:
                  panel === 'world'
                    ? modelName === 'HY-World 2.0'
                      ? 'hy-world'
                      : 'worldgen'
                    : ['3d', 'motion'].includes(panel)
                      ? modelName
                      : null,
              });
            }}
          />
        ) : (
          <div className="page not-found-page">
            <h1>Page not found</h1>
            <p>This studio page does not exist. Pick a workspace to continue:</p>
            <div className="not-found-links">
              {nav.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className="outline-button"
                  onClick={() => switchTo(id)}
                >
                  <Icon size={15} aria-hidden="true" /> {label}
                </button>
              ))}
            </div>
            <button className="primary" onClick={() => switchTo('overview')}>
              Go to overview
            </button>
          </div>
        )}
      </main>
      {routeParams.get('picker') === 'images' &&
        !projectsLoading &&
        ['images', 'video', '3d', 'segmentation'].includes(section) && (
          <AssetPicker
            title="Choose reference images"
            projects={projects}
            project={activeProject}
            extensions={
              section === '3d' && draft.model === 'TRELLIS.2' && !draft.removeBackground
                ? TRELLIS_EXTENSIONS
                : IMAGE_EXTENSIONS
            }
            maxFiles={
              section === 'images'
                ? 10 - imageFiles.length
                : section === 'video'
                  ? 9 - videoFiles.length
                  : 1
            }
            totalBytes={
              section === 'images'
                ? 40 * 1024 * 1024 - imageFiles.reduce((sum, file) => sum + file.size, 0)
                : section === 'video'
                  ? 40 * 1024 * 1024 - videoFiles.reduce((sum, file) => sum + file.size, 0)
                  : 10 * 1024 * 1024
            }
            onSelect={(files) => {
              addReferenceFiles(files);
              updateSearch(setRouteParams, { picker: null });
            }}
            onClose={() => updateSearch(setRouteParams, { picker: null })}
          />
        )}{' '}
      {routeParams.get('picker') === 'pose' &&
        section === 'motion' &&
        draft.model === 'NVIDIA MotionBricks' && (
          <AssetPicker
            title="Choose a SOMA motion clip"
            description="Choose a BVH file with a Y-up SOMA skeleton. Other skeletons are not retargeted."
            projects={projects}
            project={activeProject}
            extensions={POSE_EXTENSIONS}
            onSelect={(files) => {
              setMotionPoseFile(files[0]);
              updateSearch(setRouteParams, { picker: null });
            }}
            onClose={() => updateSearch(setRouteParams, { picker: null })}
          />
        )}
      <FieldHelp section={section} tooltips={fieldTooltips} />
      <MemoryAlerts />
      <MiniPlayer />
      {newProjectOpen && (
        <NewProjectDialog onClose={() => setNewProjectOpen(false)} onCreate={createProject} />
      )}{' '}
      {settingsOpen && <StudioSettings onClose={() => setSettingsOpen(false)} />}{' '}
      {errorsOpen && (
        <ErrorsDialog
          onClose={() => setErrorsOpen(false)}
          onOpenSettings={() => updateSearch(setRouteParams, { dialog: 'settings', error: null })}
          onOpenJob={() => switchTo('queue')}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
    </div>
  );
}
function StudioSettings({ onClose }) {
  const [permission, setPermission] = useState(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );
  const [settings, setSettings] = useState(() =>
    sanitizeSwitches(load(notificationSettingsKey, {}), defaultNotifications),
  );
  const [power, setPower] = useState({ awake: false, loading: true, error: null });
  useEffect(() => {
    try {
      localStorage.setItem(notificationSettingsKey, JSON.stringify(settings));
    } catch (error) {
      log.debug('ui.storage.write.failed', { settingKey: notificationSettingsKey, error });
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [settings]);
  useEffect(() => {
    let active = true;
    let isFailing = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/power');
        if (!response.ok) {
          throw Error('Power service unavailable.');
        }
        const value = await response.json();
        if (active) {
          if (isFailing) {
            isFailing = false;
            log.info('ui.power.refresh.recovered');
          }
          setPower({ awake: value.awake, loading: false, error: value.error });
        }
      } catch (error) {
        if (active) {
          // Logged once when the poll starts failing, not on every 10 second retry.
          if (!isFailing) {
            isFailing = true;
            log.warn('ui.power.refresh.failed', { error });
          }
          setPower((p) => ({
            ...p,
            loading: false,
            error: 'Power service unavailable. Restart the studio.',
          }));
        }
      }
    };
    refresh();
    const id = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);
  const dialog = useDialogFocus({ onClose, initialFocus: '.settings-head button' });
  async function changePower() {
    setPower((p) => ({ ...p, loading: true, error: null }));
    try {
      const response = await fetch('/api/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'power' },
        body: JSON.stringify({ enabled: !power.awake }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw Error(data.error || 'Could not change power setting.');
      }
      setPower({ awake: data.awake, loading: false, error: data.error });
      log.info('ui.power.changed', { enabled: Boolean(data.awake) });
    } catch (error) {
      log.warn('ui.power.change.failed', { error });
      setPower((p) => ({ ...p, loading: false, error: error.message }));
    }
  }
  async function enableNotifications() {
    try {
      const result = await Notification.requestPermission();
      log.info('ui.notifications.permission.decided', { state: result });
      setPermission(result);
    } catch (error) {
      log.warn('ui.notifications.permission.failed', { error });
      setPermission('unsupported');
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Studio settings"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">STUDIO SETTINGS</span>
            <h2>Studio settings</h2>
            <p>Manage notifications, power, and API keys.</p>
          </div>
          <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="settings-section">
          <div className="settings-title">
            <div className="settings-symbol">
              <Zap size={18} />
            </div>
            <div>
              <strong>Keep computer awake</strong>
              <p>
                Prevent automatic sleep while the studio server is running. Your display can still
                turn off.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={power.awake}
              disabled={power.loading}
              aria-label="Keep computer awake"
              className={'switch ' + (power.awake ? 'on' : '')}
              onClick={changePower}
            >
              <span />
            </button>
          </div>
          <div className="settings-status">
            {power.loading
              ? 'Checking…'
              : power.awake
                ? 'On · Windows sleep prevention is active'
                : 'Off · Windows controls automatic sleep'}
          </div>
          {power.error && (
            <p className="settings-error" role="alert">
              {power.error}
            </p>
          )}
          <p className="settings-hint">
            Turns off when the studio server stops. It does not prevent a manual sleep or shutdown.
          </p>
        </div>
        <div className="settings-section">
          <div className="settings-title">
            <div className="settings-symbol">
              <Radio size={18} />
            </div>
            <div>
              <strong>Browser notifications</strong>
              <p>Get browser alerts when your creations are ready.</p>
            </div>
          </div>
          <div className="settings-status">
            {permission === 'granted'
              ? 'Allowed'
              : permission === 'denied'
                ? 'Blocked in browser settings'
                : permission === 'unsupported'
                  ? 'Not supported in this browser'
                  : 'Permission not requested'}
          </div>
          {permission === 'default' && (
            <button className="outline-button settings-enable" onClick={enableNotifications}>
              Enable desktop notifications
            </button>
          )}
          {permission === 'granted' && (
            <button
              className="outline-button settings-enable"
              onClick={() => new Notification('Forge Studio', { body: 'Notifications are ready.' })}
            >
              Send test notification
            </button>
          )}
          <label className="setting-check">
            <input
              type="checkbox"
              checked={settings.render}
              data-log-action="settings.notify.render"
              onChange={(e) => setSettings({ ...settings, render: e.target.checked })}
            />
            <span>When a render completes</span>
          </label>
          <label className="setting-check">
            <input
              type="checkbox"
              checked={settings.queue}
              data-log-action="settings.notify.queue"
              onChange={(e) => setSettings({ ...settings, queue: e.target.checked })}
            />
            <span>When the render queue completes</span>
          </label>
          <p className="settings-hint">
            Keep this page open for browser alerts. On Windows, the Forge tray icon has separate
            notification controls that work while the page is closed. Forge avoids duplicate browser
            alerts while tray alerts are active. Browser drafts do not trigger alerts.
          </p>
        </div>
        <CredentialSettings />
        <AiAssistSettings />
        <StudioBehaviourSettings />
      </section>
    </div>
  );
}
function Queue({ jobs, setJobs, compact, onOpenDraft }) {
  return (
    <section className={'panel queue ' + (compact ? 'compact' : '')}>
      <div className="panel-heading">
        <div>
          <span className="mini-label">Saved in this browser</span>
          <h2>
            Draft queue <span className="queue-count">{jobs.length}</span>
          </h2>
        </div>
      </div>
      {jobs.length === 0 ? (
        <div className="queue-empty">
          <div className="queue-empty-icon">
            <ListMusic size={19} />
          </div>
          <strong>No drafts yet.</strong>
          <p>Save an idea to return to it later.</p>
        </div>
      ) : (
        <div className="queue-list">
          {jobs.map((job, i) => {
            const Icon = configs[job.kind]?.icon || Sparkles;
            return (
              <div className="queue-item" key={job.id}>
                <span className="queue-number">{String(i + 1).padStart(2, '0')}</span>
                <div className="queue-item-icon">
                  <Icon size={15} />
                </div>
                <div className="queue-item-info">
                  <strong>{job.prompt}</strong>
                  <small>
                    {configs[job.kind]?.title} · {job.model} · {job.projectName || 'Unassigned'} ·
                    Draft
                  </small>
                </div>
                <button className="draft-open" onClick={() => onOpenDraft(job)}>
                  Open
                </button>
                <button
                  className="icon-btn"
                  title="Remove draft"
                  data-log-action="drafts.remove"
                  aria-label="Remove draft"
                  onClick={() => setJobs(jobs.filter((j) => j.id !== job.id))}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="queue-footer">
        <Clock3 size={14} />
        <span>Drafts do not render until you add them to the render queue.</span>
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route
        element={
          <QueueTimingProvider>
            <PageErrorBoundary name="the studio">
              <I18nProvider catalogs={shippedCatalogs}>
                <App />
              </I18nProvider>
            </PageErrorBoundary>
          </QueueTimingProvider>
        }
      >
        <Route index element={null} />
        <Route path=":section" element={null} />
        <Route path="*" element={null} />
      </Route>
    </Routes>
  </BrowserRouter>,
);
