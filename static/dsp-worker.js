// Web Worker: runs all the DSP pipelines so UI rendering on the main
// thread never stalls analysis (PLAN.md section 4). Receives raw channel
// blocks tagged by role ('mix' | 'pafl' | 'room') and posts back computed
// features at a UI-friendly rate (~10Hz), plus feedback alerts immediately
// since those must never wait.

import { LoudnessMeter, truePeak, linearToDb } from './dsp/loudness.js';
import { magnitudeSpectrum, toThirdOctaveBands, toDb, expSmooth, targetDeviation, THIRD_OCTAVE_CENTERS } from './dsp/spectrum.js';
import { FeedbackTracker, crossCheckRoomVsMix } from './dsp/feedback.js';
import { crestFactorDb, stereoCorrelation, spectralCentroid, spectralTilt } from './dsp/features.js';
import { SpeechMusicClassifier, classify } from './dsp/classify.js';
import { channelFindings } from './dsp/channel.js';

const FFT_SIZE = 8192;

const state = {
  mix: null,
  pafl: null,
  room: null,
  targets: {}, // role -> { bands: [{freqHz, db}] }
  manualSpeechMusic: null,
  spLOffsetDb: null,
  lastRoomDb: null,
  lastMixDb: null,
};

function makeRoleState(role) {
  return {
    role,
    sampleRate: null,
    loudness: null,
    feedbackTracker: new FeedbackTracker({}),
    classifier: role === 'mix' ? new SpeechMusicClassifier({ frameRateHz: 10 }) : null,
    fftWindow: null, // most recent FFT_SIZE samples of channel 0, for spectrum analysis
    fastBandsDb: null,
    slowBandsDb: null,
    lastAnalysisT: 0,
    sessionStartT: null,
  };
}

function ensureRole(role, sampleRate, channelCount) {
  let s = state[role];
  if (!s || s.sampleRate !== sampleRate || s.loudness.numChannels !== channelCount) {
    s = makeRoleState(role);
    s.sampleRate = sampleRate;
    s.loudness = new LoudnessMeter(sampleRate, new Array(channelCount).fill(1));
    state[role] = s;
  }
  return s;
}

function pushFftWindow(roleState, channelBlocks) {
  const ch0 = channelBlocks[0];
  if (!roleState.fftWindow) roleState.fftWindow = new Float64Array(FFT_SIZE);
  const n = ch0.length;
  if (n >= FFT_SIZE) {
    roleState.fftWindow.set(ch0.subarray(n - FFT_SIZE));
  } else {
    roleState.fftWindow.copyWithin(0, n);
    roleState.fftWindow.set(ch0, FFT_SIZE - n);
  }
}

function targetDbForRole(role) {
  const t = state.targets[role];
  if (!t) return THIRD_OCTAVE_CENTERS.map(() => 0);
  return t.bands.map((b) => b.db);
}

function processBlock(role, channelBlocks, sampleRate, t) {
  const s = ensureRole(role, sampleRate, channelBlocks.length);
  if (s.sessionStartT === null) s.sessionStartT = t;

  s.loudness.process(channelBlocks);
  pushFftWindow(s, channelBlocks);

  const { magnitude, binHz } = magnitudeSpectrum(s.fftWindow, sampleRate);
  const bandsPower = toThirdOctaveBands(magnitude, binHz);
  const now = t;
  const dt = s.lastAnalysisT ? now - s.lastAnalysisT : 0.1;
  s.lastAnalysisT = now;
  s.fastBandsDb = toDb(expSmooth(s.fastBandsDb, bandsPower, 0.125, dt));
  s.slowBandsDb = toDb(expSmooth(s.slowBandsDb, bandsPower, 1.0, dt));

  const magDb = toDb(Float64Array.from(magnitude, (m) => m * m));
  const alerts = s.feedbackTracker.process(magDb, binHz, now);
  for (const alert of alerts) {
    postMessage({ type: 'alert', role, alert });
  }

  const peakLinear = truePeak(channelBlocks[0]);
  const clipCount = channelBlocks[0].reduce((acc, v) => acc + (Math.abs(v) >= 0.977 ? 1 : 0), 0); // -0.1dBFS

  const features = {
    role,
    t: now,
    lufsMomentary: s.loudness.getMomentaryLUFS(),
    lufsShortTerm: s.loudness.getShortTermLUFS(),
    lufsIntegrated: s.loudness.getIntegratedLUFS(),
    truePeakDb: linearToDb(peakLinear),
    clipCount,
    crestFactorDb: crestFactorDb(channelBlocks[0]),
    bandsDb: Array.from(s.slowBandsDb),
    bandsFastDb: Array.from(s.fastBandsDb),
  };

  if (channelBlocks.length >= 2) {
    features.correlation = stereoCorrelation(channelBlocks[0], channelBlocks[1]);
  }

  if (role === 'mix') {
    const classifierResult = s.classifier.process(magnitude, binHz);
    const mode = classify(classifierResult.score, state.manualSpeechMusic);
    features.speechMusic = mode;
    const targetDb = targetDbForRole(mode.mode === 'speech' ? 'mix-speech' : 'mix-music');
    features.targetDeviationDb = Array.from(targetDeviation(Array.from(s.slowBandsDb), targetDb));
    state.lastMixDb = s.slowBandsDb;
  }

  if (role === 'room') {
    if (typeof state.spLOffsetDb === 'number') {
      const rms = Math.sqrt(channelBlocks[0].reduce((acc, v) => acc + v * v, 0) / channelBlocks[0].length);
      features.spl = linearToDb(rms) + state.spLOffsetDb;
    }
    features.targetDeviationDb = Array.from(targetDeviation(Array.from(s.slowBandsDb), targetDbForRole('room')));
    state.lastRoomDb = s.slowBandsDb;

    // Cross-check room-only feedback candidates against the mix, if we have both.
    if (state.lastMixDb) {
      for (const alert of alerts) {
        const bandIdx = THIRD_OCTAVE_CENTERS.reduce(
          (best, f, i) => (Math.abs(f - alert.freq) < Math.abs(THIRD_OCTAVE_CENTERS[best] - alert.freq) ? i : best),
          0
        );
        alert.corroboratedByRoom = crossCheckRoomVsMix(state.lastRoomDb[bandIdx], state.lastMixDb[bandIdx]);
      }
    }
  }

  if (role === 'pafl') {
    const hpfHz = state.targets.pafl?.hpfHz ?? 80;
    const targetDb = targetDbForRole(state.targets.pafl?.key ?? 'vocal');
    const deviationDb = targetDeviation(Array.from(s.slowBandsDb), targetDb);
    const { findings, resonances } = channelFindings({
      deviationDb,
      magnitude,
      binHz,
      hpfHz,
      crestFactorDb: features.crestFactorDb,
    });
    features.findings = findings;
    features.resonances = resonances;
  }

  postMessage({ type: 'features', role, features });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'block') {
    processBlock(msg.role, msg.channelBlocks, msg.sampleRate, msg.t);
  } else if (msg.type === 'setTargets') {
    state.targets[msg.role] = msg.target;
  } else if (msg.type === 'setManualSpeechMusic') {
    state.manualSpeechMusic = msg.mode; // 'speech' | 'music' | null
  } else if (msg.type === 'setSplOffset') {
    state.spLOffsetDb = msg.offsetDb;
  } else if (msg.type === 'reset') {
    state[msg.role] = null;
  }
};
