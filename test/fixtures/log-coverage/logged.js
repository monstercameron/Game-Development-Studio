import { spawn } from 'node:child_process';
import { createLogger } from '../../../runtime/app-log.js';

const log = createLogger('queue');

export async function run(job) {
  try {
    await fetch('https://example.invalid/model');
  } catch (error) {
    log.warn('model.download.failed', { error });
  }
  log.info('job.state.changed', { jobId: job.id, to: 'running' });
  job.status = 'running';
  const child = spawn('worker.exe', []);
  return child;
}

export function build() {
  const result = {};
  // log-coverage: ignore -- builds a response object, not a state change
  result.status = 'ok';
  try {
    JSON.parse('{');
  } catch {
    // log-coverage: ignore -- probing input; failure is the expected answer
  }
  return result;
}

function handleMessage(message) {
  if (message === 'stop') {
    log.info('worker.process.stopping', {});
  }
}

process.on('message', handleMessage);
process.on('disconnect', () => {
  log.info('worker.process.disconnected', {});
});
