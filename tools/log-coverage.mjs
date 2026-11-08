#!/usr/bin/env node
// Finds places that should log but do not, for the structured application log (docs/LOGGING.md).
//
//   node tools/log-coverage.mjs runtime/clips.js        TODO list for one file
//   node tools/log-coverage.mjs runtime/clips.js --json the same as JSON
//   node tools/log-coverage.mjs --repo [--json]         every source file ranked by gap score
//   node tools/log-coverage.mjs --check <file...>       exit 1 while a required signal is unlogged
//
// JavaScript and JSX are parsed with @babel/parser; Python is scanned with indentation-aware
// line heuristics. A signal is "logged" when a log call (log.info(...), logger.warn(...),
// withLogging(...), ...) is inside the catch block (for catch signals) or inside the enclosing
// function (for the others; within 8 lines at module level). A line can opt out with a comment on
// the same or previous line: `// log-coverage: ignore -- <reason>` (`#` in Python). The reason
// is required. See docs/LOGGING_CONVERSION_GUIDE.md for what each signal means.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Signal kinds. `required` ones fail --check while unlogged. */
export const SIGNALS = Object.freeze({
  'empty-catch': {
    required: true,
    hint: 'Empty catch: log at debug/warn with { error } (class and code) or add an ignore comment with the reason.',
  },
  'swallowed-catch': {
    required: true,
    hint: 'Catch handles the error without rethrowing: log it (warn, or debug for expected cases) with { error }.',
  },
  'rethrow-catch': {
    required: false,
    hint: 'Catch only rethrows: fine as is; log here only if this layer adds useful context.',
  },
  'external-call': {
    required: true,
    hint: 'Network call: log host or route template, status and durationMs on completion or failure (never bodies or query strings).',
  },
  'process-spawn': {
    required: true,
    hint: 'Child process or thread: log start (kind, pid) and exit (exitCode, signal, durationMs).',
  },
  'state-transition': {
    required: true,
    hint: 'State change: log from, to and the id (jobId, engineId, ...) at info.',
  },
  'fs-write': {
    required: false,
    hint: 'File write, move or delete: log kind and bytes (never the path) on failure, or at debug on success.',
  },
  'sqlite-write': {
    required: false,
    hint: 'Database write: log the operation and row counts for migrations, deletes and retention; not per row.',
  },
  'process-handler': {
    required: false,
    hint: 'Process event handler: log the event (signal, exitCode) at info or error.',
  },
  timer: {
    required: false,
    hint: 'Interval or background loop: log start/stop, and failures inside it; never log every tick.',
  },
  'route-handler': {
    required: false,
    hint: 'HTTP route: log validation failures (field and rule) and errors; completion is logged centrally.',
  },
  'browser-node-logger': {
    required: true,
    hint: "This module is also bundled into the browser (imported from src/): import createLogger from './shared-log.js' instead of './app-log.js', which needs Node built-ins.",
  },
  'fire-and-forget': {
    required: false,
    hint: 'Promise without await or catch: add .catch((error) => log.warn(..., { error })).',
  },
});

const REQUIRED_WEIGHT = 3;
const RECOMMENDED_WEIGHT = 1;
const MODULE_LEVEL_WINDOW_LINES = 8;
// A process handler or timer also counts as logged when a log call starts within this many lines
// after the registration (handlers often log a few lines down in their body).
const HANDLER_WINDOW_LINES = 12;
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'warning', 'error', 'time']);
const SPAWN_NAMES = new Set([
  'spawn',
  'fork',
  'exec',
  'execFile',
  'spawnSync',
  'execSync',
  'execFileSync',
]);
const FS_WRITE_NAMES = new Set([
  'writeFile',
  'writeFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'truncate',
  'truncateSync',
]);
const STATE_PROPERTIES = new Set(['status', 'state', 'phase']);
const SQL_WRITE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE\s+(?:TABLE|INDEX))\b/i;
const SQL_STATE_UPDATE = /\bUPDATE\s+\w+\s+SET\b[^;]*?\b(?:status|state)\s*=/i;
const IGNORE_COMMENT = /log-coverage:\s*ignore\s*(?:--|:)?\s*\S/;
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments']);

