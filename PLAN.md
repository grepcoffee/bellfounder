# Bellfounder - plan

Live sound analysis for the Allen & Heath SQ7 at front of house: watch the
main mix and the room while a service is running, catch feedback before it
howls, and let the operator ask "how should I EQ this channel?" and get an
answer built from real measurements, not guesses.

Named for the bell foundries that cast bells and then tune them by measuring
their overtones - the same job, for a mix.

Status: **Phase 0-1 scaffolding built, untested on real hardware.** The
probe page, DSP library (with unit tests), Flask server (with pytest
tests), Docker/compose setup, and the Mix/Room/Channel/Captures/Settings
browser UI all exist - see the repo for code. What's still unverified
because it needs the real Mac + SQ7 + Focusrite: the Phase 0 channel-count
question (section 2), and therefore whether the Chrome-fallback or
Firefox-multichannel capture path is the one actually used. Run the Phase
0 probe next. This document is kept for the design rationale and the
phased plan; once Phase 0-1 are validated at a real service, move
non-obvious implementation details to `ARCHITECTURE.md` and bugs to
`NOTES.md`.

---

## 1. Goals and non-goals

**Goals**
- Live, always-on analysis of the **main mix** (SQ7 Main LR) and the **room**
  (Focusrite + measurement mic): loudness, peaks/clipping, tonal balance
  against a target curve, dynamics, and feedback detection.
- **Per-channel analysis on demand** via the SQ's PAFL (solo) bus: solo a
  channel, see its spectrum and problems, ask questions in plain English, get
  concrete EQ moves back (frequency, gain, Q, HPF).
- **Captures**: save a 10-20s snapshot of a channel or the mix and come back to
  it later - ask about it after the service, compare before/after an EQ move,
  compare this week to last week.
- **Periodic "roast"** of the mix and an end-of-service summary, written by the
  stack's existing local Ollama.
- Runs entirely on hardware already in the building: the Mac mini at the desk
  needs only a browser; everything else lives on the Ubuntu box.

**Non-goals (for now)**
- **No writing to the console.** The tool advises; the operator turns the
  knobs. Read-only SQ integration at most. An app that moves faders during a
  live service is a different risk category.
- **Not a Smaart replacement.** No calibrated measurement-grade transfer
  function in v1 (see Phase 4 for an approximation).
- **No recording whole services.** Captures are short and explicit; the
  default stores *features*, not audio (see section 9, privacy).
- **No native Mac app.** The Mac has no dev tools and nothing gets installed
  on it (see section 3, alternatives rejected).

---

## 2. Hardware and signal routing

### SQ7 -> Mac mini (USB-B)

The SQ7's rear USB-B port is a class-compliant 32x32 Core Audio interface on
macOS - no driver. Patch on the desk under **I/O -> USB Audio outputs**:

| USB out | Source | Purpose |
|---|---|---|
| 1-2 | Main LR (post-processing) | Mix analysis - always on |
| 3-4 | PAFL L/R | Whatever channel is soloed - channel analysis |
| 5-8 | *(optional)* direct outs of key sources (pastor, lead vocal, kick, ...) | Only usable if the browser can read >2 channels - see below |

**PAFL setup**: in the SQ's PAFL settings, pick PFL tap pre-EQ for "what is
the mic actually giving me" and AFL for "what does my EQ'd channel sound
like". Soloing never touches Main LR, so the congregation hears nothing
different.

If there's a separate **livestream mix** (aux or matrix), it's worth adding
to the USB patch too - the stream mix is where loudness/clipping problems
actually reach people at home.

### Focusrite -> Mac mini (room mic)

- Measurement mic (e.g. ECM8000) on input 1, 48V on, **Air off**.
- Placement: in the seating area, roughly 2/3 back and off-centre, ear
  height, away from walls - not in front of a speaker.
- Set gain so a loud song peaks around -12 dBFS, then **never touch it**.
  Every room reading depends on that gain staying fixed.
