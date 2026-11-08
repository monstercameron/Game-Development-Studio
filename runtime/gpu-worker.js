import { parentPort } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { createLogger } from './app-log.js';

const log = createLogger('gpu');

/**
 * Parses `nvidia-smi --format=csv,noheader,nounits` output for five fields per GPU:
 * index, name, total, used and free memory. Memory values are MiB. A memory field that is
 * not a plain integer (for example `[N/A]`) becomes null. Malformed rows are skipped.
 *
 * @param {string} output Raw stdout from nvidia-smi.
 * @returns {Array<{index: number, name: string, totalMiB: number|null, usedMiB: number|null,
 *   freeMiB: number|null}>}
 */
export function parseNvidiaCsv(output) {
  return output
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => {
      const parts = line.split(',').map((value) => value.trim());
      if (parts.length !== 5 || !/^\d+$/.test(parts[0])) {
        return [];
      }
      const memoryMiB = parts.slice(2).map((field) => (/^\d+$/.test(field) ? Number(field) : null));
      return [
        {
          index: Number(parts[0]),
          name: parts[1],
          totalMiB: memoryMiB[0],
          usedMiB: memoryMiB[1],
          freeMiB: memoryMiB[2],
        },
      ];
    });
}

// Tests import parseNvidiaCsv without a worker thread, so queries run only under a parent port.
if (parentPort) {
  parentPort.on('message', ({ id }) => {
    const stopQuery = log.time('gpu.query.finished', { kind: 'nvidia-smi' });
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=index,name,memory.total,memory.used,memory.free',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024 },
      (error, stdout) => {
        if (error) {
          stopQuery({ outcome: 'failed', errorCode: error.code });
          return parentPort.postMessage({
            id,
            result: {
              available: false,
              devices: [],
              error: 'NVIDIA memory information is unavailable.',
            },
          });
        }
        const devices = parseNvidiaCsv(stdout);
        stopQuery({ outcome: 'completed', count: devices.length });
        parentPort.postMessage({
          id,
          result: {
            available: devices.some((device) => device.freeMiB !== null),
            devices,
            measuredAt: new Date().toISOString(),
            note: 'Reported GPU memory is a snapshot, not a reservation. Windows shared memory and other processes can affect availability.',
          },
        });
      },
    );
  });
}
