import fs from 'node:fs/promises';
import path from 'node:path';
import { findProject } from './jobs.js';
import { transcribeWav } from './asr-client.js';

// Read only a named WAV inside a project. Resolve links before the boundary
// check so this tool cannot be used to read arbitrary files through a project.
export async function transcribeProjectAudio(
  { projectId, path: relative },
  { baseUrl, projectsRoot, transcribe = transcribeWav } = {},
) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.length > 1000 ||
    relative.includes('\\') ||
    relative
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
    !relative.toLowerCase().endsWith('.wav')
  ) {
    throw Error('Choose a WAV asset in this project.');
  }
  const project = await fs.realpath(findProject(projectId, projectsRoot));
  const requested = path.resolve(project, ...relative.split('/'));
  const stat = await fs.lstat(requested);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 44 || stat.size > 32 * 1024 * 1024) {
    throw Error('The WAV must be a regular file of at most 32 MiB.');
  }
  const real = await fs.realpath(requested),
    rel = path.relative(project, real);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw Error('The WAV must be inside this project.');
  }
  return transcribe(await fs.readFile(real), { baseUrl });
}