- Optional one-time calibration: SPL meter next to the mic, note the offset,
  enter it in settings - the Room tab then shows real dB SPL.

### Mac mini settings

- Audio MIDI Setup: SQ and Focusrite at the same sample rate as the desk
  (48 kHz recommended).
- Energy settings: never sleep while the analyzer is open; keep the tab in
  the foreground (browsers throttle background tabs).

### The browser channel-count question (decides a lot)

- **Chrome caps `getUserMedia` at 2 channels.** On Chrome the page can only
  read USB 1-2 of the SQ - so Main LR and PAFL can't run at the same time
  unless one of them moves to channels 1-2 on demand.
- **Firefox honours `channelCount` > 2.** If Firefox on the Mac exposes all of
  USB 1-8 from the SQ, Main LR + PAFL + direct outs all run at once, and
  Firefox becomes the recommended browser.
- **macOS Aggregate Device.** An aggregate of SQ + Focusrite appears to the
  browser as *one* device on a shared clock - the only browser-friendly way
  to get sample-aligned console and room signals (Phase 4).

**Phase 0 exists to answer this on the real Mac before anything else is
built.** Design the capture layer so either answer works:
- **Firefox multichannel**: one stream, N channels, each assigned a role.
- **Chrome fallback**: a "Mix / Channel" source switch, where the operator
  re-patches PAFL onto USB 1-2 or switches which device/stream is active.

---

## 3. Architecture

```
 Mac mini (browser tab, no installs)                 Ubuntu box (Docker)         
 ┌──────────────────────────────────────┐            ┌─────────────────────────────────┐
 │ SQ7 USB ─┐                           │            │ bellfounder (Flask)             │
 │ Focusrite┴► AudioWorklet capture     │  HTTPS     │  - serves the page (same origin)│
 │            └► DSP worker (pure JS)   │──────────► │  - sessions / snapshots / captures (SQLite)
 │               loudness, spectrum,    │ JSON every │  - /api/ask, /api/roast ──────► Ollama (host, qwen2.5:7b)
 │               feedback, channel feat.│ ~10s, plus │  - SQ7 TCP link (Phase 3) ────► SQ7 :51325 (LAN)
 │            └► UI (canvas meters,     │ on-demand  │  - /health                      │
 │               chat, alerts)          │            └─────────────────────────────────┘
 └──────────────────────────────────────┘
```

### Who does what

- **All DSP in the browser on the Mac.** Raw audio never crosses the network,
  only small feature summaries. The meters keep working if the network or
  the Ubuntu box drops - feedback alerts are 100% local.
- **The Ubuntu service holds everything that needs a server:**
  - persistence (sessions, captures, channel list, settings)
  - building the prompts and calling Ollama
  - the TCP connection to the SQ7. This is the hard reason a backend must
    exist: a browser can't open a raw TCP socket.
- **Same origin.** The service serves the page *and* the API, so there's no
  CORS, no mixed content, and only one port to put HTTPS in front of. Ollama
  is never called from the browser.

### Relationship to foundry-stack

Bellfounder is its **own project, repo and Compose file** - not a service
inside foundry-stack. The two happen to share the Ubuntu box, and the only
thing Bellfounder uses from it is **Ollama**, reached by URL
(`OLLAMA_URL`). Nothing else is shared: no network, volumes, bootstrap or
dashboard.

