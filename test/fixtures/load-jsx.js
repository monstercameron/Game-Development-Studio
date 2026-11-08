// Loads a React component from src/ for jsdom tests without a bundler.
//
// JSX files are compiled with Vite's esbuild into a temporary folder inside test/ (so bare imports
// still resolve from node_modules). Local `.js` imports are loaded from the source tree, local
// `.jsx` imports are compiled recursively, and CSS imports are dropped.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourceRoot = path.join(repositoryRoot, 'src');

async function exists(file) {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

async function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`]) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
}

/**
 * @param {string} entry File name inside src/, for example 'Megascans.jsx'.
 * @returns {Promise<{ module: object, cleanup: () => Promise<void> }>}
 */
export async function loadJsx(entry) {
  const output = await mkdtemp(path.join(repositoryRoot, 'test', '.jsx-'));
  const compiled = new Map();
  async function compile(file) {
    if (compiled.has(file)) {
      return compiled.get(file);
    }
    const target = path.join(output, `${path.basename(file, '.jsx')}.mjs`);
    const url = pathToFileURL(target).href;
    compiled.set(file, url);
    const source = await readFile(file, 'utf8');
    const imports = [...source.matchAll(/^(import\s[^;]*?from\s+|import\s+)'(\.[^']+)';?$/gm)];
    let rewritten = source;
    for (const match of imports) {
      const specifier = match[2];
      if (specifier.endsWith('.css')) {
        rewritten = rewritten.replace(match[0], '');
        continue;
      }
      const resolved = await resolveLocal(file, specifier);
      const replacement = resolved.endsWith('.jsx')
        ? await compile(resolved)
        : pathToFileURL(resolved).href;
      rewritten = rewritten.replace(
        match[0],
        match[0].replace(`'${specifier}'`, `'${replacement}'`),
      );
    }
    const { code } = await transformWithEsbuild(rewritten, file, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    await writeFile(target, code, 'utf8');
    return url;
  }
  const url = await compile(path.join(sourceRoot, entry));
  return {
    module: await import(url),
    cleanup: () => rm(output, { recursive: true, force: true }),
  };
}
