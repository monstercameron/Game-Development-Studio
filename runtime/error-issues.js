// GitHub issues for verified fixes, created through the user's own `gh` CLI session.
// Every command is spawned with an argument array (never a shell string). Forge does not read,
// store or pass GitHub tokens; `gh` uses its own login. Issue bodies go through a private temp
// file that is deleted after the command finishes.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from './app-log.js';

const log = createLogger('errors');
const OUTPUT_LIMIT = 1024 * 1024;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export class GitHubError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parses owner/name from a github.com remote URL. Returns null for any other host.
 * Credentials embedded in an https remote are ignored and never returned.
 */
export function parseGitHubRemote(remote) {
  const text = String(remote || '').trim();
  let match = /^(?:git@|ssh:\/\/git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    text,
  );
  if (!match) {
    try {
      const url = new URL(text);
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
        return null;
      }
      match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
    } catch (error) {
      // Non-URL remotes are expected input; the remote text itself is never logged.
      log.debug('errors.remote.parse.failed', { errorClass: error?.name });
      return null;
    }
  }
  if (!match || !NAME.test(match[1]) || !NAME.test(match[2])) {
    return null;
  }
  return { owner: match[1], name: match[2], slug: `${match[1]}/${match[2]}` };
}

/**
 * @param {{repoRoot: string, spawnImpl?: Function, gh?: string[], git?: string[],
 *   tempRoot?: string, timeoutMs?: number}} options gh and git are the command plus any fixed
 *   leading arguments, so tests can point them at a fake executable.
 */
