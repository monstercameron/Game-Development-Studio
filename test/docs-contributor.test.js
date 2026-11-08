// Keeps the contributor guides and AGENTS.md files honest: every repository path they quote and
// every local link they contain must exist, every `npm run` script must be in package.json, and
// the index must link the guides. No network, no engine and no temporary state are involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GUIDES = ['docs/CODE_STYLE.md', 'docs/ADDING_A_MODEL.md', 'docs/ADDING_A_FEATURE.md'];
const DIRECTORY_AGENTS = [
  'runtime/AGENTS.md',
  'src/AGENTS.md',
  'test/AGENTS.md',
  'docs/AGENTS.md',
  'tools/AGENTS.md',
  'site/AGENTS.md',
];
const ROOT_AGENTS = 'AGENTS.md';
// The root file holds the whole engineering rule set, so it is allowed to be longer.
const ROOT_AGENTS_MAX_LINES = 120;
const DIRECTORY_AGENTS_MAX_LINES = 80;

// Generated, local or untracked locations that a guide may mention but a checkout lacks.
const ALLOWED_MISSING_PREFIXES = [
  '.forge-runtime/',
  'models/',
  'projects/',
  'engines/',
  'external/',
  'dist/',
  'node_modules/',
  '.venv-dev/',
  '.ruff_cache/',
];
const KNOWN_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.json',
  '.md',
  '.css',
  '.html',
  '.ps1',
  '.cmd',
  '.sh',
  '.yml',
  '.yaml',
  '.patch',
  '.toml',
]);
// Naming patterns the root AGENTS.md quotes as examples; they are not repository files.
const NAMING_PATTERNS = new Set(['PascalCase.jsx']);
// Files that a guide may name before another change adds them. Keep this list short.
const ALLOWED_PENDING_FILES = new Set([
  'docs/LOGGING.md',
  'docs/SETTINGS.md',
  'docs/RESILIENCE.md',
]);

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function exists(candidate) {
  return fs.existsSync(candidate);
}

function lineCount(text) {
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

// Splits a Markdown file into prose lines (code fences removed) and fenced code lines.
function splitMarkdown(text) {
  const prose = [];
  const fenced = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    (inFence ? fenced : prose).push(line);
  }
  return { prose, fenced };
}

function isAllowedMissing(token) {
  return ALLOWED_MISSING_PREFIXES.some((prefix) => token.startsWith(prefix));
}

// A backtick token is a repository path when it has no spaces or placeholders and either ends
// with a slash or carries a known file extension.
function pathCandidate(rawToken) {
  const token = rawToken.trim().replaceAll('\\', '/');
  if (
    !token ||
    /[\s<>*{}$|()=:#?"'`,;]/.test(token) ||
    token.startsWith('/') ||
    token.includes('..')
  ) {
    return null;
  }
  if (/^[\w.@-]+\/$|^[\w.@/-]+\/$/.test(token)) {
    return token;
  }
  if (!/^[\w.@/-]+$/.test(token)) {
    return null;
  }
  return KNOWN_EXTENSIONS.has(path.extname(token).toLowerCase()) ? token : null;
}

function resolvesFrom(token, docRelative) {
  const docDirectory = path.dirname(path.join(root, docRelative));
  return [path.join(root, token), path.join(docDirectory, token)].some(exists);
}

function inlineTokens(lines) {
  const tokens = [];
  for (const line of lines) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      tokens.push(match[1]);
    }
  }
  return tokens;
}

