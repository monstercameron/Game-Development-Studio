// What a render that waits for memory records about its wait, so a person (and the UI) can see
// why it waits, how long, when it looks again and what the queue already tried.
//
// The queue stores this record as `details.memoryWait` of a waiting_memory job. The numbers are
// the admission check's: a budget estimate and a one-time reading, not a reservation or proof
// of what is loaded. Pure module: no `node:` imports.

// A render that has waited this long for memory ends as failed with the reason, so the queue
// behind it moves on and a person decides (free memory, then retry). Tests inject another value.
export const MEMORY_WAIT_LIMIT_MS = 30 * 60 * 1000;

const BYTES_PER_MIB = 1024 * 1024;
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const gib = (mib) => (Number.isFinite(mib) ? `${(mib / 1024).toFixed(1)} GiB` : 'unknown');

// Required, available and shortfall in MiB for a GPU or a system memory conflict.
function conflictMiB(details) {
  if (details?.code === 'insufficient_host_memory') {
    const toMiB = (bytes) => (Number.isFinite(bytes) ? Math.ceil(bytes / BYTES_PER_MIB) : null);
    return {
      kind: 'system',
      requiredMiB: toMiB(details.requiredBytes),
      availableMiB: toMiB(details.freeBytes),
      shortfallMiB: toMiB(details.shortfallBytes),
      totalMiB: null,
    };
  }
  return {
    kind: 'gpu',
    requiredMiB: finiteOrNull(details?.requiredMiB),
    availableMiB: finiteOrNull(details?.device?.freeMiB),
    shortfallMiB: finiteOrNull(details?.shortfallMiB),
    totalMiB: finiteOrNull(details?.device?.totalMiB),
  };
}

/**
 * Builds the wait record for one more check of a waiting_memory render.
 *
 * @param {object} input
 * @param {object} input.details The preparer's waiting_memory details (code, requiredMiB, device,
 *   reading, estimate, basis).
 * @param {object|null} input.previous The record of the earlier check of this wait, or null.
 * @param {number} input.now Epoch ms of this check.
 * @param {number|null} input.intervalMs Wait until the next automatic check; null when the queue
 *   does not check on its own.
 * @param {number} input.limitMs How long the wait may last.
 * @returns {{ record: object, isExpired: boolean }} The record (all times are ISO strings;
 *   memory in MiB, never negative) and whether the wait has reached its limit.
 */
export function nextMemoryWait({ details, previous, now, intervalMs, limitMs }) {
  const memory = conflictMiB(details);
  const sinceMs = Number.isFinite(Date.parse(previous?.since)) ? Date.parse(previous.since) : now;
  const isExpired = now - sinceMs >= limitMs;
  const record = {
    reason: details?.code ?? 'memory_unavailable',
    memory: memory.kind,
    requiredMiB: memory.requiredMiB,
    availableMiB: memory.availableMiB === null ? null : Math.max(0, memory.availableMiB),
    shortfallMiB: memory.shortfallMiB === null ? null : Math.max(0, memory.shortfallMiB),
    totalMiB: memory.totalMiB,
    // Whether the required number counts only working memory (the model is resident) or the
    // model too; null when the preparer does not say.
    basis: details?.basis ?? null,
    // Every budget in the studio is a conservative estimate until a measured peak is recorded.
    estimate: details?.calibrated === true ? 'calibrated' : 'conservative_estimate',
    estimateNote: details?.estimate ?? null,
    readingAt: details?.reading?.measuredAt ?? null,
    readingAgeMs: finiteOrNull(details?.reading?.ageMs),
    since: new Date(sinceMs).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    nextCheckAt: intervalMs === null || isExpired ? null : new Date(now + intervalMs).toISOString(),
    expiresAt: new Date(sinceMs + limitMs).toISOString(),
    checks: (finiteOrNull(previous?.checks) ?? 0) + 1,
    lastAction: previous?.lastAction ?? null,
  };
  return { record, isExpired };
}

/**
 * The error text of a render whose wait reached its limit.
 *
 * @param {object} record A record from nextMemoryWait.
 * @returns {string} Plain text with the numbers and what to do next.
 */
export function expiredMemoryWaitMessage(record) {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(record.lastCheckedAt) - Date.parse(record.since)) / 60000),
  );
  const estimate =
    record.estimate === 'calibrated' ? 'a calibrated budget' : 'a conservative estimate';
  return `Gave up after waiting ${minutes} min for ${record.memory} memory: ${gib(record.requiredMiB)} needed (${estimate}), ${gib(record.availableMiB)} available at the last check. Free memory or close a service in Models and services, then retry.`;
}