- If foundry-stack already runs there, Ollama is already installed, already
  bound to `0.0.0.0` (its README's Linux steps) and `qwen2.5:7b` is already
  pulled - Bellfounder needs nothing extra.
- Without foundry-stack: install Ollama natively, apply the same `OLLAMA_HOST=0.0.0.0`
  systemd override (plain Docker Engine containers can't reach a
  loopback-only Ollama), then `ollama pull qwen2.5:7b`.
- Optional, later, and done from the foundry-stack side if wanted: a link card
  on its dashboard and an Uptime Kuma monitor pointing at Bellfounder's
  `/health`. Bellfounder never depends on them.

### Alternatives considered and rejected

- **Native Swift Mac app built by GitHub Actions.** Best audio access (all 32
  channels, AVAudioEngine), but:
  - it's unsigned without a $99/yr developer account, so Gatekeeper blocks
    every update
  - microphone permission resets on each build
  - it sits outside the stack's deploy, monitoring and backup story
  
  Revisit only if the browser channel limits turn out to be a dead end.
- **Capture on the Ubuntu box directly** (SQ USB into Ubuntu). The Ubuntu box
  isn't at the desk, and the Mac is already cabled. Dante/AES67 into the
  Ubuntu box would solve this properly but needs a Dante card - out of scope.
- **Python capture script on the Mac.** It needs Python and pip on the Mac,
  which counts as dev tools.
- **Stream raw audio to the server for analysis.** It burns LAN bandwidth,
  adds latency to feedback alerts, and the browser can do the math fine.

---

## 4. Browser app

**No build step, no framework, no CDN.** Vanilla ES modules served as static
files. The booth may have flaky internet, so the page must
work with only the LAN.

### Module layout

```
bellfounder/static/
  index.html            Tabs: Mix | Channel | Room | Captures | Settings
  app.js                Wiring, tab state, API client
  capture.js            getUserMedia + AudioWorklet, device/channel role mapping
  worklet.js            AudioWorkletProcessor: copies frames to a SharedArrayBuffer ring (or posts blocks)
  dsp/                  PURE functions, no DOM - so Node can unit-test them
    fft.js              Radix-2 real FFT (own implementation, ~100 lines)
    loudness.js         BS.1770 K-weighting, momentary/short-term/integrated LUFS, true peak
    spectrum.js         FFT -> 1/3-octave bands, fast/slow averaging, target-curve deviation
    feedback.js         Feedback candidate detector
    features.js         Crest factor, centroid/tilt, correlation, band energy summaries
    classify.js         Speech vs music heuristic
    channel.js          Per-channel "findings" (mud, boxy, harsh, sibilance, HPF residual, resonances)
  ui/
    meters.js spectrum-view.js alerts.js chat.js
  targets/*.json        Target curves: mix-music, mix-speech, vocal, speech-mic, kick, room...
```

### Capture

- `getUserMedia` with `echoCancellation`, `noiseSuppression` and
  `autoGainControl` all **false**, plus `deviceId` (chosen in Settings,
  remembered in localStorage) and `channelCount`. The constraints the browser
  actually applied are shown in Settings, so silent downmixing is visible.
- The AudioWorklet copies blocks into a ring buffer, and a Web Worker runs
  the DSP so UI rendering never stalls analysis.
- **Channel roles** are mapped in Settings: e.g. device "SQ" ch 1-2 -> Mix,
  ch 3-4 -> PAFL; device "Scarlett" ch 1 -> Room.
- Sample rate is taken from the AudioContext (match the desk, 48k).

### DSP - what's measured and how

| Feature | Method | Update rate |
|---|---|---|
| Momentary / short-term / integrated LUFS | BS.1770-4: two-biquad K-weighting, 400 ms / 3 s windows, integrated with absolute (-70) + relative (-10 LU) gating | 10 Hz / per session |
| True peak, clip count | 4x polyphase oversampling; count samples at or above -0.1 dBFS | 10 Hz |
| Crest factor, PLR | Peak-to-RMS over 3 s; true peak minus short-term LUFS | 1 Hz |
| Spectrum | 8192-pt FFT (5.9 Hz bins at 48k), Hann, 50% overlap | ~10 Hz |
| 1/3-octave bands | 31 bands, 20 Hz-20 kHz, energy-summed from FFT bins; fast (125 ms) and slow (1 s) exponential averaging | 10 Hz |
| Target deviation | Slow bands minus target curve, after normalising both to equal energy in 250 Hz-4 kHz so overall level doesn't count as "tonal" | 1 Hz |
| Centroid / tilt | Spectral centroid; least-squares slope of dB vs log-freq | 1 Hz |
| Stereo correlation | Pearson L/R over 400 ms | 10 Hz |
| Speech vs music | Heuristic: 4 Hz modulation energy + spectral flux + low-band energy; manual override always wins | 1 Hz |

### Feedback detector (the most valuable live feature - get it right)

A **candidate** is an FFT peak that:
1. stands ≥ 12-15 dB above the median of its ±1/3-octave neighbourhood
   (peak-to-neighbour ratio)
2. is narrow, with a -3 dB width under ~1/12 octave
3. persists in the same bin (±1) for ≥ 0.5 s
4. is **growing** (positive dB/s slope over the window) **or** is
   stationary for ≥ 2 s with no harmonic partners
   
   Real tones from instruments and voices carry harmonics; ringing usually
   doesn't. This check is what separates feedback from held vocal notes and
   synth pads.
5. *(Room mic only)* is present in the room signal but much weaker in Main
   LR, which is strong evidence it's acoustic feedback rather than musical
   content.

**Output:** an alert banner with the frequency, the nearest note name, a
suggested notch (e.g. "-6 dB at 2.52 kHz, Q 8") and which input showed it
first. Alerts never wait on the LLM. Thresholds go in Settings, and every
alert is logged with a short feature trace so false positives can be tuned
afterwards.

### Channel findings (PAFL)

Computed against the target curve for the channel's **role** (vocal, speech,
kick, snare, acoustic guitar, keys, bass...), then turned into a short list
of facts:
- **Rumble:** energy below the HPF zone (e.g. < 80 Hz on a vocal) -> HPF
  suggestion