// Files that implement logging itself, generated or vendored code, and configuration.
const EXCLUDED_FILES = new Set([
  'runtime/app-log.js',
  'runtime/app_log.py',
  'runtime/log-fields.js',
  'src/app-log.js',
  // The store and ingester report through return values and stats: logging from them would
  // write into the spool they are ingesting.
  'runtime/log-store.js',
  'runtime/log-ingest.js',
  'eslint.config.js',
  'vite.config.js',
]);
const EXCLUDED_DIRECTORIES = [
  'runtime/trellis-patches/',
  'runtime/__pycache__/',
  'src/i18n/locales/',
];

function isLogCallee(callee) {
  if (callee?.type === 'Identifier') {
    return callee.name === 'withLogging';
  }
  if (callee?.type !== 'MemberExpression' || callee.computed) {
    return false;
  }
  if (!LOG_METHODS.has(callee.property?.name)) {
    return false;
  }
  const object = callee.object;
  if (object?.type === 'Identifier') {
    return /log/i.test(object.name) && object.name !== 'console';
  }
  if (object?.type === 'MemberExpression' && !object.computed) {
    return /log/i.test(object.property?.name ?? '');
  }
  if (object?.type === 'CallExpression') {
    // createLogger('x').info(...) or log.child({...}).info(...)
    return isLogCallee(object.callee) || /createLog/.test(object.callee?.name ?? '');
  }
  return false;
}

function isFunction(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'
  );
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') {
    return;
  }
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, visit, next);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, next);
    }
  }
}

// Collects facts about a subtree without entering nested functions.
function scan(node, { enterFunctions = false } = {}) {
  const facts = { logCalls: 0, throws: 0, statements: 0 };
  walk(node, (child, ancestors) => {
    const insideNested = ancestors.slice(1).some(isFunction);
    if (insideNested && !enterFunctions) {
      return;
    }
    if (child.type === 'CallExpression' && isLogCallee(child.callee)) {
      facts.logCalls += 1;
    }
    if (child.type === 'ThrowStatement') {
      facts.throws += 1;
    }
  });
  return facts;
}

function calleeName(callee) {
  if (callee?.type === 'Identifier') {
    return callee.name;
  }
  if (callee?.type === 'MemberExpression' && !callee.computed) {
    return callee.property?.name ?? '';
  }
  return '';
}

function calleeObjectName(callee) {
  if (callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier') {
    return callee.object.name;
  }
  return '';
}

function stringValue(node) {
  if (node?.type === 'StringLiteral') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral') {
    return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('${}');
  }
  return null;
}

function hasThenWithoutCatch(expression) {
  let current = expression;
  let hasThen = false;
  while (current?.type === 'CallExpression' && current.callee?.type === 'MemberExpression') {
    const name = current.callee.property?.name;
    if (name === 'catch' || name === 'finally') {
      return false;
    }
    if (name === 'then') {
      if (current.arguments.length >= 2) {
        return false;
      }
      hasThen = true;
    }
    current = current.callee.object;
  }
  return hasThen;
}

function classifyCatch(clause) {
  const body = clause.body?.body ?? [];
  const facts = scan(clause.body);
  if (!body.length) {
    return { kind: 'empty-catch', logged: false };
  }
  if (body.length === 1 && body[0].type === 'ThrowStatement') {
    return { kind: 'rethrow-catch', logged: true };
  }
  if (facts.logCalls > 0) {
    return { kind: 'swallowed-catch', logged: true };
  }
  if (facts.throws > 0) {
    return { kind: 'rethrow-catch', logged: true };
  }
  return { kind: 'swallowed-catch', logged: false };
}

function lineIgnored(lines, line) {
  return [line - 1, line - 2].some((index) => IGNORE_COMMENT.test(lines[index] ?? ''));
}

