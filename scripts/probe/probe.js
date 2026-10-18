// Phase 0 probe logic. Lists audio input devices, opens one with chosen
// constraints, reports what the browser actually gave us, and draws
// per-channel meters. See PLAN.md section 2 and Phase 0 for what this is
// trying to answer.

const els = {
  deviceSelect: document.getElementById('device'),
  channelCount: document.getElementById('channelCount'),
  refreshBtn: document.getElementById('refresh'),
  openBtn: document.getElementById('open'),
  closeBtn: document.getElementById('close'),
  applied: document.getElementById('applied'),
  meters: document.getElementById('meters'),
  log: document.getElementById('log'),
};

let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.prepend(line);
}

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  els.deviceSelect.innerHTML = '';
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `(unlabelled) ${d.deviceId.slice(0, 8)}`;
    els.deviceSelect.appendChild(opt);
  }
  log(`Found ${inputs.length} audio input device(s).`);
}

function renderMeters(channelCount) {
  els.meters.innerHTML = '';
  for (let i = 0; i < channelCount; i++) {
    const row = document.createElement('div');
    row.className = 'meter-row';
    row.innerHTML = `
      <span class="meter-label">ch ${i + 1}</span>
      <div class="meter-bar"><div class="meter-fill" id="fill-${i}"></div><div class="meter-peak" id="peak-${i}"></div></div>
      <span class="meter-db" id="db-${i}">-inf</span>
    `;
    els.meters.appendChild(row);
  }
}

function dbfs(x) {
  if (x <= 0) return -Infinity;
  return 20 * Math.log10(x);
}

function updateMeters(rms, peak) {
  for (let i = 0; i < rms.length; i++) {
    const fill = document.getElementById(`fill-${i}`);
    const peakEl = document.getElementById(`peak-${i}`);
    const dbEl = document.getElementById(`db-${i}`);
    if (!fill) continue;
    const dbRms = dbfs(rms[i]);
    const dbPeak = dbfs(peak[i]);
    const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    fill.style.width = `${pct(dbRms)}%`;
    peakEl.style.left = `${pct(dbPeak)}%`;
    dbEl.textContent = `${dbRms === -Infinity ? '-inf' : dbRms.toFixed(1)} dBFS`;
  }
}

async function open() {
  const deviceId = els.deviceSelect.value;
  const channelCount = parseInt(els.channelCount.value, 10) || 2;

  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: { ideal: channelCount },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48000 },
    },
    video: false,
  };

  log(`Requesting: ${JSON.stringify(constraints.audio)}`);

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    log(`getUserMedia failed: ${err.name}: ${err.message}`);
    return;
  }

  const track = mediaStream.getAudioTracks()[0];
  const settings = track.getSettings();
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};
  els.applied.textContent = JSON.stringify({ settings, capabilities }, null, 2);
  log(`Track applied settings: channelCount=${settings.channelCount}, sampleRate=${settings.sampleRate}`);

  audioCtx = new AudioContext({ sampleRate: settings.sampleRate || 48000 });
  await audioCtx.audioWorklet.addModule('worklet.js');

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  const actualChannels = sourceNode.channelCount;
  log(`AudioContext sampleRate=${audioCtx.sampleRate}, MediaStreamSource.channelCount=${actualChannels}`);

  workletNode = new AudioWorkletNode(audioCtx, 'probe-meter', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: actualChannels,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });

  workletNode.port.onmessage = (e) => {
    const { channelCount: cc, rms, peak } = e.data;
    if (document.querySelectorAll('.meter-row').length !== cc) {
      renderMeters(cc);
    }
    updateMeters(rms, peak);
  };

  sourceNode.connect(workletNode);

  els.openBtn.disabled = true;
  els.closeBtn.disabled = false;
}

function close() {
  if (workletNode) workletNode.port.onmessage = null;
  if (sourceNode) sourceNode.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  mediaStream = null;
  workletNode = null;
  sourceNode = null;
  els.meters.innerHTML = '';
  els.applied.textContent = '(closed)';
  els.openBtn.disabled = false;
  els.closeBtn.disabled = true;
  log('Closed.');
}

els.refreshBtn.addEventListener('click', () => listDevices().catch((e) => log(`enumerateDevices failed: ${e}`)));
els.openBtn.addEventListener('click', () => open().catch((e) => log(`open failed: ${e}`)));
els.closeBtn.addEventListener('click', close);

// Permission must be granted once before device labels are visible.
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((s) => {
    s.getTracks().forEach((t) => t.stop());
    return listDevices();
  })
  .catch((e) => log(`Initial permission request failed: ${e}`));
