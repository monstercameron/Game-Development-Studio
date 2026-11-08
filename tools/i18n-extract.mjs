#!/usr/bin/env node
// Collects every t(), tp() and <T> call in src/ (plus field-help tooltips) into the English
// catalogs src/i18n/locales/en/<namespace>.json and src/i18n/manifest.json.
//
//   node tools/i18n-extract.mjs                 write the catalogs (npm run i18n:extract)
//   node tools/i18n-extract.mjs --check         fail on errors or out-of-date catalogs
//   node tools/i18n-extract.mjs --check src/Foo.jsx
//                                               check only these files' calls; no catalog diff
//   --json                                      machine-readable report
//
// Errors: dynamic or malformed keys, unknown namespaces, non-static English defaults, the same
// key with two different defaults, invalid plural forms and unbalanced rich-text tags.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceHash } from '../runtime/i18n-catalog.js';
import { PLURAL_CATEGORIES, parseRichText, tooltipKey } from '../src/i18n/message-format.js';
import { KEY_PATTERN, isKnownNamespace, namespaceOf } from '../src/i18n/namespaces.js';
import {
  i18nBindings,
  jsxAttribute,
  jsxName,
  listSourceFiles,
  parseSource,
  relativePath,
  repositoryRoot,
  sourceRoot,
  staticString,
  topLevelStrings,
  walk,
} from './i18n-ast.mjs';

const TOOLTIP_PAGES = path.join(sourceRoot, 'tooltips', 'pages');

function issue(list, file, line, message) {
  list.push({ file, line, message });
}

function checkKey(key, file, line, errors) {
  if (key === null) {
    issue(errors, file, line, 'Dynamic key: the first argument must be a string literal.');
    return false;
  }
  if (!KEY_PATTERN.test(key)) {
    issue(errors, file, line, `Malformed key "${key}": use <namespace>.<component>.<name>.`);
    return false;
  }
  if (!isKnownNamespace(namespaceOf(key))) {
    issue(
      errors,
      file,
      line,
      `Unknown namespace "${namespaceOf(key)}" in "${key}". See src/i18n/namespaces.js.`,
    );
    return false;
  }
  return true;
}

function checkText(text, { file, line, key, errors, warnings, rich }) {
  if (text === null) {
    issue(errors, file, line, `"${key}": the English default must be a static string.`);
    return false;
  }
  if (!text.trim()) {
    issue(errors, file, line, `"${key}": the English default is empty.`);
    return false;
  }
  const tree = parseRichText(text);
  if (!tree) {
    issue(errors, file, line, `"${key}": rich-text tags are not balanced.`);
    return false;
  }
  if (!rich && tree.some((node) => typeof node !== 'string')) {
    issue(warnings, file, line, `"${key}": tags in t() render literally; use <T> for rich text.`);
  }
  return true;
}

function pluralForms(node, constants) {
  if (node?.type !== 'ObjectExpression') {
    return null;
  }
  const forms = {};
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) {
      return null;
    }
    const name = property.key.type === 'Identifier' ? property.key.name : property.key.value;
    const value = staticString(property.value, constants);
    if (value === null) {
      return null;
    }
    forms[name] = value;
  }
  return forms;
}

/** Extracts the calls of one source file. */
export function extractFromSource(source, file) {
  const errors = [];
  const warnings = [];
  const entries = [];
  let program;
  try {
    program = parseSource(source, file).program;
  } catch (error) {
    issue(errors, file, error.loc?.line || 0, `Parse error: ${error.message}`);
    return { entries, errors, warnings };
  }
  const bindings = i18nBindings(program);
  if (!bindings.imported) {
    return { entries, errors, warnings };
  }
  const constants = topLevelStrings(program);
  walk(program, (node) => {
    const line = node.loc?.start.line || 0;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      const name = node.callee.name;
      if (bindings.t.has(name)) {
        const key = staticString(node.arguments[0], constants);
        if (!checkKey(key, file, line, errors)) {
          return;
        }
        const text = staticString(node.arguments[1], constants);
        if (checkText(text, { file, line, key, errors, warnings, rich: false })) {
          entries.push({ key, kind: 'text', value: text, file, line });
        }
      } else if (bindings.tp.has(name)) {
        const key = staticString(node.arguments[0], constants);
        if (!checkKey(key, file, line, errors)) {
          return;
        }
        const forms = pluralForms(node.arguments[2], constants);
        if (!forms) {
          issue(errors, file, line, `"${key}": tp() forms must be an object of static strings.`);
          return;
        }
        const categories = Object.keys(forms);
        const unknown = categories.filter((category) => !PLURAL_CATEGORIES.includes(category));
        if (unknown.length || !forms.one || !forms.other) {
          issue(
            errors,
            file,
            line,
            `"${key}": tp() needs "one" and "other" forms and only CLDR categories.`,
          );
          return;
        }
        const ordered = Object.fromEntries(
          PLURAL_CATEGORIES.filter((category) => forms[category]).map((category) => [
            category,
            forms[category],
          ]),
        );
        if (
          Object.values(ordered).every((text) =>
            checkText(text, { file, line, key, errors, warnings, rich: false }),
          )
        ) {
          entries.push({ key, kind: 'plural', value: ordered, file, line });
        }
      }
    } else if (node.type === 'JSXOpeningElement' && bindings.T.has(jsxName(node.name))) {
      const idAttribute = jsxAttribute(node, 'id');
      const key = idAttribute ? staticString(idAttribute.value, constants) : null;
      if (!checkKey(key, file, line, errors)) {
        return;
      }
      const englishAttribute = jsxAttribute(node, 'en');
      const text = englishAttribute ? staticString(englishAttribute.value, constants) : null;
      if (checkText(text, { file, line, key, errors, warnings, rich: true })) {
        entries.push({ key, kind: 'text', value: text, file, line });
      }
    }
    return undefined;
  });
  return { entries, errors, warnings };
}

