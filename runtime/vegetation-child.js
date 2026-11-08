// Isolated child process for SeedThree. The studio never imports three.js or grows a plant
// itself: vegetation-runner.js starts this file with a heap cap, feeds it one JSON command on
// stdin and enforces a timeout. The final stdout line is one JSON object, {ok: true, ...} or
// {ok: false, error}. A crash or a hang here therefore cannot take the studio down.
//
// Commands: {mode: 'schema' | 'measure', directory, commit}
//           {mode: 'generate', directory, commit, request, glbFile, presetFile}
// The output files are written exactly where the host says (it chose staging names).
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  buildSchema,
  generateVegetation,
  loadSeedThree,
  measureBudgets,
  readSeedThreeVersion,
} from './vegetation-adapter.js';

// Plant generation is synchronous, so a timer on the main thread could never fire while it runs.
// This watchdog thread ends the process when its parent has gone (a killed queue worker does not
// stop its children on Windows) or when the host's own deadline has passed.
function startWatchdog() {
  const deadlineMs = Number(process.env.FORGE_VEGETATION_DEADLINE_MS) || 180000;
  const source = `
    const { workerData } = require('node:worker_threads');
    const started = Date.now();
    setInterval(() => {
      let parentAlive = true;
      try {
        process.kill(workerData.parentPid, 0);
      } catch {
        parentAlive = false;
      }
      if (!parentAlive || Date.now() - started > workerData.deadlineMs) {
        process.kill(process.pid, 'SIGKILL');
      }
    }, 1000);
  `;
  // log-coverage: ignore -- this child logs nothing: a second log writer would live in a spawned process; the host logs vegetation.process.exited
  const watchdog = new Worker(source, {
    eval: true,
    workerData: { parentPid: process.ppid, deadlineMs },
  });
  watchdog.unref();
}

async function readCommand() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1_000_000) {
      throw Error('The command is too large.');
    }
  }
  return JSON.parse(text);
}

function reply(value) {
  process.stdout.write(`\n${JSON.stringify(value)}\n`);
}

async function main() {
  startWatchdog();
  const command = await readCommand();
  if (typeof command.directory !== 'string' || !command.directory) {
    throw Error('A SeedThree directory is required.');
  }
  const api = await loadSeedThree(command.directory);
  const schema = buildSchema(api, {
    version: readSeedThreeVersion(command.directory),
    commit: typeof command.commit === 'string' ? command.commit : null,
  });
  if (command.mode === 'schema') {
    reply({ ok: true, schema });
    return;
  }
  if (command.mode === 'measure') {
    reply({ ok: true, measured: measureBudgets(api, schema) });
    return;
  }
  if (command.mode !== 'generate') {
    throw Error('Unknown command.');
  }
  if (typeof command.glbFile !== 'string' || typeof command.presetFile !== 'string') {
    throw Error('Output files are required.');
  }
  const { glb, preset, result } = await generateVegetation(api, schema, command.request);
  // log-coverage: ignore -- staged output write; a failure is returned in the reply and logged by the host
  fs.writeFileSync(command.glbFile, glb, { flag: 'wx' });
  // log-coverage: ignore -- staged output write; a failure is returned in the reply and logged by the host
  fs.writeFileSync(command.presetFile, `${JSON.stringify(preset, null, 2)}\n`, { flag: 'wx' });
  const usage = process.resourceUsage();
  reply({
    ok: true,
    result: {
      ...result,
      peakRssMiB: Math.round(usage.maxRSS / 1024),
      seedthreeVersion: schema.seedthree.version,
    },
  });
}

// The exit code is set instead of calling process.exit() so a piped stdout is flushed first.
main().catch((error) => {
  reply({ ok: false, error: String(error?.message || error).slice(0, 600) });
  process.exitCode = 1;
});
