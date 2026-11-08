// Shared parsing helpers for tools/i18n-extract.mjs and tools/i18n-scan.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sourceRoot = path.join(repositoryRoot, 'src');

// '../i18n/index.js' from feature files; './i18n-core.js' or './i18n-react.js' inside src/i18n.
const I18N_IMPORT = /(^|\/)i18n\/index\.js$|(^|\/)i18n-(core|react)\.js$/;
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments']);

/**
 * Parses a module with JSX. Throws on syntax errors (errorRecovery is off) so the caller
 * reports the file instead of walking a partial AST.
 */
export function parseSource(source, file) {
  return parse(source, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['jsx'],
    errorRecovery: false,
  });
}

/** Depth-first walk calling visit(node, ancestors); ancestors excludes node. */
export function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') {
    return;
  }
  if (visit(node, ancestors) === false) {
    return;
  }
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, visit, nextAncestors);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, nextAncestors);
    }
  }
}

/** Top-level `const NAME = 'text'` bindings, so t('key', NAME) can be resolved statically. */
export function topLevelStrings(program) {
  const stringsByName = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
      continue;
    }
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier') {
        const value = staticString(declarator.init, stringsByName);
        if (value !== null) {
          stringsByName.set(declarator.id.name, value);
        }
      }
    }
  }
  return stringsByName;
}

/** The string value of a static expression, or null when it depends on runtime values. */
export function staticString(node, constants = new Map()) {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'TemplateLiteral':
      return node.expressions.length
        ? null
        : node.quasis.map((quasi) => quasi.value.cooked).join('');
    case 'BinaryExpression': {
      if (node.operator !== '+') {
        return null;
      }
      const left = staticString(node.left, constants);
      const right = staticString(node.right, constants);
      return left === null || right === null ? null : left + right;
    }
    case 'Identifier':
      return constants.has(node.name) ? constants.get(node.name) : null;
    case 'JSXExpressionContainer':
      return staticString(node.expression, constants);
    default:
      return null;
  }
}

/**
 * Local names bound to the i18n API in a file: imports of t/tp/T/useT from src/i18n and
 * `const { t, tp } = useT()` destructuring. Files without an i18n import have no bindings.
 */
export function i18nBindings(program) {
  const bindings = { t: new Set(), tp: new Set(), T: new Set(), useT: new Set(), imported: false };
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || !I18N_IMPORT.test(statement.source.value)) {
      continue;
    }
    bindings.imported = true;
    for (const specifier of statement.specifiers) {
      const imported = specifier.imported?.name;
      if (imported && Object.hasOwn(bindings, imported) && imported !== 'imported') {
        bindings[imported].add(specifier.local.name);
      }
    }
  }
  if (!bindings.imported) {
    return bindings;
  }
  walk(program, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'ObjectPattern' &&
      node.init?.type === 'CallExpression' &&
      node.init.callee.type === 'Identifier' &&
      bindings.useT.has(node.init.callee.name)
    ) {
      for (const property of node.id.properties) {
        const name = property.key?.name;
        if ((name === 't' || name === 'tp') && property.value?.type === 'Identifier') {
          bindings[name].add(property.value.name);
        }
      }
    }
  });
  return bindings;
}

export function jsxName(node) {
  if (!node) {
    return '';
  }
  if (node.type === 'JSXIdentifier') {
    return node.name;
  }
  if (node.type === 'JSXNamespacedName') {
    return `${node.namespace.name}:${node.name.name}`;
  }
  if (node.type === 'JSXMemberExpression') {
    return `${jsxName(node.object)}.${node.property.name}`;
  }
  return '';
}

export function jsxAttribute(opening, name) {
  return opening.attributes.find(
    (attribute) => attribute.type === 'JSXAttribute' && jsxName(attribute.name) === name,
  );
}

/** Lists src/**\/*.js(x) files, skipping locale catalogs; paths are repository-relative. */
export function listSourceFiles(root = sourceRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'locales' && !entry.name.startsWith('.')) {
          visit(full);
        }
      } else if (/\.(js|jsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function relativePath(file) {
  return path.relative(repositoryRoot, file).split(path.sep).join('/');
}