- **Low-mids:** mud (200-500 Hz), boxy (500 Hz-1 kHz), honk (1-2 kHz)
- **Highs:** harsh (2-5 kHz), sibilance (5-9 kHz, transient-weighted), air
  (> 10 kHz)
- **Resonances:** the top 3 narrow peaks (frequency, height, width)
- **Dynamics:** crest factor and short-term loudness range - is it over- or
  under-compressed?

**Pre vs post:** with PFL pre-EQ captured and AFL captured, the findings
diff shows whether the EQ fixed what it was meant to.

### UI

- **Dark theme by default.** It's a booth: large type, high contrast,
  readable from arm's length on the Mac's display. No tiny text.
- **Mix tab:**
  - LUFS meter (momentary, short-term, integrated) with the target band
  - peak/clip lamp
  - 1/3-octave bars over the target curve
  - correlation meter
  - speech/music indicator
  - roast panel, plus a feedback banner across all tabs
- **Channel tab:**
  - channel picker, from a list typed in once with name, number and role
  - live spectrum vs role target, findings list, Capture button
  - chat ("Why does the pastor sound boxy?")
- **Room tab:** room spectrum and SPL (if calibrated), plus room minus Main LR
  band difference (approximate until Phase 4).
- **Captures tab:** list, open, compare two, ask about one.
- **Settings tab:**
  - devices and channel roles
  - Ollama model (read from the server)
  - targets: LUFS for music and speech, max SPL
  - feedback thresholds
  - roast interval and tone ("blunt but kind" ... "drill sergeant")

---

## 5. Server: `bellfounder` service

**Flask + requests** - small, boring, easy to maintain. SQLite on a named volume. Stdlib `socket` for the SQ
link.

### Endpoints

```
GET  /                      Static page
GET  /health                For the compose healthcheck (and any external monitor)
GET  /api/config            Model name, roast interval, feature flags (SQ link on/off)

GET/PUT /api/channels       [{num, name, role, notes}] - the channel list
POST /api/sessions          Start a service/rehearsal session -> {id}
POST /api/sessions/:id/end  Close it; triggers summary generation
POST /api/snapshots         {session_id, ts, source: mix|room|channel, features:{...}}  (every ~10s)
GET  /api/sessions/:id      Session + aggregate stats (+ summary when ready)

POST /api/captures          {session_id?, label, channel?, source, features, [wav: optional]}
GET  /api/captures[/:id]    List / detail
POST /api/ask               {question, context:{source, channel?, capture_ids?[], live_features?}, history[]}
POST /api/roast             {session_id, window_features}
GET  /api/sq/state          (Phase 3) faders/mutes/pans as last read from the console
```

