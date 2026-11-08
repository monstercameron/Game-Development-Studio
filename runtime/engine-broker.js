// The HTTP host forwards engine operations without owning engine processes.
export class EngineBroker {
  constructor() {
    this.nextId = 0;
    this.pending = new Map();
    process.on('message', (message) => {
      if (message?.type !== 'engine_reply') {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
    });
    process.on('disconnect', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Engine supervisor disconnected.'));
      }
      this.pending.clear();
    });
  }

  /**
   * Forwards one engine operation to the supervisor process.
   *
   * Rejects when the supervisor is not connected, when the send fails, when the
   * supervisor reports an error, or when no reply arrives in time. A timeout or a
   * disconnect leaves the outcome unknown: the engine may still be running the
   * request, so callers must check its state rather than submit it again.
   *
   * @param {string} method Supervisor operation name (for example `forceStop`).
   * @param {object} params Operation arguments, passed through unchanged.
   * @returns {Promise<unknown>} The supervisor's `result` field.
   */
  call(method, params) {
    if (!process.connected) {
      return Promise.reject(new Error('Engine supervisor is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      // forceStop gets a longer reply window than other operations, in milliseconds.
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error('Engine supervisor request timed out.'));
        },
        method === 'forceStop' ? 55000 : 32000,
      );
      this.pending.set(id, { resolve, reject, timer });
      process.send({ type: 'engine_request', id, method, params }, (error) => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
}
