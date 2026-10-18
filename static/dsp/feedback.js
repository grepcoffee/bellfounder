// Feedback candidate detection. Pure functions/classes, no DOM.
// See PLAN.md section 4 ("Feedback detector") for the design rationale -
// this is the most safety-critical feature, so the five checks below are
// kept as separate, individually testable pieces.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Nearest equal-temperament note name (A4 = 440 Hz), e.g. "E4". */
export function freqToNoteName(freq) {
  if (freq <= 0) return null;
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const rounded = Math.round(semitonesFromA4);
  const midi = 69 + rounded; // MIDI note number, A4 = 69
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return `${name}${octave}`;
}

/**
 * Find narrow, prominent peaks in a dB spectrum - candidates 1 and 2 from
 * the feedback spec: >=12dB above the local 1/3-octave-neighbourhood
 * median, and narrower than 1/12 octave at -3dB down from the peak.
 * @param {Float64Array|number[]} magnitudeDb dB spectrum, index = FFT bin
 * @param {number} binHz Hz per bin
 * @param {object} [opts]
 * @returns {{bin:number, freq:number, db:number, widthOctaves:number}[]}
 */
export function findPeakCandidates(magnitudeDb, binHz, opts = {}) {
  const minProminenceDb = opts.minProminenceDb ?? 12;
  const maxWidthOctaves = opts.maxWidthOctaves ?? 1 / 12;
  const minFreq = opts.minFreq ?? 200;
  const maxFreq = opts.maxFreq ?? 16000;
  const n = magnitudeDb.length;
  const candidates = [];

  for (let k = 2; k < n - 2; k++) {
    const freq = k * binHz;
    if (freq < minFreq || freq > maxFreq) continue;
    const db = magnitudeDb[k];
    if (db < magnitudeDb[k - 1] || db < magnitudeDb[k + 1]) continue; // local max only

    // 1/3-octave neighbourhood, excluding a narrow window around the peak itself.
    const lo = freq / Math.pow(2, 1 / 6);
    const hi = freq * Math.pow(2, 1 / 6);
    const kLo = Math.max(0, Math.floor(lo / binHz));
    const kHi = Math.min(n - 1, Math.ceil(hi / binHz));
    const excludeHalfWidth = Math.max(1, Math.round((freq * 0.02) / binHz));
    const neighbourhood = [];
    for (let j = kLo; j <= kHi; j++) {
      if (Math.abs(j - k) <= excludeHalfWidth) continue;
      neighbourhood.push(magnitudeDb[j]);
    }
    if (neighbourhood.length < 3) continue;
    neighbourhood.sort((a, b) => a - b);
    const median = neighbourhood[Math.floor(neighbourhood.length / 2)];
    const prominence = db - median;
    if (prominence < minProminenceDb) continue;

    // -3dB width.
    const target = db - 3;
    let kLeft = k;
    while (kLeft > 0 && magnitudeDb[kLeft] > target) kLeft--;
    let kRight = k;
    while (kRight < n - 1 && magnitudeDb[kRight] > target) kRight++;
    const freqLeft = kLeft * binHz;
    const freqRight = kRight * binHz;
    const widthOctaves = Math.log2(Math.max(freqRight, binHz) / Math.max(freqLeft, binHz));
    if (widthOctaves > maxWidthOctaves) continue;

    candidates.push({ bin: k, freq, db, widthOctaves });
  }
  return candidates;
}

/**
 * Check candidates 2 and 3 (first and second harmonic) for energy that
 * suggests a real, pitched sound rather than a single resonant ring.
 * Looks for a local peak within +-3% of 2f and 3f that is itself at least
 * a modest amount above its own neighbourhood.
 */
export function hasHarmonicPartners(freq, magnitudeDb, binHz, opts = {}) {
  const minPartnerProminenceDb = opts.minPartnerProminenceDb ?? 6;
  const n = magnitudeDb.length;

  for (const mult of [2, 3]) {
    const target = freq * mult;
    const targetBin = Math.round(target / binHz);
    if (targetBin >= n - 2) continue;
    const searchHalfWidth = Math.max(1, Math.round((target * 0.03) / binHz));
    let bestBin = -1;
    let bestDb = -Infinity;
    for (let j = Math.max(2, targetBin - searchHalfWidth); j <= Math.min(n - 3, targetBin + searchHalfWidth); j++) {
      if (magnitudeDb[j] > bestDb) {
        bestDb = magnitudeDb[j];
        bestBin = j;
      }
    }
    if (bestBin < 0) continue;

    const lo = Math.max(0, bestBin - 10);
    const hi = Math.min(n - 1, bestBin + 10);
    const neighbourhood = [];
    for (let j = lo; j <= hi; j++) {
      if (Math.abs(j - bestBin) <= 1) continue;
      neighbourhood.push(magnitudeDb[j]);
    }
    neighbourhood.sort((a, b) => a - b);
    const median = neighbourhood[Math.floor(neighbourhood.length / 2)];
    if (bestDb - median >= minPartnerProminenceDb) return true;
  }
  return false;
}

