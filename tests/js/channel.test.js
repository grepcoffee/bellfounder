import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THIRD_OCTAVE_CENTERS } from '../../static/dsp/spectrum.js';
import { channelFindings } from '../../static/dsp/channel.js';

test('flags mud when 200-500Hz is well above target', () => {
  const deviationDb = new Array(THIRD_OCTAVE_CENTERS.length).fill(0);
  THIRD_OCTAVE_CENTERS.forEach((f, i) => {
    if (f >= 200 && f <= 500) deviationDb[i] = 6;
  });
  const { findings } = channelFindings({ deviationDb, magnitude: null, binHz: 0, hpfHz: 80, crestFactorDb: 12 });
  const mud = findings.find((f) => f.type === 'mud');
  assert.ok(mud, 'expected a mud finding');
  assert.ok(mud.deviationDb > 3);
});

test('flags rumble below the role HPF point and suggests that frequency', () => {
  const deviationDb = new Array(THIRD_OCTAVE_CENTERS.length).fill(0);
  THIRD_OCTAVE_CENTERS.forEach((f, i) => {
    if (f < 80) deviationDb[i] = 8;
  });
  const { findings } = channelFindings({ deviationDb, magnitude: null, binHz: 0, hpfHz: 80, crestFactorDb: 12 });
  const rumble = findings.find((f) => f.type === 'rumble');
  assert.ok(rumble);
  assert.equal(rumble.suggestion.freqHz, 80);
});

test('flags over- and under-compression from crest factor', () => {
  const flatDeviation = new Array(THIRD_OCTAVE_CENTERS.length).fill(0);
  const over = channelFindings({ deviationDb: flatDeviation, magnitude: null, binHz: 0, hpfHz: 80, crestFactorDb: 4 });
  assert.ok(over.findings.some((f) => f.type === 'over-compressed'));

  const under = channelFindings({ deviationDb: flatDeviation, magnitude: null, binHz: 0, hpfHz: 80, crestFactorDb: 25 });
  assert.ok(under.findings.some((f) => f.type === 'under-compressed'));
});

test('no findings for a flat spectrum and normal dynamics', () => {
  const flatDeviation = new Array(THIRD_OCTAVE_CENTERS.length).fill(0);
  const { findings } = channelFindings({ deviationDb: flatDeviation, magnitude: null, binHz: 0, hpfHz: 80, crestFactorDb: 12 });
  assert.equal(findings.length, 0);
});
