import { inspectWindowsProcess } from './engine-ownership.js';
import { forceStopWindows } from './force-stop.js';
import { inspectService } from './catalog.js';

// The service must still answer its expected health endpoint and own the
// loopback listener. Recheck the PID and creation time before terminating it.
/**
 * Closes a locally running external model service after verifying its identity.
 *
 * @param {{ host?: string, port: number }} service Loopback endpoint of the service. Only
 *   127.0.0.1, localhost or an omitted host is accepted.
 * @param {object} [options]
 * @param {boolean} [options.force=false] Allow closing a busy or unverifiable service, which
 *   may interrupt active work.
 * @returns {Promise<object>} The result of `stop`, plus a user-facing `message`.
 * @throws {Error} When the endpoint is unsupported, the service cannot be identified, the
 *   listener is not uniquely owned by one process, or the service changes during the check.
 */
export async function stopExternalModel(
  service,
  {
    force = false,
    inspect = inspectService,
    processInfo = inspectWindowsProcess,
    stop = forceStopWindows,
    ownPid = process.pid,
  } = {},
) {
  if (
    !service ||
    !Number.isInteger(service.port) ||
    !['127.0.0.1', 'localhost', undefined].includes(service.host)
  ) {
    throw Error('This service does not have a supported local endpoint.');
  }
  const health = await inspect(service);
  if (health.status !== 'reachable') {
    throw Error('The service could not be identified. Check its status and retry.');
  }
  if (!force && health.busy !== false) {
    throw Error(
      'The service is busy or its activity cannot be verified. Wait for it to finish, or use Force close.',
    );
  }
  const scan = await processInfo(ownPid, service.port);
  if (scan.listeners.length !== 1) {
    throw Error('The service listener could not be uniquely identified.');
  }
  const match = /^127\.0\.0\.1:(\d+)$/.exec(scan.listeners[0]);
  const pid = Number(match?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === ownPid || pid === process.ppid) {
    throw Error('The service process could not be identified safely.');
  }
  const identity = await processInfo(pid, service.port);
  if (identity.listeners.length !== 1 || identity.listeners[0] !== `127.0.0.1:${pid}`) {
    throw Error('The service listener changed. Retry.');
  }
  const again = await inspect(service);
  if (again.status !== 'reachable' || (!force && again.busy !== false)) {
    throw Error('The service changed or started work. Retry or use Force close.');
  }
  const result = await stop({
    pid,
    creationTicks: identity.creationTicks,
    executable: identity.executable,
  });
  return {
    ...result,
    message: force
      ? 'Service process closed. Active work may have been interrupted.'
      : 'Idle service closed. Memory may take a moment to become available.',
  };
}