// Paths that appear in command lines inside code fences, limited to the top-level source folders.
function fencedPaths(lines) {
  const found = [];
  const pattern =
    /(?:^|[\s"'=(])((?:runtime|src|test|docs|tools|site)\/[\w./-]+\.[a-z0-9]+)(?=$|[\s"')])/gi;
  for (const line of lines) {
    for (const match of line.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

function githubSlug(heading) {
  return heading
    .replaceAll('`', '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replaceAll(/\s/g, '-');
}

function anchorsOf(markdownFile) {
  const { prose } = splitMarkdown(fs.readFileSync(markdownFile, 'utf8'));
  const anchors = new Set();
  for (const line of prose) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (match) {
      anchors.add(githubSlug(match[1]));
    }
  }
  return anchors;
}

function localLinks(lines) {
  const links = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (!/^(https?:|mailto:)/i.test(target)) {
        links.push(target);
      }
    }
  }
  return links;
}

function checkDocument(relative) {
  const { prose, fenced } = splitMarkdown(read(relative));
  const problems = [];
  for (const raw of inlineTokens(prose)) {
    const token = pathCandidate(raw);
    if (
      token &&
      !NAMING_PATTERNS.has(token) &&
      !isAllowedMissing(token) &&
      !resolvesFrom(token, relative)
    ) {
      problems.push(`${relative}: quoted path does not exist: ${raw}`);
    }
  }
  for (const token of fencedPaths(fenced)) {
    if (!isAllowedMissing(token) && !resolvesFrom(token, relative)) {
      problems.push(`${relative}: path in a code block does not exist: ${token}`);
    }
  }
  const docDirectory = path.dirname(path.join(root, relative));
  for (const target of localLinks(prose)) {
    const [file, fragment] = target.split('#');
    const resolved = file ? path.resolve(docDirectory, file) : path.join(root, relative);
    if (file && isAllowedMissing(path.relative(root, resolved).replaceAll('\\', '/'))) {
      continue;
    }
    if (!exists(resolved)) {
      problems.push(`${relative}: link target does not exist: ${target}`);
      continue;
    }
    if (fragment && resolved.endsWith('.md') && !anchorsOf(resolved).has(fragment)) {
      problems.push(`${relative}: link anchor does not exist: ${target}`);
    }
  }
  return problems;
}

test('contributor guides and AGENTS.md files quote only paths that exist', () => {
  const problems = [...GUIDES, ROOT_AGENTS, ...DIRECTORY_AGENTS].flatMap(checkDocument);
  assert.deepEqual(problems, []);
});

test('every npm script the guides mention is defined in package.json', () => {
  const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts));
  const problems = [];
  for (const relative of [...GUIDES, ROOT_AGENTS, ...DIRECTORY_AGENTS]) {
    for (const match of read(relative).matchAll(/npm run ([a-z][\w:.-]*)/g)) {
      if (!scripts.has(match[1])) {
        problems.push(`${relative}: unknown npm script: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('directory AGENTS.md files stay short and the root file stays bounded', () => {
  for (const relative of DIRECTORY_AGENTS) {
    const lines = lineCount(read(relative));
    assert.ok(lines < DIRECTORY_AGENTS_MAX_LINES, `${relative} has ${lines} lines`);
    assert.ok(lines >= 20, `${relative} has only ${lines} lines`);
  }
  const rootLines = lineCount(read(ROOT_AGENTS));
  assert.ok(rootLines <= ROOT_AGENTS_MAX_LINES, `${ROOT_AGENTS} has ${rootLines} lines`);
});

test('the root AGENTS.md keeps its rules and points to the guides', () => {
  const text = read(ROOT_AGENTS);
  assert.match(text, /^# Forge engineering rules/m);
  for (const heading of [
    '## Working behavior',
    '## Ownership and file placement',
    '## Formatting and linting',
    '## Naming and interfaces',
    '## Verification and completion',
  ]) {
    assert.ok(text.includes(heading), `${ROOT_AGENTS} lost the heading ${heading}`);
  }
  for (const target of [
    'docs/CODE_STYLE.md',
    'docs/ADDING_A_MODEL.md',
    'docs/ADDING_A_FEATURE.md',
    'docs/ROADMAP.md',
    'docs/MODEL_SOURCES.md',
  ]) {
    assert.ok(text.includes(`](${target})`), `${ROOT_AGENTS} does not link ${target}`);
  }
});

test('each directory AGENTS.md sits in a directory that exists', () => {
  for (const relative of DIRECTORY_AGENTS) {
    assert.ok(exists(path.join(root, path.dirname(relative))), relative);
    assert.match(read(relative), /^# \S+ rules/m, `${relative} needs a title`);
  }
});

test('the documentation index links the three contributor guides', () => {
  const index = read('docs/README.md');
  for (const guide of ['CODE_STYLE.md', 'ADDING_A_MODEL.md', 'ADDING_A_FEATURE.md']) {
    assert.ok(index.includes(`](${guide})`), `docs/README.md does not link ${guide}`);
  }
});

test('the README documentation list links the contributor guides', () => {
  const readme = read('README.md');
  for (const guide of [
    'docs/CODE_STYLE.md',
    'docs/ADDING_A_MODEL.md',
    'docs/ADDING_A_FEATURE.md',
  ]) {
    assert.ok(readme.includes(`](${guide})`), `README.md does not link ${guide}`);
  }
});

test('pending-system notes are reported once the system documentation exists', (t) => {
  for (const pending of ALLOWED_PENDING_FILES) {
    if (!exists(path.join(root, pending))) {
      continue;
    }
    const stale = [...GUIDES, ...DIRECTORY_AGENTS].filter((relative) =>
      read(relative).includes(`Pending: see ${pending}`),
    );
    if (stale.length) {
      // Not a failure: this tells the person refreshing the guides which lines to rewrite.
      t.diagnostic(`${pending} now exists; refresh the pending lines in ${stale.join(', ')}`);
    }
  }
});