### Data model (SQLite)

- `channels`: num, name, role, notes
- `sessions`: id, started, ended, kind (service/rehearsal), summary_text
- `snapshots`: session_id, ts, source, features_json - about 360 per source
  per hour. Small, and kept forever by default.
- `captures`: id, session_id, ts, label, channel_num, source, features_json,
  wav_path (nullable)
- `alerts`: session_id, ts, kind (feedback/clip/loudness), freq, detail_json
- `qa`: question, answer, context_json, model, latency_ms. Kept for tuning
  prompts.

### LLM usage - the part that needs discipline

**Facts in, advice out.**
- The browser sends computed *findings*, never raw spectra.
- The server builds a compact fact sheet: channel name and role, current
  findings with numbers, the operator's stated current EQ if any, target LUFS
  and current loudness.
- The system prompt makes the model:
  - use only frequencies and amounts traceable to those facts
  - give at most 3 actions, each `{band/HPF, freq Hz, gain dB, Q, why}`
  - say "nothing obvious to fix" when that's the truth

**Model:** `BF_MODEL`, default `qwen2.5:7b` (already on the box if
foundry-stack is installed there).

**CPU-only host.** The Ubuntu box has no GPU, so
generation runs at a few tokens per second:
- Cap `num_predict` at about 250, use temperature about 0.4, and stream the
  response to the UI so the first words appear quickly.
- Single-flight: one LLM call in flight, newest request wins, and a roast
  never queues behind a question.
- Default roast interval of **2 minutes**, plus on-demand. 30 s is too
  aggressive on CPU and competes with the Slack bot and AnythingLLM during
  the very hours they're also used (Sunday morning).
- Measure real latency in Phase 1 and tune from there.

**Grounding (Phase 4, optional):** foundry-stack's AnythingLLM already holds
ingested audio engineering reference books. Bellfounder could optionally
call AnythingLLM's chat API (`ANYTHINGLLM_URL` + API key) for answers that
cite them - an opt-in integration, off by default, and only useful once that
stack can keep sound material in its own workspace.

### SQ7 network link (Phase 3)

- TCP to `SQ_HOST:51325`. A&H's SQ MIDI protocol: no auth on plain TCP, and
  NRPN for levels, pan, mutes and assignments.
- **Unverified:** whether the protocol can *read back* EQ settings or channel
  names. An older community reading of the doc says no EQ access, and the
  name feature found so far goes DAW -> console only. The Phase 3 spike
  checks the current protocol PDF for the console's firmware before any code
  depends on it.
- **Value even if it's limited to faders and mutes:**
  - "vocal 2 is muted but its mic is hot in the room"
  - "pastor fader at -25, which is why speech LUFS is low"
  - the fader state saved with each capture
- **Strictly read-only:** the client never sends set-value NRPNs. The
  connection is optional and the page works without it.

### `docker-compose.yml` (sketch)

```yaml
services:
  bellfounder:
    build: .
    container_name: bellfounder
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"   # plain Docker Engine needs this to reach host Ollama
    environment:
      - OLLAMA_URL=${OLLAMA_URL:-http://host.docker.internal:11434}
      - BF_MODEL=${BF_MODEL:-qwen2.5:7b}
      - SQ_HOST=${SQ_HOST:-}                   # empty = SQ link disabled
      - SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL:-}   # empty = no Slack summary
    volumes:
      - bellfounder_data:/data
    ports:
      - "8095:8095"
    mem_limit: 256m
    cpus: 0.5
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8095/health || exit 1"]
volumes:
  bellfounder_data:
```

Port 8095 is clear of everything foundry-stack maps. Backups: the
`bellfounder_data` volume holds everything worth keeping (SQLite + any
opted-in WAVs); a `backup.sh` tars it.

### Repo layout

