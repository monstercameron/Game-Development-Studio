// The one place that turns an nvidia-smi device record into the "available GPU memory" number
// every admission check uses (see planModelLoad in model-load.js).
//
// A reading is a snapshot, not a reservation, and not proof that a model is loaded. The unified
// memory of this machine makes `memory.free` move when an engine caches or releases memory, so a
// reading that is old, negative or inconsistent must not be used to admit or to delay a render.

// Admission always takes a fresh forced reading; a snapshot older than this is not trusted.
export const GPU_READING_MAX_AGE_MS = 30 * 1000;

const isMiB = (value) => Number.isFinite(value) && value >= 0;

/**
 * Reads the available memory of one GPU from a snapshot entry.
 *
 * Free memory comes from `freeMiB`; when the tool reports it as unavailable but total and used
 * are known, it is derived as total minus used. A value above the total is capped at the total
 * and a negative value is rejected, so the result is never negative. A snapshot with no
 * timestamp is accepted (its age is unknown); one older than `maxAgeMs` is rejected as stale.
 *
 * @param {{ freeMiB?: number|null, totalMiB?: number|null, usedMiB?: number|null }} device
 * @param {{ measuredAt?: string|number|Date|null, now?: number, maxAgeMs?: number }} [options]
 *   `measuredAt` is when the snapshot was taken; `now` is epoch ms.
 * @returns {{ ok: true, freeMiB: number, totalMiB: number|null, measuredAt: string|null,
 *   ageMs: number|null, isDerived: boolean }
 *   | { ok: false, reason: 'missing'|'stale', ageMs: number|null, message: string }}
 */
export function readGpuMemory(
  device,
  { measuredAt = null, now = Date.now(), maxAgeMs = GPU_READING_MAX_AGE_MS } = {},
) {
  const measuredMs = measuredAt === null ? Number.NaN : new Date(measuredAt).getTime();
  const ageMs = Number.isFinite(measuredMs) ? Math.max(0, now - measuredMs) : null;
  if (ageMs !== null && ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: 'stale',
      ageMs,
      message: `The GPU memory reading is ${Math.round(ageMs / 1000)} seconds old and was not used. The model was not loaded.`,
    };
  }
  const totalMiB = isMiB(device?.totalMiB) ? device.totalMiB : null;
  const usedMiB = isMiB(device?.usedMiB) ? device.usedMiB : null;
  let freeMiB = isMiB(device?.freeMiB) ? device.freeMiB : null;
  let isDerived = false;
  if (freeMiB === null && totalMiB !== null && usedMiB !== null) {
    freeMiB = Math.max(0, totalMiB - usedMiB);
    isDerived = true;
  }
  if (freeMiB === null) {
    return {
      ok: false,
      reason: 'missing',
      ageMs,
      message: 'The inference GPU memory could not be verified. The model was not loaded.',
    };
  }
  return {
    ok: true,
    freeMiB: totalMiB === null ? freeMiB : Math.min(freeMiB, totalMiB),
    totalMiB,
    measuredAt: ageMs === null ? null : new Date(measuredMs).toISOString(),
    ageMs,
    isDerived,
  };
}
