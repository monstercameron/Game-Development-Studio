import { createLogger } from './app-log.js';

const log = createLogger('memory');

// Only engines with an atomic, authenticated idle-and-stop guard are eligible.
// Companion audio apps lack that guard; a check followed by killing them could
// interrupt a request that arrived between those two operations.
const guarded = new Set([
  'images',
  'tts',
  '3d-hunyuan',
  '3d-trellis',
  'segmentation',
  'motion-hy',
  'motion-bricks',
]);

/**
 * Builds the function that frees GPU memory by stopping one idle, Forge-owned engine.
 *
 * `services()` returns the current engine states. `offload(id)` must resolve with
 * `{ stopped: true }` only after the engine confirmed it stopped. `now` (epoch ms) and
 * `cooldownMs` (ms) are injected so tests control the retry cooldown after a failed stop.
 * `canRestart(id)` says whether the studio starts that engine again by itself; the engine a
 * waiting render targets is released only when it does (see `allowTarget` below).
 *
 * The returned `makeRoom` resolves to `stopped` (with `service`), `unavailable` (no eligible
 * idle engine), `cancelled` (the job is no longer current, or `announce` refused) or `failed`
 * (the stop did not confirm; that engine is skipped until the cooldown ends).
 *
 * The engine the render itself targets is normally never stopped. With `allowTarget` (the
 * admission check found its idle resident model is what holds the memory) it becomes the last
 * choice, after every other idle engine, and only when `canRestart(target)` is true, so the stop
 * cannot leave the render waiting for an engine that nothing starts again.
 */
export function createAutoMemoryManager({
  services,
  offload,
  canRestart = () => false,
  now = Date.now,
  cooldownMs = 60000,
}) {
  // Engine id -> epoch ms before which a failed stop is not retried.
  const failures = new Map();
  // `only` limits the choice to one engine: a chained render frees the model it just finished with.
  return async function makeRoom({
    target,
    only = null,
    allowTarget = false,
    upcoming = [],
    isCurrent,
    announce,
    reserve,
    release,
  }) {
    const states = await services();
    if (!isCurrent()) {
      return { status: 'cancelled' };
    }
    const choices = states.filter(
      (item) =>
        guarded.has(item.id) &&
        (item.id !== target || (allowTarget && canRestart(target))) &&
        (only === null || item.id === only) &&
        item.status === 'reachable' &&
        item.managed === true &&
        item.canUnload === true &&
        item.busy === false &&
        item.modelLoaded === true &&
        (failures.get(item.id) || 0) <= now(),
    );
    // Keep models that the next jobs will need; try an otherwise unused model first.
    choices.sort((a, b) => {
      if ((a.id === target) !== (b.id === target)) {
        return a.id === target ? 1 : -1;
      }
      const aUpcomingIndex = upcoming.indexOf(a.id);
      const bUpcomingIndex = upcoming.indexOf(b.id);
      return (
        (bUpcomingIndex < 0 ? Infinity : bUpcomingIndex) -
        (aUpcomingIndex < 0 ? Infinity : aUpcomingIndex)
      );
    });
    if (!choices.length) {
      log.debug('memory.room.unavailable', { target, reason: 'no_idle_engine' });
      return { status: 'unavailable' };
    }
    const choice = choices[0];
    let reserved = false;
    try {
      if (!isCurrent()) {
        return { status: 'cancelled' };
      }
      reserve(choice.id);
      reserved = true;
      if (!isCurrent() || !announce(choice)) {
        return { status: 'cancelled' };
      }
      const stop = log.time('memory.engine.offload.completed', {
        engineId: choice.id,
        target,
      });
      const result = await offload(choice.id);
      if (result?.stopped !== true) {
        throw Error('The engine did not confirm it stopped.');
      }
      stop();
      failures.delete(choice.id);
      return { status: 'stopped', service: choice };
    } catch (error) {
      log.warn('memory.engine.offload.failed', {
        engineId: choice.id,
        target,
        errorClass: error?.name,
        cooldownMs,
      });
      failures.set(choice.id, now() + cooldownMs);
      return {
        status: 'failed',
        service: choice,
        error: error.message || 'Could not stop the idle service.',
      };
    } finally {
      if (reserved) {
        release(choice.id);
      }
    }
  };
}