```
bellfounder/
  README.md  PLAN.md  LICENSE  .env.example  .gitignore
  docker-compose.yml  Dockerfile  requirements.txt
  app.py                 Flask app: static page + /api/*
  server/                db.py, llm.py (Ollama client, prompts, single-flight), sq.py (Phase 3)
  static/                the browser app (section 4)
  tests/                 js/ (node --test, DSP) and py/ (pytest, server)
  scripts/               test.sh, backup.sh, probe/ (Phase 0 page)
```

## 6. HTTPS (required for audio input)

Browsers only expose audio input on secure origins, so plain
`http://ubuntu-box:8095` will load the page but see no devices.

| Option | Effort | Use |
|---|---|---|
| Browser override: Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure`; Firefox `about:config` `media.devices.insecure.enabled` + `media.getusermedia.insecure.enabled` | 2 min on the Mac | Phases 0-1 testing |
| **Tailscale** on both machines + `tailscale serve --https=443 http://localhost:8095` on Ubuntu | ~15 min, Mac install is a normal app | **Recommended long-term** - real cert, no cert management |
| Caddy `tls internal` / mkcert on Ubuntu, root cert trusted in the Mac's Keychain | ~30 min, renewal care | If Tailscale isn't acceptable |

The docs for whichever is chosen go in the README, the same way as "Deploying
to a Linux host".

---

## 7. Phased delivery

Each phase ends with something usable at the desk and a short report back
from a real service or rehearsal before the next one starts.

### Phase 0 - Probe (hours)
A single static page: list audio inputs, open one with chosen constraints,
show applied settings (`channelCount`, `sampleRate`, processing flags), and
show per-channel RMS/peak meters.

**Run on the Mac in Chrome and Firefox** to answer:
- How many SQ channels does each browser expose?
- Is it clean, i.e. no processing or resampling?
- Do both devices open at once?
- Does an Aggregate Device work?

**Done when** we know which capture design (section 2) we're building.

### Phase 1 - Mix + Room MVP
- the `bellfounder` service with health, config, sessions, snapshots, roast
  and SQLite
- compose file, `.env.example`, backup script, README setup guide
- **Mix tab:**
  - LUFS (M/S/I), true peak and clip, 1/3-octave vs target, correlation
  - speech/music toggle (manual first, heuristic shown as a hint)
- **Room tab:** spectrum, SPL with calibration offset
- **Feedback detector** on Mix and Room, with alerts and an alert log
- **Roast:** every 2 min and on demand; end-of-session summary

**Done when** a full service runs without:
- the tab stalling
- more than about 1 false feedback alert per service
- a roast taking over 30 s to start streaming

### Phase 2 - Channels
- **Channel list setup:** name, number and role
- **Channel tab:**
  - PAFL source (Firefox multichannel, or Chrome source switch)
  - findings vs role target
  - Capture button
- **Chat:** `/api/ask` with live or captured context, streamed answers
- **Captures tab:** compare two captures (pre/post, week/week)

**Done when** soloing the pastor's mic and asking "what should I change?"
gives a specific, measurement-backed EQ suggestion that the operator agrees
is sensible.

### Phase 3 - SQ link + more channels
- **Spike:** check the SQ MIDI protocol PDF for the desk's firmware; connect
  read-only and log NRPN traffic while moving faders and mutes
- if the spike succeeds: `/api/sq/state`, fader and mute context in prompts
  and captures, and "muted but hot" warnings
- if Phase 0 says Firefox multichannel works: direct-out channels analysed
  continuously, not just via PAFL

### Phase 4 - Nice-to-haves
- **Console vs room comparison:**
  - Aggregate Device for a shared clock
  - delay estimate via GCC-PHAT cross-correlation
  - coherence-weighted band difference, i.e. what the room adds at each
    frequency
- **Slack:** end-of-service summary posted to a Slack incoming webhook
  (`SLACK_WEBHOOK_URL`) - no bot, no n8n dependency
- **AnythingLLM grounding** for `/api/ask`, if topic separation lands
- **Trends:** loudness and tonal balance across weeks

