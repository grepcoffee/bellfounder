// Speech vs music heuristic: syllabic (~4 Hz) modulation energy, spectral
// flux, and low-band energy ratio. This is a heuristic, not a classifier
// with labelled training data - PLAN.md is explicit that a manual override
// always wins, so `process()` returns a score and `classify()` lets the
// caller apply that override on top.

import { rfft, nextPow2 } from './fft.js';
import { bandEnergy } from './features.js';

const DEFAULT_FRAME_RATE_HZ = 10;
const ENVELOPE_HISTORY_S = 3.2;

export class SpeechMusicClassifier {
  constructor({ frameRateHz = DEFAULT_FRAME_RATE_HZ } = {}) {
    this.frameRateHz = frameRateHz;
    this.historyLen = nextPow2(Math.round(ENVELOPE_HISTORY_S * frameRateHz));
    this.envelopeHistory = [];
    this.prevMagnitude = null;
  }

  /**
   * Feed one spectral frame. Returns a score where positive leans speech,
   * negative leans music - the sign and magnitude are heuristic, not a
   * calibrated probability.
   */
  process(magnitude, binHz) {
    const lowEnergy = bandEnergy(magnitude, binHz, 20, 300);
    const totalEnergy = bandEnergy(magnitude, binHz, 20, 16000) || 1e-12;
    const lowRatio = lowEnergy / totalEnergy;

    const speechBandEnergy = bandEnergy(magnitude, binHz, 200, 4000);
    this.envelopeHistory.push(speechBandEnergy);
    if (this.envelopeHistory.length > this.historyLen) this.envelopeHistory.shift();

    const modulationRatio = this._syllabicModulationRatio();

    let flux = 0;
    if (this.prevMagnitude && this.prevMagnitude.length === magnitude.length) {
      for (let k = 0; k < magnitude.length; k++) {
        const d = magnitude[k] - this.prevMagnitude[k];
        if (d > 0) flux += d;
      }
    }
    this.prevMagnitude = Float64Array.from(magnitude);
    const magSum = magnitude.reduce((a, b) => a + b, 0) || 1;
    const normFlux = flux / magSum;

    // Heuristic weights, tuned by feel rather than data - PLAN.md flags
    // this is a hint, not a ground truth, and the operator's manual
    // override is always available in Settings.
    const score = 2.0 * modulationRatio - 1.5 * normFlux - 1.0 * lowRatio;

    return { score, modulationRatio, normFlux, lowRatio };
  }

  /** Energy in the 3-5 Hz band of the speech-band envelope, as a fraction of total envelope energy. */
  _syllabicModulationRatio() {
    const n = this.envelopeHistory.length;
    if (n < 8) return 0;
    const windowed = this.envelopeHistory.slice(-this.historyLen);
    const mean = windowed.reduce((a, b) => a + b, 0) / windowed.length;
    const padded = new Float64Array(this.historyLen);
    for (let i = 0; i < windowed.length; i++) padded[i] = windowed[i] - mean;

    const { magnitude } = rfft(padded);
    const binHzEnv = this.frameRateHz / this.historyLen;
    let total = 0;
    let syllabic = 0;
    for (let k = 1; k < magnitude.length; k++) {
      const f = k * binHzEnv;
      const e = magnitude[k] * magnitude[k];
      total += e;
      if (f >= 3 && f <= 5) syllabic += e;
    }
    return total > 0 ? syllabic / total : 0;
  }

  reset() {
    this.envelopeHistory = [];
    this.prevMagnitude = null;
  }
}

/**
 * @param {number} score from SpeechMusicClassifier.process
 * @param {'speech'|'music'|null} manualOverride
 */
export function classify(score, manualOverride = null) {
  if (manualOverride === 'speech' || manualOverride === 'music') {
    return { mode: manualOverride, manual: true, score };
  }
  return { mode: score >= 0 ? 'speech' : 'music', manual: false, score };
}
