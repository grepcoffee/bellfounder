// Radix-2 real FFT. Pure functions, no DOM - unit-testable with node --test.
//
// fft() is an in-place iterative Cooley-Tukey decimation-in-time FFT over
// complex (re, im) arrays whose length is a power of two. rfft() is the
// convenience wrapper DSP code actually calls: real input in, magnitude and
// phase for bins 0..N/2 out (the independent bins of a real-valued signal).

/**
 * In-place complex FFT. `re` and `im` are mutated. `n` must be a power of 2.
 */
export function fft(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error('fft: re/im length mismatch');
  if (n & (n - 1)) throw new Error('fft: length must be a power of 2');
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Iterative butterfly stages.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const bRe = re[b] * curRe - im[b] * curIm;
        const bIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - bRe;
        im[b] = im[a] - bIm;
        re[a] += bRe;
        im[a] += bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

/**
 * Real-input FFT. Returns magnitude and phase for bins 0..N/2 inclusive
 * (the non-redundant half of a real signal's spectrum). `signal` must have
 * a power-of-2 length.
 */
export function rfft(signal) {
  const n = signal.length;
  const re = Float64Array.from(signal);
  const im = new Float64Array(n);
  fft(re, im);

  const half = n / 2;
  const magnitude = new Float64Array(half + 1);
  const phase = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    magnitude[k] = Math.hypot(re[k], im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return { magnitude, phase };
}

/** Next power of 2 >= n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