/** Tooltip texts from src/tooltips/pages/<section>.js as <section>.tooltip.<slug> entries. */
export function extractTooltips(source, file, section) {
  const errors = [];
  const entries = [];
  const program = parseSource(source, file).program;
  const constants = topLevelStrings(program);
  const objects = new Map();
  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        if (declarator.init?.type === 'ObjectExpression' && declarator.id.type === 'Identifier') {
          objects.set(declarator.id.name, declarator.init);
        }
      }
    }
  }
  const exported = program.body.find((statement) => statement.type === 'ExportDefaultDeclaration');
  const object =
    exported?.declaration.type === 'ObjectExpression'
      ? exported.declaration
      : objects.get(exported?.declaration.name);
  if (!object || !isKnownNamespace(section)) {
    return { entries, errors, warnings: [] };
  }
  for (const property of object.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) {
      continue;
    }
    const label = property.key.type === 'Identifier' ? property.key.name : property.key.value;
    const text = staticString(property.value, constants);
    const line = property.loc?.start.line || 0;
    if (typeof label !== 'string' || text === null) {
      issue(errors, file, line, 'Tooltip entries must map a label to static text.');
      continue;
    }
    entries.push({ key: tooltipKey(section, label), kind: 'text', value: text, file, line });
  }
  return { entries, errors, warnings: [] };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Runs the extraction over all sources and returns entries per key with issues. */
export function extractAll({ files = listSourceFiles(), tooltipDirectory = TOOLTIP_PAGES } = {}) {
  const errors = [];
  const warnings = [];
  const keys = new Map();
  const add = (entry) => {
    const existing = keys.get(entry.key);
    if (!existing) {
      keys.set(entry.key, { ...entry, files: [entry.file], locations: [entry] });
      return;
    }
    if (existing.kind !== entry.kind || !sameValue(existing.value, entry.value)) {
      issue(
        errors,
        entry.file,
        entry.line,
        `Duplicate key "${entry.key}" with a different default than ${existing.file}:${existing.line}.`,
      );
      return;
    }
    existing.locations.push(entry);
    if (!existing.files.includes(entry.file)) {
      existing.files.push(entry.file);
    }
  };
  for (const file of files) {
    if (path.dirname(file) === tooltipDirectory) {
      continue;
    }
    const result = extractFromSource(fs.readFileSync(file, 'utf8'), relativePath(file));
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    result.entries.forEach(add);
  }
  if (tooltipDirectory && fs.existsSync(tooltipDirectory)) {
    for (const name of fs.readdirSync(tooltipDirectory).filter((item) => item.endsWith('.js'))) {
      const file = path.join(tooltipDirectory, name);
      const result = extractTooltips(
        fs.readFileSync(file, 'utf8'),
        relativePath(file),
        name.slice(0, -3),
      );
      errors.push(...result.errors);
      result.entries.forEach(add);
    }
  }
  return { keys, errors, warnings };
}

/** Catalog file contents per namespace plus the manifest, as formatted JSON text. */
export function buildOutputs(keys) {
  const namespaces = new Map();
  const manifestKeys = {};
  for (const key of [...keys.keys()].sort()) {
    const entry = keys.get(key);
    const namespace = namespaceOf(key);
    if (!namespaces.has(namespace)) {
      namespaces.set(namespace, {});
    }
    namespaces.get(namespace)[key] = entry.value;
    manifestKeys[key] = {
      hash: sourceHash(entry.value),
      kind: entry.kind,
      files: [...entry.files].sort(),
    };
  }
  const catalogs = new Map();
  const manifestNamespaces = {};
  for (const [namespace, values] of [...namespaces].sort(([a], [b]) => a.localeCompare(b))) {
    catalogs.set(namespace, `${JSON.stringify(values, null, 2)}\n`);
    manifestNamespaces[namespace] = {
      strings: Object.keys(values).length,
      hash: sourceHash(JSON.stringify(values)),
    };
  }
  const manifest = {
    version: 1,
    generatedBy: 'tools/i18n-extract.mjs',
    namespaces: manifestNamespaces,
    keys: manifestKeys,
  };
  return { catalogs, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
}

// Rename replaces the target in one step, so an interrupted run leaves the old catalog or the new
// one, never a truncated file that a later --check would accept.
function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
}