---

## 8. Testing

There's no SQ7 in CI and no browser at the desk during development, so:

- **DSP unit tests in Node** (`node --test`, run as
  `docker run --rm -v .:/w node:22-alpine ...` so the Ubuntu
  host needs no Node install). The `dsp/` modules are pure on purpose.
  - **Loudness:** EBU Tech 3341 test signals (e.g. 1 kHz sine at -23 dBFS ->
    -23.0 LUFS ±0.1). Generate the signals in the test rather than vendoring
    WAVs.
  - **True peak:** EBU Tech 3341 inter-sample peak cases.
  - **Spectrum:** pink noise -> flat 1/3-octave bands within ±1 dB; a sine
    lands in the right band.
  - **Feedback must trigger:**
    - a sine at 2.5 kHz rising 3 dB/s mixed into pink noise -> alert within
      1 s, at the right frequency
    - a stationary pure tone with no harmonics -> alert within ~2.5 s
  - **Feedback must not trigger:** a harmonic stack (sung note: f, 2f, 3f
    with decay); chord pads; a speech-like modulated noise.
- **Server tests:** pytest against Flask's test client with a stub Ollama
  (no model calls in tests). Covers prompt construction, single-flight
  behaviour and SQLite round-trips.
- **`scripts/test.sh`** runs the Node and pytest suites in containers, so
  the Ubuntu box needs nothing but Docker.
- **At the desk:** a short rehearsal checklist per phase:
  - meters respond on both inputs
  - a deliberately induced ring is caught, with a monitor wedge pushed
    gently in rehearsal and never during a service
  - roast latency is acceptable
  - the tab survives 90 minutes

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Chrome's 2-channel cap | Phase 0 tests Firefox first; Chrome source-switch fallback designed in |
| Two devices = two clocks (SQ vs Focusrite) | v1 analyses each independently (no alignment needed); Aggregate Device for Phase 4 |
| Browser "voice processing" silently on | Constraints forced off **and** applied settings displayed; Phase 0 verifies |
| Tab throttled / Mac sleeps mid-service | Foreground tab + no-sleep setting in setup docs; a Web Lock / visible "analysis paused" banner if `document.hidden` |
| CPU-only Ollama is slow, competes with Slack bot on Sundays | Short outputs, streaming, single-flight, 2-min roast default; feedback alerts never use the LLM |
| LLM invents EQ numbers | Facts-only prompts, structured output, "nothing to fix" allowed; Q&A log for review |
| False feedback alerts erode trust | Conservative defaults, harmonic check, alert log with traces for tuning, per-session snooze |
| Target curves are taste, not truth | Curves are JSON, editable in Settings; findings phrased as "vs target", not "wrong" |
| Privacy - captures can contain prayer, pastoral words, people's voices | Captures store features only by default; WAV storage is an explicit per-capture opt-in, with a retention setting (default 30 days) |
| No auth on the service | LAN/Tailscale-only; documented. Tailscale also limits who can reach it |
| SQ protocol can't read EQ/names | Phase 3 spike before relying on it; operator-entered EQ and names work regardless |

---

## 10. Open questions (need answers from the operator)

1. **Ubuntu box:** is Ollama on it (it is if foundry-stack runs there), and roughly how
   fast is `qwen2.5:7b` there (tokens/sec)? This sets the roast interval.
2. **Mac mini:** Apple Silicon or Intel, which macOS version, and is Firefox
   acceptable as the booth browser if it unlocks multichannel?
3. **SQ7:** firmware version (for the MIDI protocol doc), and is it on the
   same LAN as the Ubuntu box?
4. **Stream mix:** is there a separate livestream mix to analyse alongside
   Main LR?
5. **Roughly how many channels** matter for per-channel analysis, and their
   roles? This seeds the channel list and the target curves.
6. **Who runs it:** a regular engineer or rotating volunteers? This sets how
   much the UI explains, and how spicy the roast is allowed to be.
7. **HTTPS:** OK with Tailscale on both machines?
