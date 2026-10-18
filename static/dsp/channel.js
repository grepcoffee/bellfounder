// Per-channel findings: turns a measured spectrum into the short list of
// facts described in PLAN.md section 4 ("Channel findings"). Pure
// functions, no DOM - the LLM prompt builder (server-side) consumes this
// output, so field names here are the vocabulary the rest of the system
// speaks.

import { THIRD_OCTAVE_CENTERS } from './spectrum.js';
import { findPeakCandidates } from './feedback.js';

const DEVIATION_THRESHOLD_DB = 3; // below this, a band isn't worth mentioning

const NAMED_RANGES = [
  { key: 'mud', loHz: 200, hiHz: 500 },
  { key: 'boxy', loHz: 500, hiHz: 1000 },
  { key: 'honk', loHz: 1000, hiHz: 2000 },
  { key: 'harsh', loHz: 2000, hiHz: 5000 },
  { key: 'sibilance', loHz: 5000, hiHz: 9000 },
  { key: 'air', loHz: 10000, hiHz: 20000 },
];

/**
 * Average target deviation (measured - target, dB) over a named frequency
 * range, using whichever 1/3-octave bands fall inside it.
 */
function avgDeviationInRange(deviationDb, loHz, hiHz) {
  const idxs = THIRD_OCTAVE_CENTERS.reduce((acc, f, i) => {
    if (f >= loHz && f <= hiHz) acc.push(i);
    return acc;
  }, []);
  if (idxs.length === 0) return 0;
  return idxs.reduce((s, i) => s + deviationDb[i], 0) / idxs.length;
}

/**
 * @param {object} input
 * @param {number[]|Float64Array} input.deviationDb from spectrum.targetDeviation(), THIRD_OCTAVE_CENTERS order
 * @param {Float64Array|number[]} input.magnitude slow-averaged FFT magnitude, for resonance finding
 * @param {number} input.binHz
 * @param {number} input.hpfHz role's recommended high-pass point, e.g. 80 for vocal
 * @param {number} input.crestFactorDb
 * @param {number} [input.loudnessRangeDb] short-term loudness range, if available
 * @returns {{findings: object[], resonances: object[]}}
 */
export function channelFindings({ deviationDb, magnitude, binHz, hpfHz, crestFactorDb, loudnessRangeDb }) {
  const findings = [];

  const rumbleIdxs = THIRD_OCTAVE_CENTERS.reduce((acc, f, i) => {
    if (f < hpfHz) acc.push(i);
    return acc;
  }, []);
  if (rumbleIdxs.length > 0) {
    const rumbleDev = rumbleIdxs.reduce((s, i) => s + deviationDb[i], 0) / rumbleIdxs.length;
    if (rumbleDev > DEVIATION_THRESHOLD_DB) {
      findings.push({
        type: 'rumble',
        deviationDb: rumbleDev,
        suggestion: { action: 'hpf', freqHz: hpfHz },
      });
    }
  }

  for (const { key, loHz, hiHz } of NAMED_RANGES) {
    const dev = avgDeviationInRange(deviationDb, loHz, hiHz);
    if (Math.abs(dev) > DEVIATION_THRESHOLD_DB) {
      findings.push({
        type: key,
        band: { loHz, hiHz },
        deviationDb: dev,
        suggestion: dev > 0
          ? { action: 'cut', freqHz: Math.round(Math.sqrt(loHz * hiHz)), gainDb: -Math.min(dev, 6) }
          : null,
      });
    }
  }

  const resonances = magnitude
    ? findPeakCandidates(toDbSpectrum(magnitude), binHz, {
        minProminenceDb: 6,
        maxWidthOctaves: 1 / 6,
        minFreq: hpfHz,
        maxFreq: 16000,
      })
        .sort((a, b) => b.db - a.db)
        .slice(0, 3)
        .map((c) => ({ freqHz: Math.round(c.freq), heightDb: c.db, widthOctaves: c.widthOctaves }))
    : [];

  if (Number.isFinite(crestFactorDb)) {
    if (crestFactorDb < 6) {
      findings.push({ type: 'over-compressed', crestFactorDb });
    } else if (crestFactorDb > 20) {
      findings.push({ type: 'under-compressed', crestFactorDb });
    }
  }
  if (typeof loudnessRangeDb === 'number') {
    if (loudnessRangeDb > 15) {
      findings.push({ type: 'wide-dynamics', loudnessRangeDb });
    }
  }

  return { findings, resonances };
}

function toDbSpectrum(magnitude) {
  return Float64Array.from(magnitude, (m) => 20 * Math.log10(Math.max(m, 1e-12)));
}
