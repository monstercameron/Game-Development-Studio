import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'models/**',
      'projects/**',
      '.forge-runtime/**',
      '.venv-dev/**',
      'engines/**',
      'test/.asset-picker-ui-*/**',
      'test/.audio-ui-*/**',
      'test/.credential-ui-*/**',
      'test/.diagnostics-ui-*/**',
      'test/.error-boundary-*/**',
      'test/.field-help-*/**',
      'test/.gallery-ui-*/**',
      'test/.hunyuan-controls-*/**',
      'test/.image-video-ui-*/**',
      'test/.inspection-ui-*/**',
      'test/.model-preview-ui-*/**',
      'test/.model-remove-ui-*/**',
      'test/.recent-projects-*/**',
      'test/.speech-ui-*/**',
      'test/.trash-ui-*/**',
      'test/.vite-jsx-*/**',
      'test/.world-studio-ui-*/**',
    ],
  },
  {
    files: ['**/*.{js,jsx,cjs,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
    },
  },
  {
    files: [
      '*.{js,cjs,mjs}',
      'runtime/**/*.{js,cjs,mjs}',
      'desktop/**/*.{js,cjs,mjs}',
      'test/**/*.{js,jsx,cjs,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['site/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['test/**/*.{js,jsx,cjs,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: ['public/pcm16-worklet.js'],
    languageOptions: {
      globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly' },
    },
  },
];
