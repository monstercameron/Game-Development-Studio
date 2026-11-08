import {
  EngineOwnershipJournal,
  verifyEngineOwnership,
  probeWindowsProcess,
} from './engine-ownership.js';

// A journal entry is evidence of an authorized launch, not proof of ownership.
// Recovery always challenges the worker and checks its OS listener identity.
export class EngineRecovery {
  constructor({
    directory,
    journal = new EngineOwnershipJournal({ directory }),
    verify = verifyEngineOwnership,
    probe = probeWindowsProcess,
  } = {}) {
    this.journal = journal;
    this.verify = verify;
    this.probe = probe;
  }

  async prepare(definition, nonce, token) {
    return this.journal.prepare({
      id: definition.id,
      port: definition.port,
      executable: definition.command,
      nonce,
      token,
    });
  }

  async check(definition, record) {
    return this.verify(record, {
      id: definition.id,
      port: definition.port,
      executable: definition.command,
    });
  }

  /**
   * Probes the journaled process. Returns 'alive', 'exited_or_reused' (the recorded
   * PID is gone or reused, so the entry may be cleared), or 'indeterminate' (the entry
   * is not in the running state, or no probe could decide).
   */
  async alive(record) {
    if (record.state !== 'running') {
      return 'indeterminate';
    }
    for (const executable of record.executables) {
      const result = await this.probe({
        pid: record.pid,
        creationTicks: record.creationTicks,
        executable,
      });
      if (result.state === 'alive' || result.state === 'exited_or_reused') {
        return result.state;
      }
    }
    return 'indeterminate';
  }

  /**
   * Resolves the journal entry for an engine. Returns { state: 'none' } when no entry
   * exists or a dead entry was cleared; { state: 'recovered', record, process } when the
   * worker identity is verified; and { state: 'unresolved' } when the entry must stay
   * for a later check or a person. It never stops a process.
   */
  async reconcile(definition) {
    this.journal.assertHeld?.();
    const record = await this.journal.read(definition.id);
    if (!record) {
      return { state: 'none' };
    }
    const verified = await this.check(definition, record);
    if (verified.verified) {
      const bound =
        record.state === 'prepared'
          ? await this.journal.bind(definition.id, record.nonce, verified)
          : record;
      return { state: 'recovered', record: bound, process: verified };
    }
    // A prepared entry has no reliable process identity; it cannot be cleared
    // just because its listener is temporarily unavailable.
    if (record.state === 'running' && (await this.alive(record)) === 'exited_or_reused') {
      await this.journal.clear(definition.id, record.nonce);
      return { state: 'none' };
    }
    return { state: 'unresolved' };
  }

  async clearIfExited(definition, record) {
    if ((await this.alive(record)) !== 'exited_or_reused') {
      return false;
    }
    await this.journal.clear(definition.id, record.nonce);
    return true;
  }
}
