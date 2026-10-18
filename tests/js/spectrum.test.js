import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THIRD_OCTAVE_CENTERS,
  magnitudeSpectrum,
  toThirdOctaveBands,
  toDb,
  targetDeviation,
} from '../../static/dsp/spectrum.js';

const SR = 48000;

test('31 standard 1/3-octave bands from 20Hz to 20kHz', () => {
  assert.equal(THIRD_OCTAVE_CENTERS.length, 31);
  assert.ok(Math.abs(THIRD_OCTAVE_CENTERS[0] - 20) < 1);
  assert.ok(Math.abs(THIRD_OCTAVE_CENTERS.at(-1) - 20000) < 50);
});

test('a sine lands in the band nearest its frequency', () => {
  const n = 8192;
  const freq = 1000;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  const { magnitude, binHz } = magnitudeSpectrum(signal, SR);
  const bands = toThirdOctaveBands(magnitude, binHz);
  let maxIdx = 0;
  for (let i = 1; i < bands.length; i++) if (bands[i] > bands[maxIdx]) maxIdx = i;
  assert.ok(Math.abs(THIRD_OCTAVE_CENTERS[maxIdx] - 1000) < 50);
});

function pinkNoise(n, seedState = { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 }) {
  const out = new Float64Array(n);
  let { b0, b1, b2, b3, b4, b5, b6 } = seedState;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.1538520;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}

test('pink noise averages to flat 1/3-octave bands within ~1dB (100Hz-10kHz)', () => {
  const n = 8192;
  const numFrames = 60;
  let accum = null;
  for (let f = 0; f < numFrames; f++) {
    const signal = pinkNoise(n);
    const { magnitude, binHz } = magnitudeSpectrum(signal, SR);
    const bands = toThirdOctaveBands(magnitude, binHz);
    if (!accum) accum = new Float64Array(bands.length);
    for (let i = 0; i < bands.length; i++) accum[i] += bands[i];
  }
  const avgBands = Float64Array.from(accum, (v) => v / numFrames);
  const db = toDb(avgBands);

  const idxs = THIRD_OCTAVE_CENTERS.reduce((acc, f, i) => {
    if (f >= 100 && f <= 10000) acc.push(i);
    return acc;
  }, []);
  const mean = idxs.reduce((s, i) => s + db[i], 0) / idxs.length;
  for (const i of idxs) {
    const dev = db[i] - mean;
    assert.ok(Math.abs(dev) < 1.5, `band ${THIRD_OCTAVE_CENTERS[i]}Hz deviates ${dev.toFixed(2)}dB from flat`);
  }
});

test('targetDeviation is zero when measured matches target exactly', () => {
  const n = THIRD_OCTAVE_CENTERS.length;
  const target = new Array(n).fill(0).map((_, i) => (i % 3) - 1);
  const measured = target.slice();
  const dev = targetDeviation(measured, target);
  for (const d of dev) assert.ok(Math.abs(d) < 1e-9);
});

test('targetDeviation ignores a uniform level offset outside the 250Hz-4kHz reference range', () => {
  const n = THIRD_OCTAVE_CENTERS.length;
  const target = new Array(n).fill(0);
  const measured = target.map(() => 6); // 6dB louder everywhere, same shape
  const dev = targetDeviation(measured, target);
  for (const d of dev) assert.ok(Math.abs(d) < 1e-9, `expected ~0, got ${d}`);
});
