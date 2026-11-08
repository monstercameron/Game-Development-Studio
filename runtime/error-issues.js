// GitHub issues for verified fixes, created through the user's own `gh` CLI session.
// Every command is spawned with an argument array (never a shell string). Forge does not read,
// store or pass GitHub tokens; `gh` uses its own login. Issue bodies go through a private temp
// file that is deleted after the command finishes.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    } catch {
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
      throw new GitHubError(
        'gh_missing',
        'GitHub CLI (gh) was not found. Install it from https://cli.github.com and run gh auth login in a terminal.',
      );
    }
    if (result.timedOut) {
      throw new GitHubError('gh_timeout', 'The GitHub CLI did not finish in time. Try again.');
    }
    return result;
  }

  async function withBodyFile(body, action) {
    const directory = await fs.mkdtemp(path.join(tempRoot, 'forge-issue-'));
    try {
      const file = path.join(directory, 'body.md');
      await fs.writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
      return await action(file);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  function failure(result, what) {
    // gh's stderr can include the account name; only a short, generic reason is returned.
    const text = String(result.stderr || '');
    if (/auth|login|token/i.test(text)) {
      return new GitHubError(
        'gh_unauthenticated',
        'GitHub CLI is not signed in. Run gh auth login in a terminal.',
      );
    }
    if (/could not resolve to a repository|not found/i.test(text)) {
      return new GitHubError(
        'gh_repo',
        `GitHub could not find the repository while trying to ${what}.`,
      );
    }
    return new GitHubError(
      'gh_failed',
      `GitHub CLI could not ${what} (exit ${result.code ?? 'unknown'}).`,
    );
  }

  return {
    /** The origin remote of the Forge checkout, refused unless it is on github.com. */
    async repository() {
      const result = await run(git, ['remote', 'get-url', 'origin']);
      if (result.missing) {
        throw new GitHubError('git_missing', 'Git was not found, so the repository is unknown.');
      }
      const repo = result.code === 0 ? parseGitHubRemote(result.stdout) : null;
      if (!repo) {
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
        throw new GitHubError(
          'gh_unauthenticated',
          'GitHub CLI is not signed in. Run gh auth login in a terminal.',
        );
      }
      return { authenticated: true };
    },
    async findDuplicates(repo, fingerprint) {
      if (!/^[a-f0-9]{8,64}$/.test(fingerprint)) {
        return [];
      }
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
        throw failure(result, 'search existing issues');
      }
      try {
        const issues = JSON.parse(result.stdout || '[]');
        return (Array.isArray(issues) ? issues : [])
          .filter((issue) => Number.isSafeInteger(issue?.number) && typeof issue.url === 'string')
          .map((issue) => ({
            number: issue.number,
            title: String(issue.title || '').slice(0, 200),
            url: issue.url.slice(0, 300),
            state: String(issue.state || '').slice(0, 20),
          }));
      } catch {
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
        return false;
      }
      try {
        const labels = JSON.parse(result.stdout || '[]');
        return Array.isArray(labels) && labels.some((item) => item?.name === label);
      } catch {
        return false;
      }
    },
    async createIssue(repo, { title, body, labels }) {
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
          throw failure(result, 'create the issue');
        }
        return issueReference(result.stdout);
      });
    },
    async commentOnIssue(repo, number, body) {
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
          throw failure(result, `comment on issue #${number}`);
        }
        const reference = issueReference(result.stdout);
        return { url: reference.url, number };
      });
    },
  };
}

function issueReference(stdout) {
  const url = /https:\/\/github\.com\/[^\s]+\/(?:issues|pull)\/(\d+)(?:#[^\s]*)?/.exec(
    String(stdout),
  );
  if (!url) {
    throw new GitHubError('gh_output', 'GitHub CLI finished but did not print an issue link.');
  }
  return { url: url[0], number: Number(url[1]) };
}
