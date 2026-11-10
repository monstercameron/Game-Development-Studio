// Windows search paths for the locally built Drama 3 engine. Do not copy the Visual Studio
// debug OpenMP runtime into the repository; find it in its existing installation instead.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
async function visualStudioDirectory(env) {
  if (env.VSINSTALLDIR) {
    return env.VSINSTALLDIR;
  }
  const programFiles = env['ProgramFiles(x86)'];
  if (!programFiles) {
    return null;
  }
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!(await exists(vswhere))) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(
      vswhere,
      ['-latest', '-products', '*', '-property', 'installationPath'],
      { windowsHide: true, timeout: 5000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
/** Build a PATH only for the child, preserving the Studio's own process environment. */
export async function drama3ChildEnvironment(env = process.env) {
  if (process.platform !== 'win32') {
    return { ...env };
  }
  const directories = [];
  for (const entry of (env.FORGE_DRAMA3_DLL_DIRS || '').split(path.delimiter).filter(Boolean)) {
    directories.push(entry);
  }
  if (env.CUDA_PATH) {
    directories.push(path.join(env.CUDA_PATH, 'bin', 'arm64'));
  }
  const studio = await visualStudioDirectory(env);
  if (studio) {
    const root = path.join(studio, 'VC', 'Redist', 'MSVC');
    try {
      const versions = (await fs.readdir(root)).sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
      for (const version of versions) {
        const dir = path.join(
          root,
          version,
          'debug_nonredist',
          'arm64',
          'Microsoft.VC143.OpenMP.LLVM',
        );
        if (await exists(path.join(dir, 'libomp140.aarch64.dll'))) {
          directories.push(dir);
          break;
        }
      }
    } catch {
      /* Build Tools may not include the LLVM OpenMP runtime. */
    }
  }
  return { ...env, PATH: [...directories, env.PATH || env.Path || ''].join(path.delimiter) };
}
