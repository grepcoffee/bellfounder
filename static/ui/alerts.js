// Feedback alert banner. Alerts never wait on the LLM (PLAN.md section 4),
// so this just renders whatever the DSP worker's 'alert' messages hand it
// - no network round-trip in the critical path.

const ACTIVE_MS = 4000; // how long an alert stays visible after its last sighting

export class AlertBanner {
  constructor(el) {
    this.el = el;
    this.active = new Map(); // key -> { alert, lastSeen }
  }

  push(role, alert) {
    const key = `${role}:${Math.round(alert.freq)}`;
    this.active.set(key, { role, alert, lastSeen: Date.now() });
    this._render();
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.active) {
      if (now - entry.lastSeen > ACTIVE_MS) {
        this.active.delete(key);
        changed = true;
      }
    }
    if (changed) this._render();
  }

  _render() {
    if (this.active.size === 0) {
      this.el.classList.remove('visible');
      this.el.innerHTML = '';
      return;
    }
    this.el.classList.add('visible');
    const items = Array.from(this.active.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(({ role, alert }) => {
        const notch = `-6 dB at ${Math.round(alert.freq)} Hz (${alert.note}), Q 8`;
        const corroborated = alert.corroboratedByRoom ? ' - confirmed in room' : '';
        return `<div class="alert-item">[${role}] ${notch}${corroborated}</div>`;
      });
    this.el.innerHTML = items.join('');
  }
}
