// Capture short little-endian PCM16 frames without blocking the UI thread.
class ForgePcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(2048);
    this.used = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === 'flush' && !this.stopped) {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  flush() {
    if (!this.used) {
      return;
    }
    const buffer = new ArrayBuffer(this.used * 2),
      view = new DataView(buffer);
    for (let i = 0; i < this.used; i++) {
      view.setInt16(i * 2, this.samples[i], true);
    }
    this.used = 0;
    this.port.postMessage({ type: 'audio', buffer }, [buffer]);
  }
  process(inputs) {
    if (this.stopped) {
      return false;
    }
    const channels = inputs[0];
    if (!channels?.length) {
      return true;
    }
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) {
        value += channel[i] || 0;
      }
      value = Math.max(-1, Math.min(1, value / channels.length));
      this.samples[this.used++] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
      if (this.used === this.samples.length) {
        this.flush();
      }
    }
    return true;
  }
}
registerProcessor('forge-pcm16', ForgePcm16Processor);
