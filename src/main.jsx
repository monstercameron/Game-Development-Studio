import CredentialSettings from './CredentialSettings';
import AssetPicker from './AssetPicker';
import { IMAGE_EXTENSIONS, TRELLIS_EXTENSIONS, POSE_EXTENSIONS } from './asset-picker.js';
import FieldHelp from './tooltips/FieldHelp';
import fieldTooltips from './tooltips';
import { chatProjectKey } from './chat-project';
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
import PreviewArea from './PreviewArea';
import Models from './Models';
import RuntimeQueue, {
  enqueueMusic,
  enqueueSound,
  enqueueImage,
  enqueueVideo,
  enqueueVoice,
  enqueueHunyuan,
  enqueueTrellis,
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
import HyMotionControls from './HyMotionControls';
import MotionBricksControls from './MotionBricksControls';
import SpeechTranscriber from './SpeechTranscriber';
import AudioSettings from './AudioSettings';
import ImageVideoSettings from './ImageVideoSettings';
import MemoryAlerts from './MemoryAlerts';
import PageErrorBoundary from './PageErrorBoundary';
import ModelPlaque from './ModelPlaque';
import WorldStudio from './WorldStudio';
import {
  QueueTimingProvider,
  QueueTimingBadge,
  CreationQueueTiming,
  useQueueTiming,
} from './QueueTiming';
import { estimateFromNearbyHistory, formatDuration } from './queue-timing.js';
import { pageQueueStatus } from './nav-queue-status';
import './clientLogging';
import {
  ArrowRight,
  AudioLines,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Clock3,
  Cloud,
  FileImage,
  FolderOpen,
  Gamepad2,
  Image as ImageIcon,
  Layers3,
  LayoutGrid,
  ListMusic,
  MessageSquareText,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Mic2,
  Music2,
  Pause,
  Plus,
  Radio,
  Scissors,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
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

// Chat's Markdown renderer is only needed when the user opens that workspace.
const Chat = React.lazy(() => import('./Chat'));

const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'images', label: 'Images', icon: ImageIcon },
  { id: '3d', label: '3D models', icon: Box },
  { id: 'world', label: 'Worlds', icon: Cloud },
  { id: 'motion', label: 'Character rigging', icon: Gamepad2 },
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
    title: 'Character rigging & motion',
    eyebrow: 'CHARACTER ANIMATION',
    description: 'Prepare a character and explore motion for your game.',
    icon: Gamepad2,
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
      ['Aspect ratio', 'Landscape · 16:9', 'Square · 1:1', 'Portrait · 9:16'],
      ['Duration', 'About 5 seconds', 'About 2 seconds', 'About 7 seconds', 'About 10 seconds'],
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
      ['Direction', 'Full arrangement', 'Melody', 'Off'],
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
    model: 'Qwen3-TTS 1.7B · Preset voices',
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
      ['Export', 'Transparent PNG', 'Mask PNG'],
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
      ['Response', 'Structured', 'Compact'],
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
  },
  {
    tag: 'ENVIRONMENT',
    title: 'A world worth exploring',
    subtitle: 'Environment concept',
    className: 'art-world',
    image: '/samples/forest-bridge.png',
  },
  {
    tag: 'OBJECT',
    title: 'Small details, big stories',
    subtitle: 'Game asset concept',
    className: 'art-object',
    image: '/samples/potion.png',
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
  } catch {
    return fallback;
  }
}
function App() {
  useRuntimeNotifications();
  const { jobs: runtimeJobs, loading: queueLoading, error: queueError } = useQueueTiming();
  const queueStatus = (id) =>
    pageQueueStatus(id, runtimeJobs, { loading: queueLoading, error: queueError });
  const completedHistory = runtimeJobs
    .filter((job) => job.status === 'completed')
    .map((job) => `${job.id}:${job.finishedAt}`)
    .join('|');
  const [section, navigate, routeParams, setRouteParams] = useNav();
  const [drafts, setDrafts] = useState(() => {
    const saved = load('forge-drafts', initialDrafts);
    return Object.fromEntries(
      Object.entries(initialDrafts).map(([key, initial]) => [
        key,
        { ...initial, ...saved?.[key], refs: [] },
      ]),
    );
  });
  const [renderQueueVersion, setRenderQueueVersion] = useState(0);
  const [submittingMusic, setSubmittingMusic] = useState(false);
  const [renderEstimate, setRenderEstimate] = useState(null),
    [estimateError, setEstimateError] = useState('');
  const [videoFiles, setVideoFiles] = useState([]);
  const [imageFiles, setImageFiles] = useState([]);
  const [shapeFiles, setShapeFiles] = useState([]);
  const [segmentationFiles, setSegmentationFiles] = useState([]);
  const [motionPoseFile, setMotionPoseFile] = useState(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [desktopNavHidden, setDesktopNavHidden] = useState(
    () => load('forge-nav-hidden', false) === true,
  );
  useEffect(() => {
    try {
      localStorage.setItem('forge-nav-hidden', JSON.stringify(desktopNavHidden));
    } catch {
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [desktopNavHidden]);
  const [mobileNavigation, setMobileNavigation] = useState(
    () => window.matchMedia('(max-width: 850px)').matches,
  );
  const menuButtonRef = useRef(null);
  const navigationRef = useRef(null);
  const projectSelectRef = useRef(null);
  const [jobs, setJobs] = useState(() => load('forge-queue', []));
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState('');
  const [advanced, setAdvanced] = useRouteToggle('advanced');
  const settingsOpen = routeParams.get('dialog') === 'settings';
  const setSettingsOpen = (value) =>
    updateSearch(setRouteParams, { dialog: value ? 'settings' : null });
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
  const initialSavedProject = useRef(load('forge-selected-project', null));
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
    } catch {
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [selectedProjectId]);
  const latestProjectsRequest = useRef(0);
  useEffect(() => {
    try {
      localStorage.setItem('forge-drafts', JSON.stringify(drafts));
    } catch {
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [drafts]);
  useEffect(() => {
    try {
      localStorage.setItem('forge-queue', JSON.stringify(jobs));
    } catch {
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
      }
      return data.projects;
    } catch (error) {
      if (request === latestProjectsRequest.current) {
        setProjectsError('Could not load projects. Restart the studio.');
        setProjectsLoading(false);
      }
      throw error;
    }
  }
  useEffect(() => {
    const latestProjectsRequestRef = latestProjectsRequest;
    refreshProjects().catch(() => {});
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
    setRenderEstimate(null);
    setEstimateError('');
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
            if (!nearby) {
              setEstimateError('Select a project to check for matching renders.');
            }
          }
          return;
        }
        estimateRender(type, estimateProjectId, draft)
          .then((result) => {
            if (active) {
              setRenderEstimate(result.available ? result : nearby || result);
            }
          })
          .catch(() => {
            if (active) {
              setRenderEstimate(nearby);
              if (!nearby) {
                setEstimateError('Could not check render timing.');
              }
            }
          });
      } catch (reason) {
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
  const addJob = () => {
    const motionBricks = section === 'motion' && draft.model === 'NVIDIA MotionBricks';
    if (section === '3d' && !draft.refs.length) {
      setNotice('Add a reference image for your 3D draft.');
      return;
    }
    if (section !== '3d' && !motionBricks && !draft.prompt.trim()) {
      setNotice('Add a description to create a draft.');
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
    setNotice('Added to your project draft queue.');
  };
  const addReferenceFiles = (files) => {
    const refs = files.map((f) => ({ name: f.name, size: f.size }));
    if (files.length) {
      if (section === 'video' || section === 'images') {
        const isVideo = section === 'video',
          combined = [...(isVideo ? videoFiles : imageFiles), ...files].slice(0, isVideo ? 9 : 10);
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
      setNotice('Reference images selected.');
    }
  };
  const addRefs = (event) => {
    addReferenceFiles(Array.from(event.target.files || []));
    event.target.value = '';
  };
  const renderMusic = async () => {
    if (!selectProject()) {
      return;
    }
    if (!draft.prompt.trim() || !draft.second.trim()) {
      setNotice('Add a music style and lyrics to queue a render.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueMusic(activeProject.id, draft);
      setRenderQueueVersion((v) => v + 1);
      setNotice('Music render added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue music: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderSound = async () => {
    if (!selectProject()) {
      return;
    }
    if (!draft.prompt.trim()) {
      setNotice('Add a sound description to queue a render.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueSound(activeProject.id, draft);
      setRenderQueueVersion((v) => v + 1);
      setNotice('Sound effect added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue sound: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderShape = async () => {
    if (!selectProject()) {
      return;
    }
    if (shapeFiles.length !== 1 || draft.refs.length !== 1) {
      setNotice('Choose the reference image again before rendering.');
      return;
    }
    if (shapeFiles[0].size > 10 * 1024 * 1024) {
      setNotice('Use an image, up to 10 MiB.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await ((draft.model || current.model) === 'TRELLIS.2' ? enqueueTrellis : enqueueHunyuan)(
        activeProject.id,
        draft,
        shapeFiles[0],
      );
      setRenderQueueVersion((v) => v + 1);
      setNotice('3D shape added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue 3D shape: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderSegmentation = async () => {
    if (!selectProject()) {
      return;
    }
    if (!draft.prompt.trim()) {
      setNotice('Describe what to isolate.');
      return;
    }
    if (segmentationFiles.length !== 1 || draft.refs.length !== 1) {
      setNotice('Choose the reference image again before segmenting.');
      return;
    }
    if (segmentationFiles[0].size > 10 * 1024 * 1024) {
      setNotice('Use an image, up to 10 MiB.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueSegmentation(activeProject.id, draft, segmentationFiles[0]);
      setRenderQueueVersion((v) => v + 1);
      setNotice('Segmentation added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue segmentation: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderMotion = async () => {
    if (!selectProject()) {
      return;
    }
    const bricks = draft.model === 'NVIDIA MotionBricks';
    if (bricks && !motionPoseFile) {
      setNotice('Choose a SOMA BVH file before rendering.');
      return;
    }
    if (bricks && motionPoseFile.size > 10 * 1024 * 1024) {
      setNotice('Use a BVH under 10 MiB.');
      return;
    }
    if (!bricks && !draft.prompt.trim()) {
      setNotice('Describe the human motion.');
      return;
    }
    setSubmittingMusic(true);
    try {
      if (bricks) {
        await enqueueMotionBricks(activeProject.id, draft, motionPoseFile);
      } else {
        await enqueueMotion(activeProject.id, draft);
      }
      setRenderQueueVersion((v) => v + 1);
      setNotice('Motion clip added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue motion: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderVoice = async () => {
    if (!selectProject()) {
      return;
    }
    if (!draft.prompt.trim()) {
      setNotice('Add dialogue to queue a voice render.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueVoice(activeProject.id, draft);
      setRenderQueueVersion((v) => v + 1);
      setNotice('Voice added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue voice: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderImage = async () => {
    if (!selectProject()) {
      return;
    }
    if (!draft.prompt.trim()) {
      setNotice('Add an image description to queue a render.');
      return;
    }
    if (draft.refs.length !== imageFiles.length) {
      setNotice('Choose the image references again before rendering.');
      return;
    }
    if (
      imageFiles.some((f) => f.size > 10 * 1024 * 1024) ||
      imageFiles.reduce((n, f) => n + f.size, 0) > 40 * 1024 * 1024
    ) {
      setNotice('Use reference images under 10 MiB each and 40 MiB in total.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueImage(activeProject.id, draft, imageFiles);
      setRenderQueueVersion((v) => v + 1);
      setNotice('Image added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue image: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const renderVideo = async () => {
    if (!selectProject()) {
      return;
    }
    if (!draft.prompt.trim()) {
      setNotice('Add a video description to queue a render.');
      return;
    }
    if (!videoFiles.length || videoFiles.length !== draft.refs.length) {
      setNotice('Choose the video reference images again before queuing.');
      return;
    }
    if (
      videoFiles.some((f) => f.size > 10 * 1024 * 1024) ||
      videoFiles.reduce((n, f) => n + f.size, 0) > 40 * 1024 * 1024
    ) {
      setNotice('Use reference images under 10 MiB each and 40 MiB in total.');
      return;
    }
    setSubmittingMusic(true);
    try {
      await enqueueVideo(activeProject.id, draft, videoFiles);
      setRenderQueueVersion((v) => v + 1);
      setNotice('Video added to the durable queue.');
    } catch (error) {
      setNotice(`Could not queue video: ${error.message}`);
    } finally {
      setSubmittingMusic(false);
    }
  };
  const openDraft = (job) => {
    if (!configs[job.kind]) {
      setNotice('This draft type is unavailable.');
      return;
    }
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
        className={'sidebar ' + (navigationOpen ? 'sidebar-open' : '')}
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
          <div className="workspace-icon">
            <Box size={18} />
          </div>
          <div>
            <strong>Current project</strong>
            <select
              aria-label="Current project"
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
          <ChevronDown size={14} />
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
                    {status.short}
                  </span>
                )}
                {id === 'overview' && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="nav-heading lower">YOUR STUDIO</div>
        <button
          aria-label="Asset library"
          title="Asset library"
          className={'nav-item ' + (section === 'assets' ? 'active' : '')}
          onClick={() => switchTo('assets')}
        >
          <FolderOpen size={17} />
          <span>Asset library</span>
        </button>
        <button
          aria-label="Models and services"
          title="Models and services"
          className={'nav-item ' + (section === 'models' ? 'active' : '')}
          onClick={() => switchTo('models')}
        >
          <Layers3 size={17} />
          <span>Models & services</span>
        </button>
        <button
          aria-label="Diagnostics"
          title="Diagnostics"
          className={'nav-item ' + (section === 'diagnostics' ? 'active' : '')}
          onClick={() => switchTo('diagnostics')}
        >
          <Terminal size={17} />
          <span>Diagnostics</span>
        </button>
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
                    (section === 'chat'
                      ? 'Chat'
                      : section === 'world'
                        ? 'Worlds'
                        : section === 'assets'
                          ? 'Asset library'
                          : section === 'diagnostics'
                            ? 'Diagnostics'
                            : section === 'models'
                              ? 'Models & services'
                              : 'Page not found')}
              </strong>
            </div>
            {queueStatus(section) && (
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
            <QueueTimingBadge />
            <span className="prototype">
              <i /> EARLY ACCESS
            </span>
            <button
              className="icon-btn"
              title="Studio settings"
              aria-label="Studio settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <button
              className="icon-btn"
              title="About this preview"
              aria-label="About this preview"
              onClick={() =>
                setNotice(
                  'Images, video, music, sound effects, voices, Hunyuan shapes, HY-Motion, SAM segmentation, and game decisions have initial integrations; other panels remain previews.',
                )
              }
            >
              <CircleHelp size={18} />
            </button>
            <div className="top-avatar">Y</div>
          </div>
        </header>
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
              <div className="date-block">
                <Sparkles size={16} />
                <span>Made for your game worlds</span>
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
              <span className="section-note">
                From ideas to assets <ArrowRight size={14} />
              </span>
            </div>
            <div className="tool-grid">
              {[
                ['images', ImageIcon, 'Images', 'Characters, environments & assets', 'mint'],
                ['video', Clapperboard, 'Video', 'Bring your scenes to life', 'violet'],
                ['music', Music2, 'Music', 'Soundtracks for every story', 'peach'],
                ['sfx', AudioLines, 'Sound effects', 'The details you can hear', 'blue'],
                ['3d', Box, '3D models', 'Objects & character concepts', 'yellow'],
                ['world', Cloud, 'Worlds', 'Generate explorable scenes', 'violet'],
                ['motion', Gamepad2, 'Character motion', 'Explore movement & rigging', 'mint'],
                ['voices', Mic2, 'Voices', 'Give your characters a voice', 'rose'],
                ['segmentation', Scissors, 'Segmentation', 'Isolate, refine & create', 'yellow'],
                ['game', Gamepad2, 'Game logic', 'Decisions for your game world', 'blue'],
              ].map(([id, Icon, title, desc, color]) => (
                <button className="tool-card" key={id} onClick={() => switchTo(id)}>
                  <div className={'tool-icon ' + color}>
                    <Icon size={20} />
                  </div>
                  <span
                    className={
                      [
                        'images',
                        'video',
                        'music',
                        'sfx',
                        'voices',
                        '3d',
                        'world',
                        'segmentation',
                        'motion',
                        'game',
                      ].includes(id)
                        ? 'tool-availability'
                        : 'tool-availability planned'
                    }
                  >
                    {[
                      'images',
                      'video',
                      'music',
                      'sfx',
                      'voices',
                      '3d',
                      'world',
                      'segmentation',
                      'motion',
                    ].includes(id)
                      ? 'RENDER'
                      : id === 'game'
                        ? 'DECISIONS'
                        : 'PREVIEW'}
                  </span>
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
                        setDrafts((d) => ({
                          ...d,
                          images: {
                            ...d.images,
                            prompt: t.title + ', detailed fantasy game concept art',
                          },
                        }));
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
              <Queue
                jobs={jobs}
                setJobs={setJobs}
                paused={paused}
                setPaused={setPaused}
                compact
                setNotice={setNotice}
                onOpenDraft={openDraft}
              />
            </div>
            <footer className="footer">
              <span>
                MADE FOR YOUR GAME WORLDS <span>✳</span>
              </span>
              <span>FORGE STUDIO · LOCAL WORKSPACE</span>
            </footer>
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
              />
            </div>
            <div className="creation-context">
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
                      <h2>Creative direction</h2>
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
                        <option>TRELLIS.2</option>
                        <option>Hunyuan3D 2.1</option>
                      </select>
                      <p className="helper">
                        Hunyuan creates an untextured shape. TRELLIS.2 creates an experimental
                        textured model and requires a transparent PNG or WebP.
                      </p>
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
                        onChange={(e) => update({ model: e.target.value })}
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
                  {!(section === 'motion' && draft.model === 'NVIDIA MotionBricks') && (
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
                        value={draft.prompt}
                        onChange={(e) => update({ prompt: e.target.value })}
                        placeholder={
                          section === 'motion' && draft.model === 'NVIDIA MotionBricks'
                            ? 'Optional notes about the target pose or scene...'
                            : current.placeholder
                        }
                      />
                      <div className="prompt-foot">
                        <span>
                          <Sparkles size={13} />{' '}
                          {section === 'motion' && draft.model === 'NVIDIA MotionBricks'
                            ? 'Provide recent and target pose data to guide a transition.'
                            : current.tip}
                        </span>
                        <span>{draft.prompt.length} characters</span>
                      </div>
                    </>
                  )}
                  {section === 'motion' && draft.model === 'NVIDIA MotionBricks' && (
                    <MotionBricksControls
                      draft={draft}
                      onChange={update}
                      file={motionPoseFile}
                      onFile={setMotionPoseFile}
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
                        placeholder="[Verse] Write your lyrics here..."
                      />
                    </>
                  )}
                  {section === 'voices' && (
                    <>
                      <label className="field-label" htmlFor="extra">
                        Voice direction <span>OPTIONAL</span>
                      </label>
                      <textarea
                        id="extra"
                        className="short-text"
                        maxLength={500}
                        value={draft.second}
                        onChange={(e) => update({ second: e.target.value })}
                        placeholder="Speak warmly and clearly, with a sense of wonder..."
                      />
                      <p className="helper">
                        Choose a preset voice and add direction. Speech is generated as a completed
                        audio file; streaming and voice cloning are not yet available.
                      </p>
                    </>
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
                      />
                    </>
                  )}
                  {['images', '3d', 'video', 'segmentation'].includes(section) && (
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
                                ? 'REQUIRED FOR VIDEO'
                                : 'OPTIONAL'}
                        </span>
                      </div>
                      <label className="upload-box">
                        <input
                          type="file"
                          accept={
                            section === '3d' && (draft.model || current.model) === 'TRELLIS.2'
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
                      {draft.refs.length > 0 && (
                        <div className="ref-list">
                          {draft.refs.map((ref, i) => (
                            <span key={i}>
                              <FileImage size={13} />
                              {ref.name}
                              <button
                                aria-label={'Remove ' + ref.name}
                                onClick={() => {
                                  if (section === 'video') {
                                    setVideoFiles((files) => files.filter((_, n) => n !== i));
                                  }
                                  if (section === 'images') {
                                    setImageFiles((files) => files.filter((_, n) => n !== i));
                                  }
                                  if (section === '3d') {
                                    setShapeFiles([]);
                                  }
                                  if (section === 'segmentation') {
                                    setSegmentationFiles([]);
                                  }
                                  update({ refs: draft.refs.filter((_, n) => n !== i) });
                                }}
                              >
                                <X size={13} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="helper">{`Choose ${section === 'video' ? '1–9 PNG, JPEG, or WebP images, up to 10 MiB each and 40 MiB total' : section === 'images' ? 'up to 10 PNG, JPEG, or WebP images, up to 10 MiB each and 40 MiB total' : `one ${section === '3d' && (draft.model || current.model) === 'TRELLIS.2' ? 'transparent PNG or WebP' : 'PNG, JPEG, or WebP'} image, up to 10 MiB`}. Files are saved with the project when you queue a render; select them again after refreshing.`}</p>
                    </>
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
                    <div className="options">
                      {current.options.map((o, i) =>
                        section === 'segmentation' && i === 0 ? null : (
                          <label key={o[0]}>
                            <span className="field-label">{o[0]}</span>
                            <select
                              value={o.includes(draft.options[i]) ? draft.options[i] : o[1]}
                              onChange={(e) =>
                                update({
                                  options: draft.options.map((v, j) =>
                                    j === i ? e.target.value : v,
                                  ),
                                })
                              }
                            >
                              {o.slice(1).map((v) => (
                                <option key={v}>{v}</option>
                              ))}
                            </select>
                          </label>
                        ),
                      )}
                    </div>
                  )}
                  {section === 'segmentation' && (
                    <label>
                      <span className="field-label">Confidence threshold</span>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={draft.confidence ?? 0.5}
                        onChange={(e) => update({ confidence: e.target.value })}
                      />
                      <p className="helper">
                        Lower values can include more objects; higher values are more selective.
                      </p>
                    </label>
                  )}
                  <AudioSettings section={section} draft={draft} update={update} />
                  <ImageVideoSettings section={section} draft={draft} update={update} />
                  {!['voices', 'video', 'segmentation', 'game'].includes(section) &&
                    !(section === 'motion' && draft.model === 'NVIDIA MotionBricks') && (
                      <button className="advanced" onClick={() => setAdvanced(!advanced)}>
                        <SlidersHorizontal size={15} /> Advanced settings{' '}
                        <ChevronDown size={14} className={advanced ? 'rotate' : ''} />
                      </button>
                    )}
                  {advanced &&
                    !['voices', 'video', 'segmentation', 'game'].includes(section) &&
                    !(section === 'motion' && draft.model === 'NVIDIA MotionBricks') && (
                      <div className="advanced-body">
                        <label className="field-label" htmlFor="seed">
                          Seed <span>OPTIONAL</span>
                        </label>
                        <input
                          id="seed"
                          type="number"
                          placeholder="Random"
                          value={draft.seed}
                          onChange={(e) => update({ seed: e.target.value })}
                        />
                        <p className="helper">
                          Use a seed to help reproduce a result when the model supports it.
                        </p>
                      </div>
                    )}
                  <div className="form-bottom">
                    <div>
                      <span className="estimate-label">
                        <Clock3 size={14} />{' '}
                        {section === 'game' ? 'DECISION TIME' : 'ESTIMATED RENDER TIME'}
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
                        <strong>
                          {supportsRender
                            ? estimateError
                              ? 'Estimate unavailable'
                              : renderEstimate
                                ? 'Not enough history'
                                : 'Checking…'
                            : section === 'game'
                              ? 'See test panel'
                              : 'Not available'}{' '}
                          <span>
                            {supportsRender
                              ? estimateError || ''
                              : section === 'game'
                                ? 'for the decision estimate'
                                : 'for preview'}
                          </span>
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
                  {supportsRender && (
                    <CreationQueueTiming estimate={renderEstimate} estimateError={estimateError} />
                  )}{' '}
                  {renderEstimate?.available && (
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
                        ? 'Renders are saved to the selected project.'
                        : section === 'game'
                          ? 'Drafts stay in this browser; run a live decision in the panel.'
                          : 'Preview only · Drafts are stored in this browser.'}
                    </span>
                    {supportsRender && (
                      <button className="text-action" onClick={addJob}>
                        Save as a draft instead
                      </button>
                    )}
                  </div>
                  {supportsRender && (
                    <p className="helper creation-model-note">
                      {section === 'music'
                        ? 'Enter a style and lyrics (use [Instrumental] for instrumental music). Forge starts YuE2 and checks GPU memory before loading it.'
                        : section === 'sfx'
                          ? 'Forge starts Stable Audio and checks GPU memory. Model access may need to be configured in Models & services.'
                          : section === 'video'
                            ? 'Forge checks GPU memory before H3 loads and renders.'
                            : section === 'voices'
                              ? 'Forge loads Qwen3-TTS as needed and checks GPU memory before rendering.'
                              : section === '3d'
                                ? (draft.model || current.model) === 'TRELLIS.2'
                                  ? 'Experimental TRELLIS.2 uses a transparent PNG or WebP. A full render is not yet verified; Forge checks GPU and system memory. Creative notes do not affect the model.'
                                  : 'Hunyuan creates an untextured GLB; Forge checks GPU and system memory before loading. Creative notes are saved in drafts and do not affect the shape.'
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
                    onUseText={(text) => {
                      update({ prompt: text });
                      setNotice('Transcript added to voice text.');
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
                  <Queue
                    jobs={jobs}
                    setJobs={setJobs}
                    paused={paused}
                    setPaused={setPaused}
                    setNotice={setNotice}
                    onOpenDraft={openDraft}
                  />
                </details>
              </div>
            </div>
          </div>
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
          />
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
          <div className="page">
            <h1>Page not found</h1>
            <p>This studio page does not exist.</p>
            <button className="primary" onClick={() => switchTo('overview')}>
              Go to overview
            </button>
          </div>
        )}
      </main>
      {routeParams.get('picker') === 'images' &&
        ['images', 'video', '3d', 'segmentation'].includes(section) && (
          <AssetPicker
            title="Choose reference images"
            projects={projects}
            project={activeProject}
            extensions={
              section === '3d' && draft.model === 'TRELLIS.2'
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
      {newProjectOpen && (
        <NewProjectDialog onClose={() => setNewProjectOpen(false)} onCreate={createProject} />
      )}{' '}
      {settingsOpen && <StudioSettings onClose={() => setSettingsOpen(false)} />}{' '}
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
  const [settings, setSettings] = useState(() => ({
    ...defaultNotifications,
    ...load(notificationSettingsKey, {}),
  }));
  const [power, setPower] = useState({ awake: false, loading: true, error: null });
  useEffect(() => {
    try {
      localStorage.setItem(notificationSettingsKey, JSON.stringify(settings));
    } catch {
      // Browser storage can be unavailable in restricted contexts.
    }
  }, [settings]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/power');
        if (!response.ok) {
          throw Error('Power service unavailable.');
        }
        const value = await response.json();
        if (active) {
          setPower({ awake: value.awake, loading: false, error: value.error });
        }
      } catch {
        if (active) {
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
    } catch (error) {
      setPower((p) => ({ ...p, loading: false, error: error.message }));
    }
  }
  async function enableNotifications() {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
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
              <strong>Desktop notifications</strong>
              <p>Get a notification when your creations are ready.</p>
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
              onChange={(e) => setSettings({ ...settings, render: e.target.checked })}
            />
            <span>When a render completes</span>
          </label>
          <label className="setting-check">
            <input
              type="checkbox"
              checked={settings.queue}
              onChange={(e) => setSettings({ ...settings, queue: e.target.checked })}
            />
            <span>When the render queue completes</span>
          </label>
          <p className="settings-hint">
            Keep the studio open for notifications. Only real render jobs trigger notifications;
            browser drafts do not.
          </p>
        </div>
        <CredentialSettings />
      </section>
    </div>
  );
}
function Queue({ jobs, setJobs, paused, setPaused, compact, setNotice, onOpenDraft }) {
  return (
    <section className={'panel queue ' + (compact ? 'compact' : '')}>
      <div className="panel-heading">
        <div>
          <span className="mini-label">Saved in this browser</span>
          <h2>
            Draft queue <span className="queue-count">{jobs.length}</span>
          </h2>
        </div>
        <button
          className="icon-btn"
          aria-label={paused ? 'Resume draft queue' : 'Pause draft queue'}
          onClick={() => {
            setPaused(!paused);
            setNotice(paused ? 'Draft queue resumed.' : 'Draft queue paused.');
          }}
        >
          {paused ? <ArrowRight size={16} /> : <Pause size={16} />}
        </button>
      </div>
      <div className="queue-status">
        <span className="queue-pulse" />
        <span>{paused ? 'DRAFT QUEUE PAUSED' : 'DRAFT QUEUE'}</span>
        <span className="queue-status-right">PREVIEW</span>
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
            <App />
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
