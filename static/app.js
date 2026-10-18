// Tab wiring, settings persistence, and the API client. This is the glue
// layer: it owns the Worker and CaptureManager, feeds their output to the
// ui/* render modules, and talks to the Flask server for anything that
// needs to survive a page reload (sessions, captures, channels, roast/ask).

import { CaptureManager, listAudioInputDevices } from './capture.js';
import { renderLufsMeter, renderPeakLamp, renderCorrelationMeter, renderSpeechMusicIndicator } from './ui/meters.js';
import { renderSpectrumBars, renderSplReadout } from './ui/spectrum-view.js';
import { AlertBanner } from './ui/alerts.js';
import { ChatPanel } from './ui/chat.js';
import { THIRD_OCTAVE_CENTERS } from './dsp/spectrum.js';

const SETTINGS_KEY = 'bf-settings';

const ROLE_HPF_DEFAULTS = {
  vocal: 100,
  'speech-mic': 120,
  kick: 40,
};

const DEFAULT_SETTINGS = {
  sqDeviceId: '',
  roomDeviceId: '',
  sqChannelCountIdeal: 4,
  splOffsetDb: null,
  roastIntervalS: 120,
  tone: 'blunt but kind',
  manualSpeechMusic: null,
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

async function loadTarget(name) {
  const resp = await fetch(`targets/${name}.json`);
  return resp.json();
}

class App {
  constructor() {
    this.settings = loadSettings();
    this.worker = new Worker('dsp-worker.js', { type: 'module' });
    this.capture = new CaptureManager({ worker: this.worker, onStatus: (info) => this.onCaptureStatus(info) });
    this.sessionId = null;
    this.selectedChannel = null;
    this.latestMixFeatures = null;
    this.latestRoomFeatures = null;
    this.targetsCache = {};

    this.alertBanner = new AlertBanner(document.getElementById('alert-banner'));
    this.chat = new ChatPanel(document.getElementById('chat-panel'));

    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);

    this._wireTabs();
    this._wireSettingsForm();
    this._wireSessionControls();
    this._wireRoastControls();
    this._wireChannelPicker();
    this._wireCapturesTab();

    setInterval(() => this.alertBanner.tick(), 500);
    setInterval(() => this._postSnapshots(), 10000);

    this.refreshChannelList();
    this._loadConfig();
  }

  async _loadConfig() {
    const resp = await fetch('/api/config');
    const config = await resp.json();
    document.getElementById('config-model').textContent = config.model;
    if (!localStorage.getItem(SETTINGS_KEY)) {
      this.settings.roastIntervalS = config.roastIntervalS;
      saveSettings(this.settings);
    }
  }

  _wireTabs() {
    const buttons = document.querySelectorAll('.tab-button');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        btn.classList.add('active');
      });
    });
  }

  async _wireSettingsForm() {
    const deviceSelectSq = document.getElementById('settings-sq-device');
    const deviceSelectRoom = document.getElementById('settings-room-device');
    const splInput = document.getElementById('settings-spl-offset');
    const roastIntervalInput = document.getElementById('settings-roast-interval');
    const toneInput = document.getElementById('settings-tone');
    const speechMusicSelect = document.getElementById('settings-speech-music');

    splInput.value = this.settings.splOffsetDb ?? '';
    roastIntervalInput.value = this.settings.roastIntervalS;
    toneInput.value = this.settings.tone;
    speechMusicSelect.value = this.settings.manualSpeechMusic || '';

    document.getElementById('settings-refresh-devices').addEventListener('click', async () => {
      const devices = await listAudioInputDevices();
      for (const sel of [deviceSelectSq, deviceSelectRoom]) {
        sel.innerHTML = '';
        for (const d of devices) {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || d.deviceId.slice(0, 8);
          sel.appendChild(opt);
        }
      }
      deviceSelectSq.value = this.settings.sqDeviceId;
      deviceSelectRoom.value = this.settings.roomDeviceId;
    });

    document.getElementById('settings-save').addEventListener('click', () => {
      this.settings.sqDeviceId = deviceSelectSq.value;
      this.settings.roomDeviceId = deviceSelectRoom.value;
      this.settings.splOffsetDb = splInput.value === '' ? null : parseFloat(splInput.value);
      this.settings.roastIntervalS = parseInt(roastIntervalInput.value, 10) || 120;
      this.settings.tone = toneInput.value;
      this.settings.manualSpeechMusic = speechMusicSelect.value || null;
      saveSettings(this.settings);
      this.worker.postMessage({ type: 'setSplOffset', offsetDb: this.settings.splOffsetDb });
      this.worker.postMessage({ type: 'setManualSpeechMusic', mode: this.settings.manualSpeechMusic });
      document.getElementById('settings-status').textContent = 'Saved.';
    });
  }

  _wireSessionControls() {
    const startBtn = document.getElementById('session-start');
    const endBtn = document.getElementById('session-end');
    endBtn.disabled = true;

    startBtn.addEventListener('click', async () => {
      const resp = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'service' }),
      });
      const body = await resp.json();
      this.sessionId = body.id;

      await this._ensureTargetsLoaded();
      await this.capture.start({
        sqDeviceId: this.settings.sqDeviceId,
        roomDeviceId: this.settings.roomDeviceId,
        sqChannelCountIdeal: this.settings.sqChannelCountIdeal,
      });
      this.worker.postMessage({ type: 'setSplOffset', offsetDb: this.settings.splOffsetDb });
      this.worker.postMessage({ type: 'setManualSpeechMusic', mode: this.settings.manualSpeechMusic });

      startBtn.disabled = true;
      endBtn.disabled = false;
      document.getElementById('session-status').textContent = `Session #${this.sessionId} running.`;
    });

    endBtn.addEventListener('click', async () => {
      if (!this.sessionId) return;
      await this.capture.stop();
      await fetch(`/api/sessions/${this.sessionId}/end`, { method: 'POST' });
      document.getElementById('session-status').textContent = `Session #${this.sessionId} ended.`;
      this.sessionId = null;
      startBtn.disabled = false;
      endBtn.disabled = true;
    });
  }

  async _ensureTargetsLoaded() {
    for (const name of ['mix-music', 'mix-speech', 'room']) {
      if (!this.targetsCache[name]) this.targetsCache[name] = await loadTarget(name);
      this.worker.postMessage({ type: 'setTargets', role: name, target: this.targetsCache[name] });
    }
  }

  _wireRoastControls() {
    const roastBtn = document.getElementById('roast-now');
    const roastEl = document.getElementById('roast-text');

    const runRoast = async () => {
      if (!this.latestMixFeatures) return;
      roastEl.textContent = '';
      const resp = await fetch('/api/roast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ window_features: this.latestMixFeatures, tone: this.settings.tone }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        roastEl.textContent = full;
      }
    };

    roastBtn.addEventListener('click', runRoast);
    setInterval(() => {
      if (this.sessionId) runRoast();
    }, this.settings.roastIntervalS * 1000);
  }

  async refreshChannelList() {
    const resp = await fetch('/api/channels');
    const channels = await resp.json();
    const picker = document.getElementById('channel-picker');
    picker.innerHTML = '<option value="">-- select --</option>';
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch.num;
      opt.textContent = `${ch.num}: ${ch.name} (${ch.role})`;
      opt.dataset.role = ch.role;
      picker.appendChild(opt);
    }
    this.channels = channels;
  }

  _wireChannelPicker() {
    const picker = document.getElementById('channel-picker');
    picker.addEventListener('change', async () => {
      const num = parseInt(picker.value, 10);
      const channel = (this.channels || []).find((c) => c.num === num);
      this.selectedChannel = channel || null;
      if (!channel) return;

      const targetKey = ROLE_HPF_DEFAULTS[channel.role] !== undefined ? channel.role : 'vocal';
      if (!this.targetsCache[targetKey]) {
        this.targetsCache[targetKey] = await loadTarget(targetKey).catch(() => this.targetsCache['vocal']);
      }
      const hpfHz = ROLE_HPF_DEFAULTS[channel.role] ?? 80;
      this.worker.postMessage({
        type: 'setTargets',
        role: 'pafl',
        target: { bands: this.targetsCache[targetKey].bands, hpfHz, key: targetKey },
      });
    });

    document.getElementById('capture-channel').addEventListener('click', async () => {
      if (!this.selectedChannel || !this.latestPaflFeatures) return;
      await fetch('/api/captures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          label: `${this.selectedChannel.name} capture`,
          channel: this.selectedChannel.num,
          source: 'channel',
          features: this.latestPaflFeatures,
        }),
      });
      document.getElementById('channel-status').textContent = 'Captured.';
    });

    document.getElementById('ask-channel').addEventListener('click', () => {
      const question = document.getElementById('ask-channel-input').value.trim();
      if (!question) return;
      document.getElementById('ask-channel-input').value = '';
      this.chat.ask(question, () => ({
        channel: this.selectedChannel,
        findings: this.latestPaflFeatures?.findings,
        live_features: this.latestPaflFeatures,
      }));
    });
  }

  _wireCapturesTab() {
    const listEl = document.getElementById('captures-list');
    const detailEl = document.getElementById('captures-detail');

    const refresh = async () => {
      const resp = await fetch('/api/captures');
      const captures = await resp.json();
      listEl.innerHTML = captures
        .map(
          (c) =>
            `<li data-id="${c.id}">#${c.id} - ${c.label || '(unlabelled)'} - ${c.source}${c.channel_num ? ' ch' + c.channel_num : ''} - ${new Date(c.ts * 1000).toLocaleString()}</li>`
        )
        .join('');
    };

    listEl.addEventListener('click', async (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const resp = await fetch(`/api/captures/${li.dataset.id}`);
      const capture = await resp.json();
      detailEl.textContent = JSON.stringify(capture, null, 2);
    });

    document.getElementById('captures-refresh').addEventListener('click', refresh);
    refresh();
  }

  onCaptureStatus(info) {
    const el = document.getElementById('capture-status');
    const line = `${info.source}: ${info.channelCount}ch @ ${info.sampleRate}Hz${info.multichannel === false ? ' (2ch cap - Chrome fallback)' : ''}`;
    el.textContent = el.textContent ? `${el.textContent}\n${line}` : line;
  }

  onWorkerMessage(msg) {
    if (msg.type === 'alert') {
      this.alertBanner.push(msg.role, msg.alert);
      fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          kind: 'feedback',
          freq: msg.alert.freq,
          detail: msg.alert,
        }),
      }).catch(() => {});
      return;
    }
    if (msg.type !== 'features') return;

    if (msg.role === 'mix') {
      this.latestMixFeatures = msg.features;
      this._renderMixTab(msg.features);
    } else if (msg.role === 'room') {
      this.latestRoomFeatures = msg.features;
      this._renderRoomTab(msg.features);
    } else if (msg.role === 'pafl') {
      this.latestPaflFeatures = msg.features;
      this._renderChannelTab(msg.features);
    }
  }

  _renderMixTab(features) {
    renderLufsMeter(document.getElementById('mix-lufs'), {
      momentary: features.lufsMomentary,
      shortTerm: features.lufsShortTerm,
      integrated: features.lufsIntegrated,
      targetLufs: features.speechMusic?.mode === 'speech' ? -23 : -16,
    });
    renderPeakLamp(document.getElementById('mix-peak'), features);
    renderCorrelationMeter(document.getElementById('mix-correlation'), features.correlation);
    if (features.speechMusic) renderSpeechMusicIndicator(document.getElementById('mix-speech-music'), features.speechMusic);
    const targetName = features.speechMusic?.mode === 'speech' ? 'mix-speech' : 'mix-music';
    renderSpectrumBars(document.getElementById('mix-spectrum'), {
      centers: THIRD_OCTAVE_CENTERS,
      bandsDb: features.bandsDb,
      targetDb: this.targetsCache[targetName]?.bands.map((b) => b.db),
    });
  }

  _renderRoomTab(features) {
    renderSpectrumBars(document.getElementById('room-spectrum'), {
      centers: THIRD_OCTAVE_CENTERS,
      bandsDb: features.bandsDb,
      targetDb: this.targetsCache['room']?.bands.map((b) => b.db),
    });
    renderSplReadout(document.getElementById('room-spl'), features.spl);
  }

  _renderChannelTab(features) {
    renderSpectrumBars(document.getElementById('channel-spectrum'), {
      centers: THIRD_OCTAVE_CENTERS,
      bandsDb: features.bandsDb,
      targetDb: this.targetsCache[this.selectedChannel?.role]?.bands.map((b) => b.db),
    });
    const list = document.getElementById('channel-findings');
    list.innerHTML = (features.findings || [])
      .map((f) => `<li>${f.type}: ${f.deviationDb ? f.deviationDb.toFixed(1) + 'dB' : ''} ${f.suggestion ? JSON.stringify(f.suggestion) : ''}</li>`)
      .join('');
  }

  _postSnapshots() {
    if (!this.sessionId) return;
    const ts = Date.now() / 1000;
    if (this.latestMixFeatures) this._postSnapshot('mix', this.latestMixFeatures, ts);
    if (this.latestRoomFeatures) this._postSnapshot('room', this.latestRoomFeatures, ts);
  }

  _postSnapshot(source, features, ts) {
    fetch('/api/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: this.sessionId, ts, source, features }),
    }).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.bellfounder = new App();
});