export function createGitHubClient({
  repoRoot,
  spawnImpl = spawn,
  gh = ['gh'],
  git = ['git'],
  tempRoot = os.tmpdir(),
  timeoutMs = 30000,
} = {}) {
  function run(command, args) {
    const [executable, ...prefix] = command;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(executable, [...prefix, ...args], {
          cwd: repoRoot,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // gh must not open a pager or prompt; it uses its own stored login.
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: '', NO_COLOR: '1' },
        });
      } catch (error) {
        log.debug('errors.process.spawn.failed', { errorCode: error.code ?? 'unknown' });
        resolve({ code: null, missing: error.code === 'ENOENT', stdout: '', stderr: '' });
        return;
      }
      let stdout = '',
        stderr = '',
        settled = false;
      const finish = (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ code: null, timedOut: true, stdout, stderr });
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(0, OUTPUT_LIMIT);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(0, OUTPUT_LIMIT);
      });
      child.on('error', (error) =>
        finish({ code: null, missing: error.code === 'ENOENT', stdout, stderr }),
      );
      child.on('close', (code) => finish({ code, stdout, stderr }));
    });
  }

  async function runGh(args) {
    const result = await run(gh, args);
    if (result.missing) {
      log.warn('errors.github.cli.missing');
      throw new GitHubError(
        'gh_missing',
        'GitHub CLI (gh) was not found. Install it from https://cli.github.com and run gh auth login in a terminal.',
      );
    }
    if (result.timedOut) {
      log.warn('errors.github.command.timeout', { timeoutMs });
      throw new GitHubError('gh_timeout', 'The GitHub CLI did not finish in time. Try again.');
    }
    return result;
  }

  async function withBodyFile(body, action) {
    const directory = await fs.mkdtemp(path.join(tempRoot, 'forge-issue-'));
    try {
      const file = path.join(directory, 'body.md');
      await fs.writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
      log.debug('errors.issue.body.written', { kind: 'issue_body', bytes: textByteLength(body) });
      return await action(file);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      log.debug('errors.issue.body.removed', { kind: 'issue_body' });
    }
  }

  // `operation` and `startedMs` only feed the log record; the returned error is unchanged.
  function failure(result, what, operation, startedMs) {
    // gh's stderr can include the account name; only a short, generic reason is returned.
    const text = String(result.stderr || '');
    let error;
    if (/auth|login|token/i.test(text)) {
      error = new GitHubError(
        'gh_unauthenticated',
        'GitHub CLI is not signed in. Run gh auth login in a terminal.',
      );
    } else if (/could not resolve to a repository|not found/i.test(text)) {
      error = new GitHubError(
        'gh_repo',
        `GitHub could not find the repository while trying to ${what}.`,
      );
    } else {
      error = new GitHubError(
        'gh_failed',
        `GitHub CLI could not ${what} (exit ${result.code ?? 'unknown'}).`,
      );
    }
    log.error('errors.github.command.failed', {
      operation,
      errorCode: error.code,
      exitCode: result.code,
      durationMs: Math.round(performance.now() - startedMs),
    });
    return error;
  }

  return {
    /** The origin remote of the Forge checkout, refused unless it is on github.com. */
    async repository() {
      const result = await run(git, ['remote', 'get-url', 'origin']);
      if (result.missing) {
        log.warn('errors.issue.repository.rejected', { reason: 'git_missing' });
        throw new GitHubError('git_missing', 'Git was not found, so the repository is unknown.');
      }
      const repo = result.code === 0 ? parseGitHubRemote(result.stdout) : null;
      if (!repo) {
        log.warn('errors.issue.repository.rejected', { reason: 'not_github' });
        throw new GitHubError(
          'not_github',
          'The Forge checkout has no github.com origin remote, so issues cannot be created.',
        );
      }
      return repo;
    },
    async authStatus() {
      const result = await runGh(['auth', 'status', '--hostname', 'github.com']);
      if (result.code !== 0) {
        log.warn('errors.github.auth.missing', { exitCode: result.code });
        throw new GitHubError(
          'gh_unauthenticated',
          'GitHub CLI is not signed in. Run gh auth login in a terminal.',
        );
      }
      return { authenticated: true };
    },
    async findDuplicates(repo, fingerprint) {
      if (!/^[a-f0-9]{8,64}$/.test(fingerprint)) {
        log.warn('errors.issue.duplicate.rejected', { reason: 'invalid_fingerprint' });
        return [];
      }
      const startedMs = performance.now();
      const result = await runGh([
        'issue',
        'list',
        '--repo',
        repo.slug,
        '--search',
        `${fingerprint} in:body`,
        '--state',
        'all',
        '--json',
        'number,title,url,state',
        '--limit',
        '10',
      ]);
      if (result.code !== 0) {
        throw failure(result, 'search existing issues', 'search', startedMs);
      }
      try {
        const issues = JSON.parse(result.stdout || '[]');
        const duplicates = (Array.isArray(issues) ? issues : [])
          .filter((issue) => Number.isSafeInteger(issue?.number) && typeof issue.url === 'string')
          .map((issue) => ({
            number: issue.number,
            title: String(issue.title || '').slice(0, 200),
            url: issue.url.slice(0, 300),
            state: String(issue.state || '').slice(0, 20),
          }));
        if (duplicates.length > 0) {
          log.info('errors.issue.duplicate.detected', { count: duplicates.length });
        }
        return duplicates;
      } catch (error) {
        log.warn('errors.issue.search.parse.failed', { errorClass: error?.name });
        return [];
      }
    },
    async hasLabel(repo, label) {
      const result = await runGh([
        'label',
        'list',
        '--repo',
        repo.slug,
        '--search',
        label,
        '--json',
        'name',
        '--limit',
        '100',
      ]);
      if (result.code !== 0) {
        log.debug('errors.label.check.failed', { exitCode: result.code });
        return false;
      }
      try {
        const labels = JSON.parse(result.stdout || '[]');
        return Array.isArray(labels) && labels.some((item) => item?.name === label);
      } catch (error) {
        log.debug('errors.label.parse.failed', { errorClass: error?.name });
        return false;
      }
    },
    /**
     * Creates an issue and resolves to `{ url, number }` parsed from the link `gh` prints.
     * Throws GitHubError on any failure; this function never retries, because the caller must
     * decide whether a second submission is safe.
     */
    async createIssue(repo, { title, body, labels }) {
      const startedMs = performance.now();
      log.info('errors.issue.create.requested', {
        labelCount: Array.isArray(labels) ? labels.length : 0,
        bodyBytes: textByteLength(body),
      });
      return withBodyFile(body, async (file) => {
        const args = [
          'issue',
          'create',
          '--repo',
          repo.slug,
          '--title',
          title,
          '--body-file',
          file,
        ];
        for (const label of labels) {
          args.push('--label', label);
        }
        const result = await runGh(args);
        if (result.code !== 0) {
          throw failure(result, 'create the issue', 'create', startedMs);
        }
        const reference = issueReference(result.stdout);
        log.info('errors.issue.create.completed', {
          durationMs: Math.round(performance.now() - startedMs),
        });
        return reference;
      });
    },
    async commentOnIssue(repo, number, body) {
      const startedMs = performance.now();
      log.info('errors.issue.comment.requested', { bodyBytes: textByteLength(body) });
      return withBodyFile(body, async (file) => {
        const result = await runGh([
          'issue',
          'comment',
          String(number),
          '--repo',
          repo.slug,
          '--body-file',
          file,
        ]);
        if (result.code !== 0) {
          throw failure(result, `comment on issue #${number}`, 'comment', startedMs);
        }
        const reference = issueReference(result.stdout);
        log.info('errors.issue.comment.completed', {
          durationMs: Math.round(performance.now() - startedMs),
        });
        return { url: reference.url, number };
      });
    },
  };
}

// Logging helper only: never throws, so a log line cannot change the error a caller sees.
function textByteLength(text) {
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}

function issueReference(stdout) {
  const url = /https:\/\/github\.com\/[^\s]+\/(?:issues|pull)\/(\d+)(?:#[^\s]*)?/.exec(
    String(stdout),
  );
  if (!url) {
    log.error('errors.github.output.invalid', { errorCode: 'gh_output' });
    throw new GitHubError('gh_output', 'GitHub CLI finished but did not print an issue link.');
  }
  return { url: url[0], number: Number(url[1]) };
}
