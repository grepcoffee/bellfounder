// ITU-R BS.1770-4 loudness: K-weighting, momentary/short-term/integrated
// LUFS, and true peak via 4x oversampling. Pure functions/classes, no DOM.
//
// K-weighting coefficients below are the standard 48 kHz reference values
// from BS.1770-4 Annex 2. Bellfounder's capture layer always requests
// 48 kHz (PLAN.md section 2), so no other sample rate is supported here -
// resample upstream if that assumption ever breaks.

const SUPPORTED_SAMPLE_RATE = 48000;

const STAGE1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const STAGE2 = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };

class Biquad {
  constructor({ b0, b1, b2, a1, a2 }) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class KWeightingFilter {
  constructor() {
    this.stage1 = new Biquad(STAGE1);
    this.stage2 = new Biquad(STAGE2);
  }

  process(x) {
    return this.stage2.process(this.stage1.process(x));
  }
}

/**
 * Streaming loudness meter for BS.1770 momentary/short-term/integrated
 * LUFS. Feed it audio a block at a time (e.g. 128-frame AudioWorklet
 * quanta); it accumulates 100ms "partial blocks" internally and keeps
 * enough history for a 3s short-term window plus the full session for
 * integrated gating.
 */
export class LoudnessMeter {
  /**
   * @param {number} sampleRate must be 48000
   * @param {number[]} channelWeights BS.1770 channel gains, e.g. [1, 1] for
   *   stereo L/R, [1, 1, 1, 1.41, 1.41] for 5.1 with surrounds weighted.
   */
  constructor(sampleRate, channelWeights = [1, 1]) {
    if (sampleRate !== SUPPORTED_SAMPLE_RATE) {
      throw new Error(`LoudnessMeter only supports ${SUPPORTED_SAMPLE_RATE} Hz, got ${sampleRate}`);
    }
    this.channelWeights = channelWeights;
    this.numChannels = channelWeights.length;
    this.filters = Array.from({ length: this.numChannels }, () => new KWeightingFilter());

    this.partialBlockSamples = Math.round(sampleRate * 0.1); // 100ms
    this._sumSq = new Float64Array(this.numChannels);
    this._countInPartial = 0;

    // Per-channel mean square for each completed 100ms partial, kept for
    // the whole session (integrated gating needs the full history).
    this.partials = []; // [{ meanSq: number[] }]
  }

  /** @param {Float32Array[]} channelBlocks one array per channel, equal length */
  process(channelBlocks) {
    const frames = channelBlocks[0].length;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < this.numChannels; ch++) {
        const filtered = this.filters[ch].process(channelBlocks[ch][i]);
        this._sumSq[ch] += filtered * filtered;
      }
      this._countInPartial++;
      if (this._countInPartial >= this.partialBlockSamples) {
        this._finishPartial();
      }
    }
  }

  _finishPartial() {
    const meanSq = Array.from(this._sumSq, (s) => s / this._countInPartial);
    this.partials.push({ meanSq });
    this._sumSq.fill(0);
    this._countInPartial = 0;
  }

  _loudnessFromMeanSq(meanSq) {
    let weighted = 0;
    for (let ch = 0; ch < this.numChannels; ch++) {
      weighted += this.channelWeights[ch] * meanSq[ch];
    }
    if (weighted <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(weighted);
  }

  _averageMeanSq(partials) {
    const avg = new Array(this.numChannels).fill(0);
    for (const p of partials) {
      for (let ch = 0; ch < this.numChannels; ch++) avg[ch] += p.meanSq[ch];
    }
    return avg.map((s) => s / partials.length);
  }

  /** Last 400ms (4 partials). Null until that much audio has been seen. */
  getMomentaryLUFS() {
    if (this.partials.length < 4) return null;
    return this._loudnessFromMeanSq(this._averageMeanSq(this.partials.slice(-4)));
  }

  /** Last 3s (30 partials). Null until that much audio has been seen. */
  getShortTermLUFS() {
    if (this.partials.length < 30) return null;
    return this._loudnessFromMeanSq(this._averageMeanSq(this.partials.slice(-30)));
  }

  /**
   * Gated integrated loudness over the whole session: absolute gate at
   * -70 LUFS, then relative gate at (ungated-above-absolute mean) - 10 LU,
   * both applied to the 400ms sliding-window loudness values.
   */
  getIntegratedLUFS() {
    if (this.partials.length < 4) return null;

    // 400ms windows, one per partial, each covering that partial and the
    // 3 before it (so the same granularity as momentary loudness).
    const windowMeanSqs = [];
    for (let i = 3; i < this.partials.length; i++) {
      windowMeanSqs.push(this._averageMeanSq(this.partials.slice(i - 3, i + 1)));
    }

    const ABS_GATE = -70;
    const passedAbsolute = windowMeanSqs.filter((ms) => this._loudnessFromMeanSq(ms) > ABS_GATE);
    if (passedAbsolute.length === 0) return -Infinity;

    const relativeMean = this._averageMeanSq(passedAbsolute.map((meanSq) => ({ meanSq })));
    const relativeThreshold = this._loudnessFromMeanSq(relativeMean) - 10;

    const passedRelative = passedAbsolute.filter((ms) => this._loudnessFromMeanSq(ms) > relativeThreshold);
    if (passedRelative.length === 0) return -Infinity;

    const finalMeanSq = this._averageMeanSq(passedRelative.map((meanSq) => ({ meanSq })));
    return this._loudnessFromMeanSq(finalMeanSq);
  }

  reset() {
    this.partials = [];
    this._sumSq.fill(0);
    this._countInPartial = 0;
    this.filters = Array.from({ length: this.numChannels }, () => new KWeightingFilter());
  }
}

/**
 * True peak via 4x polyphase oversampling (simple windowed-sinc
 * interpolation, adequate for inter-sample peak detection per BS.1770's
 * intent - not a mastering-grade oversampling filter).
 * @param {Float32Array|number[]} samples
 * @returns {number} true peak as linear amplitude (not dB)
 */
export function truePeak(samples) {
  const factor = 4;
  const taps = 48; // 12 taps per phase, even, symmetric windowed sinc
  const half = taps / 2;
  let peak = 0;

  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }

  for (let phase = 1; phase < factor; phase++) {
    const frac = phase / factor;
    for (let n = 0; n < samples.length; n++) {
      let acc = 0;
      for (let k = -half; k < half; k++) {
        const idx = n + k;
        if (idx < 0 || idx >= samples.length) continue;
        const x = idx - (n + frac);
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / half); // Hann taper centred on the interpolated point
        acc += samples[idx] * sinc * window;
      }
      if (Math.abs(acc) > peak) peak = Math.abs(acc);
    }
  }
  return peak;
}

export function linearToDb(x) {
  return x <= 0 ? -Infinity : 20 * Math.log10(x);
}
