// Crest factor, spectral centroid/tilt, stereo correlation, band energy
// summaries. Pure functions, no DOM.

/** Peak / RMS, linear in, dB out. */
export function crestFactorDb(samples) {
  let peak = 0;
  let sumSq = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  if (rms <= 0) return Infinity;
  return 20 * Math.log10(peak / rms);
}

/** Spectral centroid in Hz: energy-weighted mean frequency. */
export function spectralCentroid(magnitude, binHz) {
  let weighted = 0;
  let total = 0;
  for (let k = 1; k < magnitude.length; k++) {
    const energy = magnitude[k] * magnitude[k];
    weighted += energy * (k * binHz);
    total += energy;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Spectral tilt: least-squares slope of dB vs log2(freq), in dB/octave.
 * Negative means energy falls off with frequency (typical of most music).
 */
export function spectralTilt(magnitudeDb, binHz, minFreq = 60, maxFreq = 16000) {
  const points = [];
  for (let k = 1; k < magnitudeDb.length; k++) {
    const freq = k * binHz;
    if (freq < minFreq || freq > maxFreq) continue;
    points.push([Math.log2(freq), magnitudeDb[k]]);
  }
  const n = points.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const [x, y] of points) { sumX += x; sumY += y; sumXX += x * x; sumXY += x * y; }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/** Pearson correlation between L/R over a block, -1..1. */
export function stereoCorrelation(left, right) {
  const n = Math.min(left.length, right.length);
  let sumL = 0, sumR = 0, sumLL = 0, sumRR = 0, sumLR = 0;
  for (let i = 0; i < n; i++) {
    sumL += left[i]; sumR += right[i];
    sumLL += left[i] * left[i]; sumRR += right[i] * right[i];
    sumLR += left[i] * right[i];
  }
  const meanL = sumL / n, meanR = sumR / n;
  const covariance = sumLR / n - meanL * meanR;
  const varL = sumLL / n - meanL * meanL;
  const varR = sumRR / n - meanR * meanR;
  const denom = Math.sqrt(varL * varR);
  if (denom <= 0) return varL === 0 && varR === 0 ? 1 : 0;
  return covariance / denom;
}

/**
 * Sum linear energy (magnitude^2) between two frequencies.
 * @returns {number} summed power
 */
export function bandEnergy(magnitude, binHz, loHz, hiHz) {
  const kLo = Math.max(0, Math.ceil(loHz / binHz));
  const kHi = Math.min(magnitude.length - 1, Math.floor(hiHz / binHz));
  let energy = 0;
  for (let k = kLo; k <= kHi; k++) energy += magnitude[k] * magnitude[k];
  return energy;
}