/** Differences between generated outputs and the files on disk. */
export function compareOutputs(outputs, { catalogDirectory, manifestFile }) {
  const problems = [];
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  for (const [namespace, text] of outputs.catalogs) {
    const current = read(path.join(catalogDirectory, `${namespace}.json`));
    if (current?.replace(/\r\n/g, '\n') !== text) {
      problems.push(`${namespace}.json is ${current === null ? 'missing' : 'out of date'}`);
    }
  }
  if (fs.existsSync(catalogDirectory)) {
    for (const name of fs.readdirSync(catalogDirectory)) {
      if (name.endsWith('.json') && !outputs.catalogs.has(name.slice(0, -5))) {
        problems.push(`${name} has no strings in the source any more`);
      }
    }
  }
  if (read(manifestFile)?.replace(/\r\n/g, '\n') !== outputs.manifest) {
    problems.push('manifest.json is out of date');
  }
  return problems;
}

/** Writes the catalogs and manifest, and deletes catalog files that no longer have strings. */
export function writeOutputs(outputs, { catalogDirectory, manifestFile }) {
  fs.mkdirSync(catalogDirectory, { recursive: true });
  for (const name of fs.readdirSync(catalogDirectory)) {
    if (name.endsWith('.json') && !outputs.catalogs.has(name.slice(0, -5))) {
      fs.rmSync(path.join(catalogDirectory, name));
    }
  }
  for (const [namespace, text] of outputs.catalogs) {
    writeAtomic(path.join(catalogDirectory, `${namespace}.json`), text);
  }
  writeAtomic(manifestFile, outputs.manifest);
}

function printIssues(label, list) {
  for (const item of list) {
    console.log(`${label} ${item.file}:${item.line} ${item.message}`);
  }
}

/**
 * CLI entry point. Returns the exit code: 1 on errors, or on stale catalogs in --check mode.
 * `options` lets tests redirect the catalog directory, manifest file or source file list.
 */
export function main(argv = process.argv.slice(2), options = {}) {
  const catalogDirectory =
    options.catalogDirectory || path.join(sourceRoot, 'i18n', 'locales', 'en');
  const manifestFile = options.manifestFile || path.join(sourceRoot, 'i18n', 'manifest.json');
  const isCheck = argv.includes('--check');
  const isJson = argv.includes('--json');
  const selected = argv
    .filter((arg) => !arg.startsWith('--'))
    .map((arg) => path.resolve(repositoryRoot, arg));
  // Selected files outside src/ (fixtures, new files) are checked together with the sources.
  const files = [...new Set([...(options.files || listSourceFiles()), ...selected])];
  const result = extractAll({ files });
  const selectedNames = new Set(selected.map(relativePath));
  const inScope = (item) => !selected.length || selectedNames.has(item.file);
  const errors = result.errors.filter(inScope);
  const warnings = result.warnings.filter(inScope);
  const entries = [...result.keys.values()].filter(
    (entry) => !selected.length || entry.files.some((file) => selectedNames.has(file)),
  );
  let stale = [];
  const outputs = buildOutputs(result.keys);
  if (isCheck && !selected.length) {
    stale = compareOutputs(outputs, { catalogDirectory, manifestFile });
  }
  if (!isCheck && !selected.length && !result.errors.length) {
    writeOutputs(outputs, { catalogDirectory, manifestFile });
  }
  const report = {
    keys: entries.length,
    namespaces: [...new Set(entries.map((entry) => namespaceOf(entry.key)))].sort(),
    errors,
    warnings,
    stale,
    written: !isCheck && !selected.length && !result.errors.length,
  };
  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printIssues('error', errors);
    printIssues('warning', warnings);
    for (const problem of stale) {
      console.log(`stale ${problem}`);
    }
    if (selected.length) {
      for (const entry of entries) {
        const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
        console.log(`key ${entry.key} = ${value}`);
      }
    }
    const action = report.written
      ? 'Wrote'
      : isCheck || selected.length
        ? 'Checked'
        : 'Not written (fix errors first):';
    console.log(
      `${action} ${report.keys} keys in ${report.namespaces.length} namespaces; ` +
        `${errors.length} errors, ${warnings.length} warnings` +
        (stale.length ? `, ${stale.length} stale files (run npm run i18n:extract)` : '') +
        '.',
    );
  }
  return errors.length || stale.length || (!isCheck && !selected.length && result.errors.length)
    ? 1
    : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main();
}
