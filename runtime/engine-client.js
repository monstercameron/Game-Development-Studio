// Runtime workers talk to the service supervisor through the HTTP host's IPC
// bridge. The supervisor keeps the actual child-process handles across restarts.
export class EngineClient {
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
  call(method, params = {}, timeout = 31500) {
    if (!process.connected) {
      return Promise.reject(new Error('Engine supervisor is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Engine supervisor request timed out.'));
      }, timeout);
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
  status() {
    return this.call('status');
  }
  speechActivity() {
    return this.call('speechActivity');
  }
  gameActivity() {
    return this.call('gameActivity');
  }
  requestGameLoad() {
    return this.call('requestGameLoad');
  }
  start(id, options = {}) {
    return this.call('start', { id, options });
  }
  startAll() {
    return this.call('startAll');
  }
  offload(id) {
    return this.call('offload', { id });
  }
  forceStop(id) {
    return this.call('forceStop', { id }, 55000);
  }
  removeModel(id, retry = false) {
    return this.call('removeModel', { id, retry });
  }
}
