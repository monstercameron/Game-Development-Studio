#!/usr/bin/env node
// Lists user-visible English that is not wrapped in t(), tp() or <T> yet.
//
//   node tools/i18n-scan.mjs src/Foo.jsx [more files]   (npm run i18n:scan -- src/Foo.jsx)
//   node tools/i18n-scan.mjs                             every file in src/ (summary per file)
//   --json      machine-readable findings
//   --report    always exit 0 (default: exit 1 when anything is found, for use as a gate)
//
// Reported: JSX text; string literals in aria-label, title, placeholder, alt, label and similar
// props; literal branches of {cond ? 'A' : 'B'} children; messages passed to setNotice/setError
// style setters, alert/confirm and Error(); UI-named object properties (label, title, message…)
// and returned sentences in helper modules. Silence a deliberate exception with a comment that
// contains `i18n-ignore` on the same line or the line above, with a reason.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  i18nBindings,
  jsxName,
  listSourceFiles,
  parseSource,
  relativePath,
  repositoryRoot,
  walk,
} from './i18n-ast.mjs';

export const TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
  'label',
  'summary',
  'description',
  'helperText',
  'emptyText',
  'confirmLabel',
  'cancelLabel',
]);
const MESSAGE_CALLEE =
  /^(set(Notice|Error|Message|Status|Warning|Hint|Toast|Info|Feedback)|notify|toast|alert|confirm|announce|reportNoticeError)$/;
const ERROR_CONSTRUCTORS = new Set(['Error', 'TypeError', 'RangeError']);
const UI_PROPERTIES = new Set([
  'label',
  'title',
  'description',
  'hint',
  'helper',
  'help',
  'placeholder',
  'message',
  'summary',
  'tooltip',
  'caption',
  'heading',
  'subtitle',
  'emptyText',
  'detail',
  'short',
  'notice',
  'warning',
  'text',
]);
// Product, model and unit names that are never translated when they appear alone.
const ALLOWED_WORDS = new Set([
  'Forge',
  'Forge Studio',
  'GPU',
  'CPU',
  'CUDA',
  'OpenAI',
  'ChatGPT',
  'GitHub',
  'Megascans',
  'Fab',
  'Qwen',
  'TRELLIS.2',
  'Hunyuan3D',
  'HY-Motion',
  'MotionBricks',
  'SAM',
  'SAM 3.1',
  'SeedThree',
  'Windows',
  'MCP',
  'JSON',
  'PNG',
  'JPEG',
  'WebP',
  'GLB',
  'FBX',
  'BVH',
  'PLY',
  'WAV',
  'MP3',
  'MP4',
  'MiB',
  'GiB',
  'KB',
  'MB',
  'GB',
  'TB',
  'px',
  'ms',
  'fps',
  'Hz',
  'kHz',
  'dB',
  'OK',
  'VRAM',
  'RAM',
  'LoRA',
]);

