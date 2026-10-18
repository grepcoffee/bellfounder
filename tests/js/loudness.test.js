import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoudnessMeter, truePeak, linearToDb } from '../../static/dsp/loudness.js';

const SR = 48000;

/**
 * EBU calibration tones are specified by RMS level in dBFS (the broadcast
 * convention), not peak amplitude - so a sine "at -23 dBFS" has RMS equal
 * to 10^(-23/20), peak = RMS * sqrt(2). BS.1770's -0.691 LUFS offset is
 * calibrated so that, combined with the K-weighting filter's own +0.7dB
 * gain at 1kHz, this reads back almost exactly as -23.0 LUFS.
 */
function sineAtDbfsRms(dbfs, freq, seconds, sampleRate = SR) {
  const rms = Math.pow(10, dbfs / 20);
  const amplitude = rms * Math.SQRT2;
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

test('LoudnessMeter rejects non-48kHz sample rates', () => {
  assert.throws(() => new LoudnessMeter(44100, [1]));
});

test('integrated LUFS matches EBU reference tone within 0.1 LU (mono-ish, single channel weight)', () => {
  const meter = new LoudnessMeter(SR, [1]);
  const samples = sineAtDbfsRms(-23, 1000, 5);
  for (let i = 0; i < samples.length; i += 128) {
    meter.process([samples.subarray(i, Math.min(i + 128, samples.length))]);
  }
  const integrated = meter.getIntegratedLUFS();
  assert.ok(integrated !== null);
  assert.ok(Math.abs(integrated - -23.0) < 0.1, `expected ~-23.0 LUFS, got ${integrated}`);
});

test('momentary and short-term LUFS track a steady tone to the same value', () => {
  const meter = new LoudnessMeter(SR, [1]);
  const samples = sineAtDbfsRms(-18, 1000, 4);
  for (let i = 0; i < samples.length; i += 128) {
    meter.process([samples.subarray(i, Math.min(i + 128, samples.length))]);
  }
  const momentary = meter.getMomentaryLUFS();
  const shortTerm = meter.getShortTermLUFS();
  assert.ok(momentary !== null);
  assert.ok(shortTerm !== null);
  assert.ok(Math.abs(momentary - shortTerm) < 0.2);
  assert.ok(Math.abs(momentary - -18.0) < 0.15);
});

test('absolute gate excludes silence from integrated loudness', () => {
  const meter = new LoudnessMeter(SR, [1]);
  const loud = sineAtDbfsRms(-18, 1000, 2);
  const silence = new Float32Array(Math.round(2 * SR));
  for (const samples of [loud, silence]) {
    for (let i = 0; i < samples.length; i += 128) {
      meter.process([samples.subarray(i, Math.min(i + 128, samples.length))]);
    }
  }
  const integrated = meter.getIntegratedLUFS();
  // If silence dragged the average down, this would be well below -18.
  assert.ok(Math.abs(integrated - -18.0) < 0.5, `expected gating to exclude silence, got ${integrated}`);
});

test('truePeak is never less than the sample peak', () => {
  const samples = sineAtDbfsRms(-6, 2500, 0.05);
  let samplePeak = 0;
  for (const s of samples) samplePeak = Math.max(samplePeak, Math.abs(s));
  assert.ok(truePeak(samples) >= samplePeak - 1e-9);
});

test('truePeak detects inter-sample overshoot on the classic EBU Tech 3341 pattern', () => {
  // [0.5, 0.5, -1.0, -1.0] repeating: sample peak is 0 dBFS, but the
  // reconstructed waveform overshoots well above it.
  const pattern = [];
  for (let i = 0; i < 40; i++) pattern.push(0.5, 0.5, -1.0, -1.0);
  const dbtp = linearToDb(truePeak(pattern));
  assert.ok(dbtp > 1.5, `expected clear inter-sample overshoot, got ${dbtp} dBTP`);
  assert.ok(dbtp < 5, `overshoot implausibly large: ${dbtp} dBTP`);
});
