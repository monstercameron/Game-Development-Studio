import { parentPort } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { createLogger } from './app-log.js';

const log = createLogger('gpu');

export function parseNvidiaCsv(output) {
  return output
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => {
      const parts = line.split(',').map((value) => value.trim());
      if (parts.length !== 5 || !/^\d+$/.test(parts[0])) {
        return [];
      }
      const values = parts.slice(2).map((v) => (/^\d+$/.test(v) ? Number(v) : null));
      return [
        {
          index: Number(parts[0]),
          name: parts[1],
          totalMiB: values[0],
          usedMiB: values[1],
          freeMiB: values[2],
        },
      ];
    });
}

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
            available: devices.some((d) => d.freeMiB !== null),
            devices,
            measuredAt: new Date().toISOString(),
            note: 'Reported GPU memory is a snapshot, not a reservation. Windows shared memory and other processes can affect availability.',
          },
        });
      },
    );
  });
}