function analyzeJavaScript(source, relativeFile) {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    sourceFilename: relativeFile,
    plugins: ['jsx', 'topLevelAwait'],
    errorRecovery: true,
  });
  const lines = source.split(/\r?\n/);
  const isBrowser = relativeFile.startsWith('src/');
  const signals = [];
  let logCalls = 0;
  const functionLogCache = new Map();

  function functionHasLog(fn) {
    if (!functionLogCache.has(fn)) {
      functionLogCache.set(fn, scan(fn.body, { enterFunctions: false }).logCalls > 0);
    }
    return functionLogCache.get(fn);
  }

  const moduleLogLines = [];
  const allLogLines = [];
  // Named handlers passed by reference: process.on('message', handleMessage).
  const namedFunctions = new Map();
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) {
      namedFunctions.set(node.id.name, node);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.init &&
      isFunction(node.init)
    ) {
      namedFunctions.set(node.id.name, node.init);
    }
  });
  walk(ast, (node, ancestors) => {
    if (node.type === 'CallExpression' && isLogCallee(node.callee)) {
      logCalls += 1;
      allLogLines.push(node.loc.start.line);
      if (!ancestors.some(isFunction)) {
        moduleLogLines.push(node.loc.start.line);
      }
    }
  });

  // A handler or timer counts as logged when its inline callback logs anywhere in its body
  // (including nested functions); otherwise the enclosing-function rule applies.
  function callbackLogged(call) {
    const isLogged = call.arguments.some((argument) => {
      const fn = argument?.type === 'Identifier' ? namedFunctions.get(argument.name) : argument;
      return isFunction(fn ?? {}) && scan(fn.body, { enterFunctions: true }).logCalls > 0;
    });
    const line = call.loc?.start.line ?? 0;
    const isLoggedBelow = allLogLines.some(
      (logLine) => logLine >= line && logLine <= line + HANDLER_WINDOW_LINES,
    );
    return isLogged || isLoggedBelow ? { logged: true } : {};
  }

  // `fs.unlink(file).catch((error) => log.debug(...))`: the call is covered by the handler
  // chained onto it (.catch, .then with a rejection handler, or .finally).
  function promiseHandlerLogs(node, ancestors) {
    let current = node;
    for (let index = ancestors.length - 1; index >= 1; index -= 1) {
      const member = ancestors[index];
      const call = ancestors[index - 1];
      if (
        member.type !== 'MemberExpression' ||
        member.object !== current ||
        call.type !== 'CallExpression' ||
        call.callee !== member
      ) {
        return false;
      }
      if (['catch', 'then', 'finally'].includes(member.property?.name)) {
        const handlerLogs = call.arguments.some(
          (argument) =>
            isFunction(argument) && scan(argument.body, { enterFunctions: true }).logCalls > 0,
        );
        if (handlerLogs) {
          return true;
        }
      }
      current = call;
      index -= 1;
    }
    return false;
  }

  function add(kind, node, ancestors, { logged, required } = {}) {
    const line = node.loc?.start.line ?? 0;
    const enclosing = [...ancestors].reverse().find(isFunction);
    const isLogged =
      logged ??
      (promiseHandlerLogs(node, ancestors) ||
        (enclosing
          ? functionHasLog(enclosing)
          : moduleLogLines.some(
              (logLine) => Math.abs(logLine - line) <= MODULE_LEVEL_WINDOW_LINES,
            )));
    signals.push({
      kind,
      line,
      required: required ?? SIGNALS[kind].required,
      logged: isLogged,
      ignored: lineIgnored(lines, line),
      snippet: (lines[line - 1] ?? '').trim().slice(0, 100),
    });
  }

  walk(ast, (node, ancestors) => {
    if (node.type === 'CatchClause') {
      const { kind, logged } = classifyCatch(node);
      const firstBodyLine = node.body?.body?.[0]?.loc?.start.line ?? node.loc.start.line + 1;
      signals.push({
        kind,
        line: node.loc.start.line,
        required: SIGNALS[kind].required,
        logged,
        ignored:
          lineIgnored(lines, node.loc.start.line) ||
          IGNORE_COMMENT.test(lines[firstBodyLine - 1] ?? '') ||
          IGNORE_COMMENT.test(lines[node.loc.start.line] ?? ''),
        snippet: (lines[node.loc.start.line - 1] ?? '').trim().slice(0, 100),
      });
      return;
    }
    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      const objectName = calleeObjectName(node.callee);
      if (
        name === 'fetch' ||
        name === 'fetchImpl' ||
        (/^https?$/.test(objectName) && /^(request|get)$/.test(name))
      ) {
        // The browser fetch wrapper (installAppLogCapture) already records failed /api calls.
        add('external-call', node, ancestors, { required: !isBrowser });
      } else if (SPAWN_NAMES.has(name) && node.callee.type !== 'MemberExpression') {
        add('process-spawn', node, ancestors);
      } else if (SPAWN_NAMES.has(name) && /child_process|childProcess|cp/i.test(objectName)) {
        add('process-spawn', node, ancestors);
      } else if (FS_WRITE_NAMES.has(name) && node.callee.type === 'MemberExpression') {
        add('fs-write', node, ancestors);
      } else if (name === 'setInterval') {
        add('timer', node, ancestors, callbackLogged(node));
      } else if (objectName === 'process' && (name === 'on' || name === 'once')) {
        add('process-handler', node, ancestors, callbackLogged(node));
      } else if (name === 'prepare' || name === 'exec') {
        const sql = stringValue(node.arguments[0]);
        if (sql && SQL_STATE_UPDATE.test(sql)) {
          add('state-transition', node, ancestors);
        } else if (sql && SQL_WRITE.test(sql)) {
          add('sqlite-write', node, ancestors);
        }
      }
      return;
    }
    if (node.type === 'NewExpression' && calleeName(node.callee) === 'Worker') {
      add('process-spawn', node, ancestors);
      return;
    }
    if (
      !isBrowser &&
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'MemberExpression' &&
      !node.left.computed &&
      STATE_PROPERTIES.has(node.left.property?.name)
    ) {
      add('state-transition', node, ancestors);
      return;
    }
    if (node.type === 'ExpressionStatement') {
      const expression = node.expression;
      const isVoidCall =
        expression?.type === 'UnaryExpression' &&
        expression.operator === 'void' &&
        expression.argument?.type === 'CallExpression';
      if (isVoidCall || hasThenWithoutCatch(expression)) {
        add('fire-and-forget', node, ancestors);
      }
      return;
    }
    if (!isBrowser && (node.type === 'StringLiteral' || node.type === 'TemplateLiteral')) {
      const parent = ancestors[ancestors.length - 1];
      const text = stringValue(node);
      const isComparison = parent?.type === 'BinaryExpression' || parent?.type === 'SwitchCase';
      const isRouteCall =
        parent?.type === 'CallExpression' &&
        /^(get|post|put|patch|delete|route|use|all)$/.test(calleeName(parent.callee)) &&
        parent.arguments[0] === node;
      if (text?.startsWith('/api/') && (isComparison || isRouteCall)) {
        add('route-handler', node, ancestors);
      }
    }
  });
  return { logCalls, signals };
}

