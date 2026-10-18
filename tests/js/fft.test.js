import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, rfft, nextPow2 } from '../../static/dsp/fft.js';

test('nextPow2', () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(2), 2);
  assert.equal(nextPow2(3), 4);
  assert.equal(nextPow2(1024), 1024);
  assert.equal(nextPow2(1025), 2048);
});

test('fft of a DC signal has all energy in bin 0', () => {
  const n = 64;
  const re = new Float64Array(n).fill(1);
  const im = new Float64Array(n);
  fft(re, im);
  assert.ok(Math.abs(re[0] - n) < 1e-9);
  for (let k = 1; k < n; k++) {
    assert.ok(Math.hypot(re[k], im[k]) < 1e-9, `bin ${k} should be ~0`);
  }
});

test('rfft finds a pure tone in the right bin', () => {
  const n = 1024;
  const sr = 48000;
  const binHz = sr / n;
  const targetBin = 100;
  const freq = targetBin * binHz;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * freq * i) / sr);

  const { magnitude } = rfft(signal);
  let maxBin = 0;
  for (let k = 1; k < magnitude.length; k++) if (magnitude[k] > magnitude[maxBin]) maxBin = k;
  assert.equal(maxBin, targetBin);
});

test('fft throws on non-power-of-2 length', () => {
  const re = new Float64Array(10);
  const im = new Float64Array(10);
  assert.throws(() => fft(re, im));
});
