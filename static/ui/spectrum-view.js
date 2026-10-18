// Canvas-based 1/3-octave bar chart with the target curve overlaid.
// Pure render function: give it a canvas and data, it draws. No state.

const DB_MIN = -60;
const DB_MAX = 20;

function dbToY(db, height) {
  const t = (db - DB_MIN) / (DB_MAX - DB_MIN);
  return height - Math.max(0, Math.min(1, t)) * height;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} data
 * @param {number[]} data.centers band center frequencies (Hz)
 * @param {number[]} data.bandsDb measured dB per band
 * @param {number[]} [data.targetDb] target dB per band, same order
 */
export function renderSpectrumBars(canvas, data) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const { centers, bandsDb, targetDb } = data;
  const n = centers.length;
  const barWidth = w / n;

  ctx.fillStyle = '#4a9';
  for (let i = 0; i < n; i++) {
    const y = dbToY(bandsDb[i], h);
    ctx.fillRect(i * barWidth + 1, y, barWidth - 2, h - y);
  }

  if (targetDb) {
    ctx.strokeStyle = '#e5a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * barWidth + barWidth / 2;
      const y = dbToY(targetDb[i], h);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 0dB reference line.
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  const zeroY = dbToY(0, h);
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();
}

/** @param {HTMLElement} el @param {number[]} spl room SPL history, dB */
export function renderSplReadout(el, spl) {
  el.textContent = typeof spl === 'number' ? `${spl.toFixed(1)} dB SPL` : 'uncalibrated';
}