// ---- Python ----------------------------------------------------------------------------------

const PY_LOG_CALL =
  /\b[A-Za-z_]*log[A-Za-z_]*\.(?:trace|debug|info|warn|warning|error|exception|critical|time)\(|\blogging\.(?:debug|info|warning|error|exception|critical)\(/i;
const PY_RULES = [
  [
    /\bsubprocess\.(?:Popen|run|call|check_call|check_output)\(|\bos\.system\(|\bmultiprocessing\.Process\(/,
    'process-spawn',
  ],
  [
    /\burllib\.request\.urlopen\(|\burlopen\(|\brequests\.(?:get|post|put|patch|delete|request)\(|\bhttpx\.|\bhttp\.client\.HTTPS?Connection\(/,
    'external-call',
  ],
  [
    /\.(?:status|state|phase)\s*=(?!=)|\[["'](?:status|state|phase)["']\]\s*=(?!=)/,
    'state-transition',
  ],
  [
    /\bos\.(?:replace|rename|remove|unlink)\(|\bshutil\.(?:move|copy|copy2|copyfile|copytree|rmtree)\(|\.(?:write_bytes|write_text|unlink)\(/,
    'fs-write',
  ],
  [/\bsignal\.signal\(|\batexit\.register\(/, 'process-handler'],
  [/\bthreading\.(?:Thread|Timer)\(/, 'timer'],
  [
    /^\s*@\w+\.(?:get|post|put|patch|delete|route)\(|^\s*def do_(?:GET|POST|PUT|DELETE|PATCH)\(/,
    'route-handler',
  ],
];

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlank(line) {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('#');
}

function blockLines(lines, headerIndex) {
  const headerIndent = indentOf(lines[headerIndex]);
  const body = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (isBlank(lines[index])) {
      continue;
    }
    if (indentOf(lines[index]) <= headerIndent) {
      break;
    }
    body.push(index);
  }
  return body;
}

function enclosingDef(lines, index) {
  const indent = indentOf(lines[index]);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (isBlank(lines[cursor])) {
      continue;
    }
    if (indentOf(lines[cursor]) < indent && /^\s*(?:async\s+)?def\s/.test(lines[cursor])) {
      return cursor;
    }
  }
  return -1;
}

function analyzePython(source) {
  const lines = source.split(/\r?\n/);
  const signals = [];
  let logCalls = 0;
  let isInDocstring = false;
  const codeLines = lines.map((line) => {
    const quotes = (line.match(/"""|'''/g) || []).length;
    const wasInDocstring = isInDocstring;
    if (quotes % 2 === 1) {
      isInDocstring = !isInDocstring;
    }
    return wasInDocstring || quotes ? '' : line;
  });
  const logLineIndexes = [];
  codeLines.forEach((line, index) => {
    if (PY_LOG_CALL.test(line)) {
      logCalls += 1;
      logLineIndexes.push(index);
    }
  });

  function rangeHasLog(from, to) {
    return logLineIndexes.some((index) => index >= from && index <= to);
  }

  function isLoggedNear(index) {
    const def = enclosingDef(codeLines, index);
    if (def < 0) {
      return rangeHasLog(index - MODULE_LEVEL_WINDOW_LINES, index + MODULE_LEVEL_WINDOW_LINES);
    }
    const body = blockLines(codeLines, def);
    return rangeHasLog(def, body.length ? body[body.length - 1] : def);
  }

  codeLines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    const lineNumber = index + 1;
    const snippet = line.trim().slice(0, 100);
    if (/^\s*except\b.*:\s*(?:#.*)?$/.test(line) || /^\s*except\b.*:\s*\S/.test(line)) {
      const inline = line.split(':').slice(1).join(':').trim();
      const body = inline && !inline.startsWith('#') ? [index] : blockLines(codeLines, index);
      const texts = body.map((bodyIndex) =>
        bodyIndex === index ? inline : codeLines[bodyIndex].trim(),
      );
      const hasLog = texts.some((text) => PY_LOG_CALL.test(text));
      const hasRaise = texts.some((text) => /^raise\b/.test(text));
      const isEmpty =
        !texts.length ||
        texts.every((text) => /^(?:pass|\.\.\.|continue|return(?:\s+None)?)$/.test(text));
      let kind = 'swallowed-catch';
      if (isEmpty && !hasLog) {
        kind = 'empty-catch';
      } else if (hasRaise && !hasLog) {
        kind = 'rethrow-catch';
      }
      signals.push({
        kind,
        line: lineNumber,
        required: SIGNALS[kind].required,
        logged: hasLog || hasRaise,
        ignored:
          lineIgnored(lines, lineNumber) ||
          IGNORE_COMMENT.test(lines[index] ?? '') ||
          IGNORE_COMMENT.test(lines[index + 1] ?? ''),
        snippet,
      });
      return;
    }
    for (const [pattern, kind] of PY_RULES) {
      if (pattern.test(line)) {
        signals.push({
          kind,
          line: lineNumber,
          required: SIGNALS[kind].required,
          logged: isLoggedNear(index),
          ignored: lineIgnored(lines, lineNumber) || IGNORE_COMMENT.test(lines[index]),
          snippet,
        });
        break;
      }
    }
  });
  return { logCalls, signals };
}

// ---- Reporting -------------------------------------------------------------------------------

function toRelative(file) {
  return path.relative(repositoryRoot, path.resolve(file)).split(path.sep).join('/');
}

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
let browserBundledFiles = null;

// Every runtime/ or root module that the Vite bundle pulls in through an import chain that starts
// in src/. Such a module must log through runtime/shared-log.js: runtime/app-log.js uses Node
// built-ins and breaks the browser build.
export function findBrowserBundledFiles() {
  if (browserBundledFiles) {
    return browserBundledFiles;
  }
  const bundled = new Set();
  const queue = [];
  const visitSourceDirectory = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visitSourceDirectory(full);
      } else if (/\.(?:js|jsx)$/.test(entry.name)) {
        queue.push(full);
      }
    }
  };
  visitSourceDirectory(path.join(repositoryRoot, 'src'));
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.pop();
    let sourceText;
    try {
      sourceText = fs.readFileSync(file, 'utf8');
    } catch {
      // log-coverage: ignore -- a file removed during the scan has no imports to follow
      continue;
    }
    for (const match of sourceText.matchAll(RELATIVE_IMPORT)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!/\.(?:m?js|jsx)$/.test(target) || seen.has(target) || !fs.existsSync(target)) {
        continue;
      }
      seen.add(target);
      queue.push(target);
      const relative = toRelative(target);
      if (!relative.startsWith('src/')) {
        bundled.add(relative);
      }
    }
  }
  browserBundledFiles = bundled;
  return bundled;
}

function browserLoggerSignals(source, relative) {
  if (relative.startsWith('src/') || !findBrowserBundledFiles().has(relative)) {
    return [];
  }
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    /from\s+['"]\.{1,2}\/(?:runtime\/)?app-log\.js['"]/.test(line),
  );
  if (index < 0) {
    return [];
  }
  return [
    {
      kind: 'browser-node-logger',
      line: index + 1,
      required: true,
      logged: false,
      ignored: false,
      snippet: lines[index].trim().slice(0, 100),
    },
  ];
}

/**
 * Analyzes one file. A parse failure is returned as `parseError` instead of thrown, so one bad
 * file does not stop a repository-wide run.
 *
 * @returns {{ file: string, language: string, logCalls: number, gapScore: number,
 *   missingRequired: number, missingRecommended: number, signals: object[], parseError?: string }}
 */
export function analyzeFile(file) {
  const relative = toRelative(file);
  const source = fs.readFileSync(file, 'utf8');
  const isPython = file.endsWith('.py');
  let result;
  try {
    result = isPython ? analyzePython(source) : analyzeJavaScript(source, relative);
    if (!isPython) {
      result.signals.push(...browserLoggerSignals(source, relative));
    }
  } catch (error) {
    return {
      file: relative,
      language: isPython ? 'python' : 'javascript',
      logCalls: 0,
      gapScore: 0,
      missingRequired: 0,
      missingRecommended: 0,
      signals: [],
      parseError: String(error.message).split('\n')[0].slice(0, 200),
    };
  }
  const open = result.signals.filter((signal) => !signal.logged && !signal.ignored);
  const missingRequired = open.filter((signal) => signal.required).length;
  const missingRecommended = open.length - missingRequired;
  return {
    file: relative,
    language: isPython ? 'python' : 'javascript',
    logCalls: result.logCalls,
    gapScore: missingRequired * REQUIRED_WEIGHT + missingRecommended * RECOMMENDED_WEIGHT,
    missingRequired,
    missingRecommended,
    signals: result.signals.sort((a, b) => a.line - b.line),
  };
}

function listSourceFiles() {
  const files = [];
  const visit = (directory, pattern, recursive) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = toRelative(full);
      if (entry.isDirectory()) {
        if (
          recursive &&
          !EXCLUDED_DIRECTORIES.some((prefix) => `${relative}/`.startsWith(prefix))
        ) {
          visit(full, pattern, recursive);
        }
      } else if (pattern.test(entry.name) && !EXCLUDED_FILES.has(relative)) {
        files.push(full);
      }
    }
  };
  visit(path.join(repositoryRoot, 'runtime'), /\.(?:m?js|cjs|py)$/, true);
  visit(path.join(repositoryRoot, 'src'), /\.(?:js|jsx)$/, true);
  visit(repositoryRoot, /\.(?:js|cjs|mjs)$/, false);
  for (const extra of ['desktop', 'electron']) {
    const directory = path.join(repositoryRoot, extra);
    if (fs.existsSync(directory)) {
      visit(directory, /\.(?:m?js|cjs)$/, true);
    }
  }
  return files;
}

/** Analyzes every instrumentable source file; sorted by gap score, highest first. */
export function analyzeRepository() {
  return listSourceFiles()
    .map(analyzeFile)
    .sort((a, b) => b.gapScore - a.gapScore || a.file.localeCompare(b.file));
}

/** Counts files per gap-score band, for planning. */
export function summarizeBands(results) {
  const bands = { 0: 0, '1-5': 0, '6-15': 0, '16-40': 0, '41+': 0 };
  for (const { gapScore } of results) {
    if (gapScore === 0) {
      bands['0'] += 1;
    } else if (gapScore <= 5) {
      bands['1-5'] += 1;
    } else if (gapScore <= 15) {
      bands['6-15'] += 1;
    } else if (gapScore <= 40) {
      bands['16-40'] += 1;
    } else {
      bands['41+'] += 1;
    }
  }
  return bands;
}

function printFile(result) {
  const lines = [
    `${result.file}: ${result.logCalls} log call(s), gap score ${result.gapScore} ` +
      `(${result.missingRequired} required, ${result.missingRecommended} recommended missing)`,
  ];
  if (result.parseError) {
    lines.push(`  parse error: ${result.parseError}`);
  }
  for (const signal of result.signals) {
    let status = 'TODO';
    if (signal.ignored) {
      status = 'ignored';
    } else if (signal.logged) {
      status = 'ok';
    }
    const need = signal.required ? 'required' : 'recommended';
    lines.push(
      `  ${String(signal.line).padStart(5)}  ${status.padEnd(7)} ${signal.kind} (${need})`,
    );
    lines.push(`         ${signal.snippet}`);
    if (status === 'TODO') {
      lines.push(`         -> ${SIGNALS[signal.kind].hint}`);
    }
  }
  if (!result.signals.length) {
    lines.push('  No signals: this file needs no logging.');
  }
  return lines.join('\n');
}

function main(argv) {
  const isJson = argv.includes('--json');
  const isRepo = argv.includes('--repo');
  const isCheck = argv.includes('--check');
  const files = argv.filter((arg) => !arg.startsWith('--'));
  if (isRepo) {
    const results = analyzeRepository();
    if (isJson) {
      const compact = results.map(({ signals, ...rest }) => ({
        ...rest,
        signals: signals.length,
        kinds: [...new Set(signals.filter((s) => !s.logged && !s.ignored).map((s) => s.kind))],
      }));
      process.stdout.write(
        `${JSON.stringify({ bands: summarizeBands(results), files: compact }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`Gap score bands: ${JSON.stringify(summarizeBands(results))}\n`);
      for (const result of results.filter((item) => item.gapScore > 0)) {
        process.stdout.write(
          `${String(result.gapScore).padStart(4)}  req ${String(result.missingRequired).padStart(3)}  ` +
            `rec ${String(result.missingRecommended).padStart(3)}  logs ${String(result.logCalls).padStart(3)}  ${result.file}\n`,
        );
      }
    }
    return 0;
  }
  if (!files.length) {
    process.stderr.write(
      'Usage: node tools/log-coverage.mjs <file...> [--json] | --repo [--json] | --check <file...>\n',
    );
    return 2;
  }
  const results = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      process.stderr.write(`Not found: ${file}\n`);
      return 2;
    }
    results.push(analyzeFile(file));
  }
  if (isJson) {
    process.stdout.write(
      `${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${results.map(printFile).join('\n\n')}\n`);
  }
  if (isCheck) {
    const failing = results.filter((result) => result.missingRequired > 0 || result.parseError);
    for (const result of failing) {
      process.stderr.write(
        `log:check failed: ${result.file} has ${result.missingRequired} required signal(s) without logging.\n`,
      );
    }
    return failing.length ? 1 : 0;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
