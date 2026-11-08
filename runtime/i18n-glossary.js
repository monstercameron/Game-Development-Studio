// Terms for machine translation of the studio interface. Product, model and unit names are kept
// exactly as written; the per-language table keeps common studio terms consistent across pages.
// Add a language by adding its subtag with reviewed terms; unknown languages get names only.

export const PROTECTED_TERMS = Object.freeze([
  'Forge',
  'OpenAI',
  'ChatGPT',
  'GitHub',
  'CUDA',
  'GPU',
  'TRELLIS.2',
  'Hunyuan3D',
  'HY-Motion',
  'MotionBricks',
  'Megascans',
  'SAM 3.1',
  'Qwen',
  'SeedThree',
  'Windows',
  'MCP',
]);

export const GLOSSARY = Object.freeze({
  de: {
    'Render queue': 'Render-Warteschlange',
    'Asset library': 'Asset-Bibliothek',
    Project: 'Projekt',
    Settings: 'Einstellungen',
    Diagnostics: 'Diagnose',
  },
  fr: {
    'Render queue': 'File de rendu',
    'Asset library': 'Bibliothèque de ressources',
    Project: 'Projet',
    Settings: 'Paramètres',
    Diagnostics: 'Diagnostics',
  },
  es: {
    'Render queue': 'Cola de renderizado',
    'Asset library': 'Biblioteca de recursos',
    Project: 'Proyecto',
    Settings: 'Configuración',
    Diagnostics: 'Diagnóstico',
  },
  it: {
    'Render queue': 'Coda di rendering',
    'Asset library': 'Libreria risorse',
    Project: 'Progetto',
    Settings: 'Impostazioni',
    Diagnostics: 'Diagnostica',
  },
  pt: {
    'Render queue': 'Fila de renderização',
    'Asset library': 'Biblioteca de recursos',
    Project: 'Projeto',
    Settings: 'Configurações',
    Diagnostics: 'Diagnóstico',
  },
  ja: {
    'Render queue': 'レンダーキュー',
    'Asset library': 'アセットライブラリ',
    Project: 'プロジェクト',
    Settings: '設定',
    Diagnostics: '診断',
  },
  zh: {
    'Render queue': '渲染队列',
    'Asset library': '资源库',
    Project: '项目',
    Settings: '设置',
    Diagnostics: '诊断',
  },
  ko: {
    'Render queue': '렌더 대기열',
    'Asset library': '에셋 라이브러리',
    Project: '프로젝트',
    Settings: '설정',
    Diagnostics: '진단',
  },
});

/** Glossary for a locale: the full tag first, then its language subtag. */
export function glossaryFor(locale) {
  return GLOSSARY[locale] || GLOSSARY[String(locale).split('-')[0]] || {};
}
