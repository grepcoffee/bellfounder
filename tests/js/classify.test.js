import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechMusicClassifier, classify } from '../../static/dsp/classify.js';
import { magnitudeSpectrum } from '../../static/dsp/spectrum.js';

const SR = 48000;
const FRAME_SIZE = 2048;

function feedTone(classifier, totalS, modulated) {
  let last;
  const frames = Math.floor((totalS * SR) / FRAME_SIZE);
  for (let f = 0; f < frames; f++) {
    const t0 = f * FRAME_SIZE;
    const buf = new Float64Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      const t = (t0 + i) / SR;
      const envelope = modulated ? 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t) : 1;
      buf[i] = envelope * Math.sin(2 * Math.PI * 1000 * t);
    }
    const { magnitude, binHz } = magnitudeSpectrum(buf, SR);
    last = classifier.process(magnitude, binHz);
  }
  return last;
}

test('manual override always wins regardless of score', () => {
  assert.equal(classify(-5, 'speech').mode, 'speech');
  assert.equal(classify(5, 'music').mode, 'music');
  assert.equal(classify(-5, 'speech').manual, true);
});

test('without override, classify follows the sign of the score', () => {
  assert.equal(classify(1).mode, 'speech');
  assert.equal(classify(-1).mode, 'music');
  assert.equal(classify(1).manual, false);
});

test('SpeechMusicClassifier produces a higher score for 4Hz-modulated content than steady tone', () => {
  const frameRateHz = SR / FRAME_SIZE;
  const modClassifier = new SpeechMusicClassifier({ frameRateHz });
  const steadyClassifier = new SpeechMusicClassifier({ frameRateHz });
  const modResult = feedTone(modClassifier, 3.2, true);
  const steadyResult = feedTone(steadyClassifier, 3.2, false);
  assert.ok(modResult.modulationRatio > steadyResult.modulationRatio);
});