const CODE_LIKE = [
  /^[a-z0-9]+([-_.:/][a-z0-9]+)*$/, // ids, kebab/snake case, enum values, simple paths
  /^[A-Z0-9_]+$/, // CONSTANTS
  /^[a-z]+[A-Z][A-Za-z0-9]*$/, // camelCase identifiers
  /^(https?:|mailto:|\/|\.\.?\/|#[\w-]*$|data:|blob:)/, // URLs, routes, anchors
  /^[a-z]+\/[a-z0-9.+-]+(;.*)?$/i, // MIME types
  /^#[0-9a-f]{3,8}$/i, // colours
  /^(rgba?|hsla?|var|calc|url|translate[XYZ3d]*|scale|rotate)\(/, // CSS values
  /^-?[\d.]+(px|rem|em|%|vh|vw|s|ms|deg|fr)?$/, // numbers and CSS lengths
  /^\.?[\w-]+(\.[\w-]+)+$/, // file names, dotted selectors
  /^[\w.-]+=[^\s]*$/, // key=value
  /^[[\]{}()<>.,:;!?/\\|*+=~^%$#@&'"`·•×–—…\s\d-]+$/, // punctuation and symbols only
];

/** True for text a person would read: has letters and is not code, a URL or a product name. */
export function looksLikeUiText(value, { strict = false } = {}) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  const withoutExtensions = text.replace(/\.[a-z0-9]{2,4}\b/gi, '');
  if (!/[A-Za-z]{2,}/.test(withoutExtensions) || ALLOWED_WORDS.has(text)) {
    return false;
  }
  if (CODE_LIKE.some((pattern) => pattern.test(text))) {
    return false;
  }
  if (!strict) {
    return true;
  }
  // Helper-module strings: a capitalised word or a phrase with a space.
  return /^[A-Z][a-z]/.test(text) || (/\s/.test(text) && /[a-z]{2,}/.test(text));
}

function isSentence(text) {
  const value = String(text || '').trim();
  return (
    /^[A-Z][a-z']*\b/.test(value) && (value.match(/ /g) || []).length >= 2 && /[.!?…:]$/.test(value)
  );
}

function ignoredLines(source) {
  const lines = new Set();
  source.split(/\r?\n/).forEach((line, index) => {
    if (line.includes('i18n-ignore')) {
      lines.add(index + 1);
      lines.add(index + 2);
    }
  });
  return lines;
}

function isInsideTranslation(ancestors, bindings) {
  return ancestors.some(
    (node) =>
      (node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        (bindings.t.has(node.callee.name) || bindings.tp.has(node.callee.name))) ||
      (node.type === 'JSXOpeningElement' && bindings.T.has(jsxName(node.name))) ||
      (node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'console'),
  );
}

/** Literal strings reachable as the value of an expression (through ?:, ||, ?? and +). */
function literalValues(node) {
  if (!node) {
    return [];
  }
  switch (node.type) {
    case 'StringLiteral':
      return [{ node, text: node.value }];
    case 'TemplateLiteral': {
      const text = node.quasis.map((quasi) => quasi.value.cooked).join(' ');
      return [{ node, text, template: node.expressions.length > 0 }];
    }
    case 'ConditionalExpression':
      return [...literalValues(node.consequent), ...literalValues(node.alternate)];
    case 'LogicalExpression':
      return node.operator === '&&'
        ? literalValues(node.right)
        : [...literalValues(node.left), ...literalValues(node.right)];
    case 'BinaryExpression':
      return node.operator === '+'
        ? [...literalValues(node.left), ...literalValues(node.right)]
        : [];
    case 'JSXExpressionContainer':
      return literalValues(node.expression);
    default:
      return [];
  }
}

/** Findings for one file: { line, kind, text }. */
export function scanSource(source, file) {
  let program;
  try {
    program = parseSource(source, file).program;
  } catch (error) {
    return [{ line: error.loc?.line || 0, kind: 'parse-error', text: error.message }];
  }
  const bindings = i18nBindings(program);
  const ignored = ignoredLines(source);
  const isJsx = file.endsWith('.jsx');
  const findings = [];
  const seen = new Set();
  const report = (node, kind, text, ancestors, options) => {
    const line = node.loc?.start.line || 0;
    const id = node.start;
    if (
      seen.has(id) ||
      ignored.has(line) ||
      isInsideTranslation(ancestors, bindings) ||
      !looksLikeUiText(text, options)
    ) {
      return;
    }
    seen.add(id);
    findings.push({ line, kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 100) });
  };
  const reportValues = (expression, kind, ancestors, options) => {
    for (const item of literalValues(expression)) {
      report(item.node, kind, item.text, ancestors, options);
    }
  };

  walk(program, (node, ancestors) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') {
      return false;
    }
    if (node.type === 'JSXText') {
      report(node, 'jsx-text', node.value, ancestors);
    } else if (node.type === 'JSXExpressionContainer') {
      const parent = ancestors.at(-1);
      if (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment') {
        reportValues(node.expression, 'jsx-expression', ancestors);
      }
    } else if (node.type === 'JSXAttribute') {
      const name = jsxName(node.name);
      if (TEXT_ATTRIBUTES.has(name)) {
        reportValues(node.value, 'attribute', ancestors);
      }
    } else if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee;
      const name =
        callee.type === 'Identifier'
          ? callee.name
          : callee.type === 'MemberExpression' && !callee.computed
            ? callee.property.name
            : '';
      if (MESSAGE_CALLEE.test(name)) {
        reportValues(node.arguments[0], 'message', [...ancestors, node], { strict: true });
      } else if (ERROR_CONSTRUCTORS.has(name) && callee.type === 'Identifier') {
        reportValues(node.arguments[0], 'error-message', [...ancestors, node], { strict: true });
      }
    } else if (node.type === 'ObjectProperty' && !node.computed) {
      const name = node.key.type === 'Identifier' ? node.key.name : node.key.value;
      if (UI_PROPERTIES.has(name)) {
        reportValues(node.value, 'property', [...ancestors, node], { strict: true });
      }
    } else if (
      (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') &&
      isSentence(literalValues(node)[0]?.text)
    ) {
      // A full sentence anywhere (constants, maps, defaults) is almost always shown to people.
      report(node, 'sentence', literalValues(node)[0].text, ancestors, { strict: true });
    } else if (node.type === 'ReturnStatement' && !isJsx) {
      // Helper modules often return the message to show; require a phrase to keep noise low.
      for (const item of literalValues(node.argument)) {
        if (/\s/.test(item.text.trim()) && /[a-z]{2,}/.test(item.text)) {
          report(item.node, 'returned-text', item.text, [...ancestors, node], { strict: true });
        }
      }
    }
    return undefined;
  });
  return findings.sort((a, b) => a.line - b.line);
}

export function scanFiles(files) {
  return files.map((file) => ({
    file: relativePath(file),
    findings: scanSource(fs.readFileSync(file, 'utf8'), relativePath(file)),
  }));
}

export function main(argv = process.argv.slice(2)) {
  const isJson = argv.includes('--json');
  const isReport = argv.includes('--report');
  const selected = argv
    .filter((arg) => !arg.startsWith('--'))
    .map((arg) => path.resolve(repositoryRoot, arg));
  for (const file of selected) {
    if (!fs.existsSync(file)) {
      console.error(`No such file: ${relativePath(file)}`);
      return 2;
    }
  }
  const files = selected.length
    ? selected
    : listSourceFiles().filter((file) => !/[\\/]src[\\/](i18n|tooltips[\\/]pages)[\\/]/.test(file));
  const results = scanFiles(files);
  const total = results.reduce((sum, item) => sum + item.findings.length, 0);
  if (isJson) {
    console.log(JSON.stringify({ total, files: results }, null, 2));
  } else {
    const detailed = selected.length > 0;
    for (const result of results) {
      if (!result.findings.length) {
        continue;
      }
      console.log(`${result.file}: ${result.findings.length}`);
      if (detailed) {
        for (const finding of result.findings) {
          console.log(`  L${finding.line} [${finding.kind}] ${JSON.stringify(finding.text)}`);
        }
      }
    }
    const clean = results.filter((item) => !item.findings.length).length;
    console.log(
      `${total} unwrapped strings in ${results.length - clean} of ${results.length} files.` +
        (detailed ? '' : ' Pass file names to list line numbers.'),
    );
  }
  return total && !isReport ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main();
}