/** Least-squares slope of (time, dB) points, in dB/s. */
export function dbPerSecondSlope(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sumT = 0, sumDb = 0, sumTT = 0, sumTDb = 0;
  for (const [t, db] of points) {
    sumT += t; sumDb += db; sumTT += t * t; sumTDb += t * db;
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return 0;
  return (n * sumTDb - sumT * sumDb) / denom;
}

/**
 * Stateful tracker across frames: matches candidates frame-to-frame by
 * bin proximity, and raises an alert once a track satisfies persistence
 * (3) plus the growing-or-stationary-without-harmonics rule (4).
 * Room-vs-mix corroboration (5) is applied by the caller, which has both
 * signals; see `crossCheckRoomVsMix`.
 */
export class FeedbackTracker {
  constructor(opts = {}) {
    this.opts = opts;
    this.minPersistS = opts.minPersistS ?? 0.5;
    this.stationaryPersistS = opts.stationaryPersistS ?? 2.0;
    this.growthSlopeDbPerS = opts.growthSlopeDbPerS ?? 1.0;
    this.binTolerance = opts.binTolerance ?? 1;
    this.trackTimeoutS = opts.trackTimeoutS ?? 0.3;
    this.tracks = []; // { bin, freq, history: [[t, db]], lastSeenT }
  }

  /**
   * @param {Float64Array|number[]} magnitudeDb
   * @param {number} binHz
   * @param {number} t seconds, monotonically increasing
   * @returns {object[]} newly or still-active alerts this frame
   */
  process(magnitudeDb, binHz, t) {
    const candidates = findPeakCandidates(magnitudeDb, binHz, this.opts);
    const unmatched = new Set(candidates.map((_, i) => i));

    for (const track of this.tracks) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (const i of unmatched) {
        const d = Math.abs(candidates[i].bin - track.bin);
        if (d <= this.binTolerance && d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const c = candidates[bestIdx];
        track.bin = c.bin;
        track.freq = c.freq;
        track.history.push([t, c.db]);
        track.lastSeenT = t;
        unmatched.delete(bestIdx);
      }
    }

    for (const i of unmatched) {
      const c = candidates[i];
      this.tracks.push({ bin: c.bin, freq: c.freq, history: [[t, c.db]], lastSeenT: t });
    }

    this.tracks = this.tracks.filter((tr) => t - tr.lastSeenT <= this.trackTimeoutS);

    const alerts = [];
    for (const track of this.tracks) {
      if (track.lastSeenT !== t) continue; // not present this frame
      const age = track.history[track.history.length - 1][0] - track.history[0][0];
      if (age < this.minPersistS) continue;

      const recentWindowS = 1.0;
      const recent = track.history.filter(([ht]) => t - ht <= recentWindowS);
      const slope = dbPerSecondSlope(recent);
      const growing = slope >= this.growthSlopeDbPerS;
      const stationaryLongEnough = age >= this.stationaryPersistS;

      const harmonics = hasHarmonicPartners(track.freq, magnitudeDb, binHz, this.opts);

      if (growing || (stationaryLongEnough && !harmonics)) {
        const latestDb = track.history[track.history.length - 1][1];
        alerts.push({
          freq: track.freq,
          note: freqToNoteName(track.freq),
          db: latestDb,
          ageS: age,
          slopeDbPerS: slope,
          reason: growing ? 'growing' : 'stationary-no-harmonics',
        });
      }
    }
    return alerts;
  }

  reset() {
    this.tracks = [];
  }
}

/**
 * Candidate 5: a feedback alert from the room mic is strongly corroborated
 * if the same frequency is much weaker in Main LR - that's acoustic
 * feedback, not musical content the mix is legitimately producing.
 */
export function crossCheckRoomVsMix(roomDb, mixDb, minDifferenceDb = 10) {
  return roomDb - mixDb >= minDifferenceDb;
}
