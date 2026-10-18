// FFT magnitude -> 1/3-octave band energies, fast/slow smoothing, and
// deviation from a target curve. Pure functions, no DOM.

import { rfft, nextPow2 } from './fft.js';

export const THIRD_OCTAVE_CENTERS = buildThirdOctaveCenters();

function buildThirdOctaveCenters() {
  // ANSI S1.11 base-10 1/3-octave centers: f = 1000 * 10^(b/10), nominal
  // 20 Hz - 20 kHz (31 bands). b=-17 gives the exact center (19.95 Hz) for
  // the band whose nominal label is "20 Hz" - don't round it away.
  const centers = [];
  for (let b = -17; b <= 13; b++) centers.push(1000 * Math.pow(10, b / 10));
  return centers;
}

/** Hann window, cached by length. */
const hannCache = new Map();
export function hannWindow(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Compute a magnitude spectrum from a time-domain block. Applies a Hann
 * window and zero-pads to the next power of 2 if needed.
 * @returns {{ magnitude: Float64Array, binHz: number }}
 */
export function magnitudeSpectrum(samples, sampleRate) {
  const n = samples.length;
  const win = hannWindow(n);
  const padded = new Float64Array(nextPow2(n));
  for (let i = 0; i < n; i++) padded[i] = samples[i] * win[i];
  const { magnitude } = rfft(padded);
  return { magnitude, binHz: sampleRate / padded.length };
}

/**
 * Sum FFT bin energy into 1/3-octave bands. Each band spans
 * center * 2^(-1/6) .. center * 2^(1/6).
 * @returns {Float64Array} energy (linear power, not dB) per band in THIRD_OCTAVE_CENTERS
 */
export function toThirdOctaveBands(magnitude, binHz) {
  const bands = new Float64Array(THIRD_OCTAVE_CENTERS.length);
  const factor = Math.pow(2, 1 / 6);
  for (let bi = 0; bi < THIRD_OCTAVE_CENTERS.length; bi++) {
    const lo = THIRD_OCTAVE_CENTERS[bi] / factor;
    const hi = THIRD_OCTAVE_CENTERS[bi] * factor;
    const kLo = Math.max(1, Math.ceil(lo / binHz));
    const kHi = Math.min(magnitude.length - 1, Math.floor(hi / binHz));
    let energy = 0;
    for (let k = kLo; k <= kHi; k++) energy += magnitude[k] * magnitude[k];
    bands[bi] = energy;
  }
  return bands;
}

/** Exponential moving average in the linear (power) domain. */
export function expSmooth(prev, next, timeConstantS, dtS) {
  if (!prev) return Float64Array.from(next);
  const alpha = 1 - Math.exp(-dtS / timeConstantS);
  const out = new Float64Array(next.length);
  for (let i = 0; i < next.length; i++) out[i] = prev[i] + alpha * (next[i] - prev[i]);
  return out;
}

export function toDb(bandEnergies, floor = 1e-12) {
  return Float64Array.from(bandEnergies, (e) => 10 * Math.log10(Math.max(e, floor)));
}

/**
 * Deviation of measured bands from a target curve, after normalising both
 * to equal energy in the 250 Hz - 4 kHz range (so overall level doesn't
 * register as a tonal problem).
 * @param {number[]} measuredDb per-band dB (THIRD_OCTAVE_CENTERS order)
 * @param {number[]} targetDb same shape
 * @returns {Float64Array} measured - target, in dB, per band
 */
export function targetDeviation(measuredDb, targetDb) {
  const refIdx = THIRD_OCTAVE_CENTERS.reduce((acc, f, i) => {
    if (f >= 250 && f <= 4000) acc.push(i);
    return acc;
  }, []);
  const avg = (arr) => refIdx.reduce((s, i) => s + arr[i], 0) / refIdx.length;
  const measuredRef = avg(measuredDb);
  const targetRef = avg(targetDb);
  const offset = measuredRef - targetRef;
  return Float64Array.from(measuredDb, (v, i) => v - offset - targetDb[i]);
}
