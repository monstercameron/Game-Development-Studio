// Writer process for test/app-log.test.js. Usage: node log-writer.mjs <rows> [crash]
// Writes <rows> distinct records through runtime/app-log.js into FORGE_RUNTIME_DIR/log-spool,
// then exits normally, or throws an uncaught error when the second argument is "crash".
import { configureAppLog, createLogger } from '../../runtime/app-log.js';

const rows = Number(process.argv[2] || 0);
const shouldCrash = process.argv[3] === 'crash';
configureAppLog({ processName: shouldCrash ? 'crash-writer' : 'test-writer' });
const log = createLogger('queue');
for (let index = 0; index < rows; index += 1) {
  log.info('job.state.changed', { jobId: `job-${index}`, from: 'queued', to: 'running', index });
}
if (shouldCrash) {
  // Thrown from a timer: a top-level throw in an ES module is reported as a rejection instead.
  setTimeout(() => {
    throw new Error('writer crashed on purpose');
  }, 0);
}
