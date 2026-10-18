// AudioWorkletProcessor used by the Phase 0 probe. Computes per-channel
// RMS/peak over short blocks and posts them to the main thread. This is the
// same capture primitive capture.js will use in Phase 1, so the probe
// exercises the real code path, not a simplified stand-in.

class ProbeMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sumSquares = [];
    this._peaks = [];
    this._samplesInWindow = 0;
    // ~10 updates/sec at 48kHz with 128-frame render quanta.
    this._windowFrames = Math.round(sampleRate / 10);
  }

  process(inputs) {
    const input = inputs[0];
    const channelCount = input.length;
    if (channelCount === 0) return true;

    if (this._sumSquares.length !== channelCount) {
      this._sumSquares = new Array(channelCount).fill(0);
      this._peaks = new Array(channelCount).fill(0);
      this._samplesInWindow = 0;
    }

    const frames = input[0].length;
    for (let ch = 0; ch < channelCount; ch++) {
      const data = input[ch];
      let sumSq = this._sumSquares[ch];
      let peak = this._peaks[ch];
      for (let i = 0; i < frames; i++) {
        const v = data[i];
        sumSq += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      this._sumSquares[ch] = sumSq;
      this._peaks[ch] = peak;
    }
    this._samplesInWindow += frames;

    if (this._samplesInWindow >= this._windowFrames) {
      const rms = this._sumSquares.map((s) => Math.sqrt(s / this._samplesInWindow));
      this.port.postMessage({ channelCount, rms, peak: this._peaks.slice() });
      this._sumSquares.fill(0);
      this._peaks.fill(0);
      this._samplesInWindow = 0;
    }

    return true;
  }
}

registerProcessor('probe-meter', ProbeMeter);
