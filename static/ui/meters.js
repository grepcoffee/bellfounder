// Simple DOM meters: LUFS, true peak/clip lamp, correlation. No canvas
// needed here - a handful of divs with widths driven by inline style is
// plenty readable from arm's length (PLAN.md's "dark theme, large type"
// requirement) and needs no dependencies.

function fmt(x, digits = 1) {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '--';
}

/** @param {HTMLElement} el @param {{momentary:?number, shortTerm:?number, integrated:?number, targetLufs:?number}} data */
export function renderLufsMeter(el, data) {
  const { momentary, shortTerm, integrated, targetLufs } = data;
  const pct = (lufs) => {
    if (typeof lufs !== 'number') return 0;
    // Map -40..0 LUFS onto 0..100%.
    return Math.max(0, Math.min(100, ((lufs + 40) / 40) * 100));
  };
  el.innerHTML = `
    <div class="lufs-row"><span class="lufs-label">M</span><div class="lufs-bar"><div class="lufs-fill" style="width:${pct(momentary)}%"></div></div><span class="lufs-value">${fmt(momentary)}</span></div>
    <div class="lufs-row"><span class="lufs-label">S</span><div class="lufs-bar"><div class="lufs-fill" style="width:${pct(shortTerm)}%"></div></div><span class="lufs-value">${fmt(shortTerm)}</span></div>
    <div class="lufs-row"><span class="lufs-label">I</span><div class="lufs-bar"><div class="lufs-fill" style="width:${pct(integrated)}%"></div></div><span class="lufs-value">${fmt(integrated)}</span></div>
    ${typeof targetLufs === 'number' ? `<div class="lufs-target">target ${fmt(targetLufs)} LUFS</div>` : ''}
  `;
}

/** @param {HTMLElement} el @param {{truePeakDb:?number, clipCount:number}} data */
export function renderPeakLamp(el, data) {
  const { truePeakDb, clipCount } = data;
  let cls = 'lamp-ok';
  if (clipCount > 0) cls = 'lamp-clip';
  else if (typeof truePeakDb === 'number' && truePeakDb > -3) cls = 'lamp-warn';
  el.innerHTML = `<span class="lamp ${cls}"></span> peak ${fmt(truePeakDb)} dBTP ${clipCount > 0 ? `(${clipCount} clipped)` : ''}`;
}

/** @param {HTMLElement} el @param {?number} correlation -1..1 */
export function renderCorrelationMeter(el, correlation) {
  const pct = typeof correlation === 'number' ? ((correlation + 1) / 2) * 100 : 50;
  el.innerHTML = `
    <div class="corr-bar"><div class="corr-fill" style="left:${pct}%"></div></div>
    <span class="corr-value">${fmt(correlation, 2)}</span>
  `;
}

/** @param {HTMLElement} el @param {{mode:string, manual:boolean}} result */
export function renderSpeechMusicIndicator(el, result) {
  el.textContent = `${result.mode === 'speech' ? 'Speech' : 'Music'}${result.manual ? ' (manual)' : ''}`;
  el.className = `speech-music ${result.mode}`;
}
