import { test } from 'node:test';
import assert from 'node:assert/strict';
import { magnitudeSpectrum, toDb } from '../../static/dsp/spectrum.js';
import { FeedbackTracker, freqToNoteName, crossCheckRoomVsMix } from '../../static/dsp/feedback.js';

const SR = 48000;
const FRAME_SIZE = 2048;

function powerDbSpectrum(samples) {
  const { magnitude, binHz } = magnitudeSpectrum(samples, SR);
  return { db: toDb(Float64Array.from(magnitude, (m) => m * m)), binHz };
}

function runFrames(tracker, totalS, genSample) {
  const alerts = [];
  const frames = Math.floor((totalS * SR) / FRAME_SIZE);
  for (let f = 0; f < frames; f++) {
    const t0 = f * FRAME_SIZE;
    const buf = new Float64Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) buf[i] = genSample(t0 + i, (t0 + i) / SR);
    const { db, binHz } = powerDbSpectrum(buf);
    const frameAlerts = tracker.process(db, binHz, t0 / SR);
    if (frameAlerts.length) alerts.push({ t: t0 / SR, frameAlerts });
  }
  return alerts;
}

test('freqToNoteName maps A4 to A4 and is roughly right nearby', () => {
  assert.equal(freqToNoteName(440), 'A4');
  assert.equal(freqToNoteName(261.63), 'C4');
});

test('rising 2.5kHz tone in noise triggers an alert within ~1s', () => {
  const tracker = new FeedbackTracker({});
  const alerts = runFrames(tracker, 2.0, (n, t) => {
    const amp = 0.05 * Math.pow(10, (3 * t) / 20); // +3 dB/s
    const noise = (Math.random() * 2 - 1) * 0.02;
    return amp * Math.sin(2 * Math.PI * 2500 * t) + noise;
  });
  assert.ok(alerts.length > 0, 'expected at least one alert');
  assert.ok(alerts[0].t <= 1.2, `first alert too late: ${alerts[0].t}s`);
  assert.ok(Math.abs(alerts[0].frameAlerts[0].freq - 2500) < 50);
});

test('stationary pure tone with no harmonics triggers within ~2.5s', () => {
  const tracker = new FeedbackTracker({});
  const alerts = runFrames(tracker, 3.2, (n, t) => {
    const noise = (Math.random() * 2 - 1) * 0.02;
    return 0.1 * Math.sin(2 * Math.PI * 3000 * t) + noise;
  });
  assert.ok(alerts.length > 0, 'expected an alert');
  assert.ok(alerts[0].t >= 1.8 && alerts[0].t <= 3.0, `alert at unexpected time: ${alerts[0].t}s`);
});

test('a harmonic stack (sung note with partials) does not trigger', () => {
  const tracker = new FeedbackTracker({});
  const alerts = runFrames(tracker, 3.2, (n, t) => {
    const noise = (Math.random() * 2 - 1) * 0.01;
    return (
      0.1 * Math.sin(2 * Math.PI * 300 * t) +
      0.07 * Math.sin(2 * Math.PI * 600 * t) +
      0.04 * Math.sin(2 * Math.PI * 900 * t) +
      noise
    );
  });
  assert.equal(alerts.length, 0, `expected no alerts, got ${JSON.stringify(alerts)}`);
});

test('speech-like modulated noise does not trigger', () => {
  const tracker = new FeedbackTracker({});
  const alerts = runFrames(tracker, 3.2, (n, t) => {
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t); // ~4Hz syllabic rate
    return envelope * (Math.random() * 2 - 1) * 0.15;
  });
  assert.equal(alerts.length, 0, `expected no alerts, got ${JSON.stringify(alerts)}`);
});

test('crossCheckRoomVsMix flags room-only energy', () => {
  assert.ok(crossCheckRoomVsMix(-10, -30)); // 20dB stronger in room
  assert.ok(!crossCheckRoomVsMix(-10, -12)); // present in both, probably real content
});
