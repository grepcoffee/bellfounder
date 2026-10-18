import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crestFactorDb, spectralCentroid, spectralTilt, stereoCorrelation, bandEnergy } from '../../static/dsp/features.js';
import { magnitudeSpectrum } from '../../static/dsp/spectrum.js';

const SR = 48000;

test('crestFactorDb of a sine is ~3dB (peak/rms = sqrt(2))', () => {
  const n = 4096;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
  assert.ok(Math.abs(crestFactorDb(samples) - 3.01) < 0.1);
});

test('crestFactorDb of a square wave is ~0dB (peak == rms)', () => {
  const n = 4096;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = i % 20 < 10 ? 1 : -1;
  assert.ok(Math.abs(crestFactorDb(samples) - 0) < 0.1);
});

test('spectralCentroid of a pure tone is near that frequency', () => {
  const n = 8192;
  const freq = 2000;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  const { magnitude, binHz } = magnitudeSpectrum(signal, SR);
  const centroid = spectralCentroid(magnitude, binHz);
  assert.ok(Math.abs(centroid - freq) < 50);
});

test('spectralTilt is negative for pink-noise-like (falling) spectra', () => {
  const n = 8192;
  const magnitude = new Float64Array(n / 2 + 1);
  const binHz = SR / n;
  for (let k = 1; k < magnitude.length; k++) magnitude[k] = 1 / (k * binHz); // ~ -3dB/oct in power -> falling in dB
  const db = Float64Array.from(magnitude, (m) => 20 * Math.log10(m));
  const tilt = spectralTilt(db, binHz);
  assert.ok(tilt < 0);
});

test('stereoCorrelation is 1 for identical channels, -1 for inverted', () => {
  const n = 1000;
  const left = new Float64Array(n);
  for (let i = 0; i < n; i++) left[i] = Math.sin((2 * Math.PI * 300 * i) / SR) + (Math.random() - 0.5) * 0.01;
  const rightSame = left.slice();
  const rightInverted = Float64Array.from(left, (v) => -v);
  assert.ok(stereoCorrelation(left, rightSame) > 0.99);
  assert.ok(stereoCorrelation(left, rightInverted) < -0.99);
});

test('bandEnergy isolates energy within the requested range', () => {
  const n = 8192;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * 1000 * i) / SR);
  const { magnitude, binHz } = magnitudeSpectrum(signal, SR);
  const inBand = bandEnergy(magnitude, binHz, 900, 1100);
  const outOfBand = bandEnergy(magnitude, binHz, 5000, 6000);
  assert.ok(inBand > outOfBand * 100);
});
