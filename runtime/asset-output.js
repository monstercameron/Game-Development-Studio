import fs from 'node:fs/promises';
import path from 'node:path';
import { findProject, projectsRoot } from './jobs.js';
import { readAssetMetadata } from './project-assets.js';
import { createLogger } from './app-log.js';

const log = createLogger('assets');

// Accepts only plain forward-slash relative paths from project metadata: no drive letters,
// backslashes, empty, dot or hidden segments.
function safeRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  );
}

// True only for a strict descendant of root; the root itself and escapes are rejected.
function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve display locations without changing the queue's durable engine record.
 * Project metadata retains the original output when an asset is renamed.
 *
 * @param {Array<object>} jobs Queue jobs; only completed jobs with an output are resolved.
 * @param {{ root?: string }} [options] Projects root, defaults to projectsRoot.
 * @returns {Promise<Array<object>>} Copies of the jobs. A resolved job gets its alias as `output`
 *   and the durable path as `originalOutput`. Other jobs are returned unchanged.
 */
export async function resolveAssetOutputs(jobs, { root = projectsRoot } = {}) {
  const ids = [
    ...new Set(
      jobs.filter((job) => job.status === 'completed' && job.output).map((job) => job.projectId),
    ),
  ];
  const byProject = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const folder = await fs.realpath(findProject(id, root)),
          metadata = await readAssetMetadata(folder),
          needed = new Set(
            jobs.filter((job) => job.projectId === id && job.output).map((job) => job.output),
          ),
          aliases = new Map();
        for (const [relative, details] of Object.entries(metadata)) {
          if (
            !safeRelative(relative) ||
            !safeRelative(details?.sourceOutput) ||
            !needed.has(details.sourceOutput)
          ) {
            continue;
          }
          const candidate = path.resolve(folder, ...relative.split('/'));
          if (!inside(folder, candidate)) {
            continue;
          }
          try {
            const info = await fs.lstat(candidate);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              !inside(folder, await fs.realpath(candidate))
            ) {
              continue;
            }
          } catch (error) {
            // A deleted or unreadable alias is skipped; the original output stays the fallback.
            log.debug('assets.output.alias.failed', {
              errorClass: error?.name,
              errorCode: error?.code,
              reason: 'skipped_candidate',
            });
            continue;
          }
          // Multiple existing aliases are ambiguous; retain the original path.
          if (aliases.has(details.sourceOutput)) {
            aliases.set(details.sourceOutput, null);
          } else {
            aliases.set(details.sourceOutput, relative);
          }
        }
        byProject.set(id, aliases);
      } catch (error) {
        // A missing or unreadable project keeps the original job output unchanged.
        log.debug('assets.output.project.failed', {
          projectId: id,
          errorClass: error?.name,
          errorCode: error?.code,
          reason: 'keeps_original_output',
        });
      }
    }),
  );
  return jobs.map((job) => {
    const resolved =
      job.status === 'completed' ? byProject.get(job.projectId)?.get(job.output) : null;
    return resolved && resolved !== job.output
      ? { ...job, output: resolved, originalOutput: job.output }
      : job;
  });
}
