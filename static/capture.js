// Opens audio devices, maps their channels to roles, and forwards blocks
// to the DSP worker. Supports both outcomes of the Phase 0 probe
// (PLAN.md section 2):
//
//  - Firefox multichannel: one SQ stream with >=4 channels gives Mix and
//    PAFL simultaneously (channels [0,1] and [2,3]).
//  - Chrome fallback: the SQ stream is capped at 2 channels, so only one
//    of Mix/PAFL is "live" at a time. setSqMode() re-tags (and, if
//    needed, re-opens) that single stream without touching Room, which is
//    always a separate device.
//
// Room (the Focusrite mic) is always its own device/stream, independent
// of whatever the SQ is doing.

const BLOCK_FRAMES = 2048;

class DeviceCapture {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.appliedSettings = null;
  }

  async open(deviceId, channelCountIdeal, onBlocks) {
    await this.close();

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: { ideal: channelCountIdeal },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 },
      },
      video: false,
    };

    this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.mediaStream.getAudioTracks()[0];
    this.appliedSettings = track.getSettings();

    this.audioCtx = new AudioContext({ sampleRate: this.appliedSettings.sampleRate || 48000 });
    await this.audioCtx.audioWorklet.addModule('worklet.js');

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
    const channelCount = this.sourceNode.channelCount;

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'bf-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { blockFrames: BLOCK_FRAMES },
    });
    this.workletNode.port.onmessage = (e) => onBlocks(e.data);
    this.sourceNode.connect(this.workletNode);

    return { appliedSettings: this.appliedSettings, channelCount, sampleRate: this.audioCtx.sampleRate };
  }

  async close() {
    if (this.workletNode) this.workletNode.port.onmessage = null;
    if (this.sourceNode) this.sourceNode.disconnect();
    if (this.mediaStream) this.mediaStream.getTracks().forEach((t) => t.stop());
    if (this.audioCtx) await this.audioCtx.close();
    this.audioCtx = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.workletNode = null;
  }
}

export class CaptureManager {
  /**
   * @param {object} opts
   * @param {Worker} opts.worker the DSP worker to forward blocks to
   * @param {(info: object) => void} [opts.onStatus] diagnostics: applied settings per source
   */
  constructor({ worker, onStatus }) {
    this.worker = worker;
    this.onStatus = onStatus || (() => {});
    this.sq = new DeviceCapture();
    this.room = new DeviceCapture();
    this.sqMode = 'mix'; // only meaningful when the SQ stream is capped at 2 channels
    this.sqMultichannel = false;
  }

  /**
   * @param {object} config
   * @param {string} config.sqDeviceId
   * @param {string} [config.roomDeviceId]
   * @param {number} [config.sqChannelCountIdeal] default 4 (Mix + PAFL)
   */
  async start(config) {
    if (config.sqDeviceId) {
      const info = await this.sq.open(config.sqDeviceId, config.sqChannelCountIdeal ?? 4, (data) =>
        this._onSqBlocks(data)
      );
      this.sqMultichannel = info.channelCount >= 4;
      this.onStatus({ source: 'sq', ...info, multichannel: this.sqMultichannel });
    }

    if (config.roomDeviceId) {
      const info = await this.room.open(config.roomDeviceId, 1, (data) => this._onRoomBlocks(data));
      this.onStatus({ source: 'room', ...info });
    }
  }

  /** Only has an effect when the SQ stream is 2-channel (Chrome cap). */
  setSqMode(mode) {
    this.sqMode = mode;
  }

  _onSqBlocks({ channelBlocks, sampleRate }) {
    const t = performance.now() / 1000;
    if (this.sqMultichannel) {
      this.worker.postMessage(
        { type: 'block', role: 'mix', channelBlocks: [channelBlocks[0], channelBlocks[1]], sampleRate, t },
        [channelBlocks[0].buffer, channelBlocks[1].buffer]
      );
      if (channelBlocks.length >= 4) {
        this.worker.postMessage(
          { type: 'block', role: 'pafl', channelBlocks: [channelBlocks[2], channelBlocks[3]], sampleRate, t },
          [channelBlocks[2].buffer, channelBlocks[3].buffer]
        );
      }
    } else {
      const role = this.sqMode === 'pafl' ? 'pafl' : 'mix';
      this.worker.postMessage(
        { type: 'block', role, channelBlocks, sampleRate, t },
        channelBlocks.map((b) => b.buffer)
      );
    }
  }

  _onRoomBlocks({ channelBlocks, sampleRate }) {
    const t = performance.now() / 1000;
    this.worker.postMessage(
      { type: 'block', role: 'room', channelBlocks, sampleRate, t },
      channelBlocks.map((b) => b.buffer)
    );
  }

  async stop() {
    await this.sq.close();
    await this.room.close();
  }
}

export async function listAudioInputDevices() {
  // Labels are empty until permission has been granted once.
  await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}
