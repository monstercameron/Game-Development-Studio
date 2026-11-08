// Creates a marked test error in a running Forge studio, without the UI. It uses the same
// loopback-only routes as the Diagnostics page (see docs/ERRORS.md, Testing the error pipeline).
//
//   node tools/emit-test-error.mjs --port 5173 --kind server
//   node tools/emit-test-error.mjs --kind python [--variant asgi]
//   node tools/emit-test-error.mjs --kind browser-report
//   node tools/emit-test-error.mjs --kind delete
//
// Every generated error starts with "[Forge test error]". The script only talks to 127.0.0.1.
// It starts no engine and uses no model or GPU.
import { pathToFileURL } from 'node:url';

const MARKER = '[Forge test error]';
const KINDS = ['server', 'python', 'browser-report', 'delete'];
const VARIANTS = ['traceback', 'asgi'];
const USAGE = `Usage: node tools/emit-test-error.mjs [--port 5173] --kind ${KINDS.join('|')} [--variant ${VARIANTS.join('|')}]`;

/** Parses --name value pairs. Returns { options } or { error }. */
export function parseArguments(argv) {
  const options = { port: 5173, kind: '', variant: 'traceback' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--port', '--kind', '--variant'].includes(name) || value === undefined) {
      return { error: `Unknown or incomplete option: ${name}` };
    }
    options[name.slice(2)] = value;
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'The port must be a number from 1 to 65535.' };
  }
  if (!KINDS.includes(options.kind)) {
    return { error: `Choose a kind: ${KINDS.join(', ')}.` };
  }
  if (!VARIANTS.includes(options.variant)) {
    return { error: `Choose a variant: ${VARIANTS.join(', ')}.` };
  }
  return { options: { ...options, port } };
}

function requestFor(options) {
  if (options.kind === 'server') {
    return { route: '/test/server', body: { confirm: 'emit-test-error' } };
  }
  if (options.kind === 'python') {
    return {
      route: '/test/python',
      body: { confirm: 'emit-test-error', variant: options.variant },
    };
  }
  if (options.kind === 'delete') {
    return { route: '/test/delete', body: { confirm: 'delete-test-errors' } };
  }
  // The ingest route the browser uses. The stack is synthetic and clearly marked.
  return {
    route: '/report',
    body: {
      kind: 'error',
      message:
        `Error: ${MARKER} Browser report sent by tools/emit-test-error.mjs ` +
        '(key sk-test-FAKE0123456789abcdef0123456789; contact forge-test-user@example.com)',
      stack:
        `Error: ${MARKER} Browser report sent by tools/emit-test-error.mjs\n` +
        '    at emitFromScript (http://127.0.0.1/src/emit-test-error.js:1:1)',
      page: '/diagnostics',
    },
  };
}

/**
 * @param {string[]} argv Arguments after the script name.
 * @param {{fetchImpl?: typeof fetch, log?: (line: string) => void}} io
 * @returns {Promise<number>} The process exit code: 0 sent, 1 refused or failed, 2 bad arguments.
 */
export async function run(argv, { fetchImpl = fetch, log = console.log } = {}) {
  const parsed = parseArguments(argv);
  if (parsed.error) {
    log(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  const origin = `http://127.0.0.1:${options.port}`;
  const { route, body } = requestFor(options);
  let response;
  try {
    response = await fetchImpl(`${origin}/api/errors${route}`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Forge-Request': 'errors',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    log(`Could not reach the studio at ${origin}: ${error.cause?.code || error.name}.`);
    return 1;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint =
      response.status === 404
        ? ' The studio has not loaded the error routes yet; restart it first.'
        : '';
    log(`The studio answered HTTP ${response.status}: ${data.error || 'no message'}.${hint}`);
    return 1;
  }
  log(`Sent ${options.kind} test error to ${origin}: ${JSON.stringify(data)}`);
  log('Open the Errors button in the studio (or /?dialog=errors) to review it.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
