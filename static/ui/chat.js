// Minimal chat UI for the Channel tab, streamed from /api/ask. Facts-only
// context is built by the caller (app.js has the current channel's
// findings); this module just renders the conversation and streams
// responses in as they arrive.

export class ChatPanel {
  constructor(el) {
    this.el = el;
    this.history = [];
    this.el.innerHTML = '<div class="chat-log"></div><form class="chat-form"><input type="text" placeholder="Ask about this channel..." /><button type="submit">Ask</button></form>';
    this.logEl = this.el.querySelector('.chat-log');
    this.form = this.el.querySelector('form');
    this.input = this.el.querySelector('input');
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const question = this.input.value.trim();
      if (!question) return;
      this.input.value = '';
      this.ask(question);
    });
  }

  _appendLine(role, text) {
    const div = document.createElement('div');
    div.className = `chat-line chat-${role}`;
    div.textContent = text;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return div;
  }

  /** @param {() => object} getContext called at send time for the current facts */
  async ask(question, getContext) {
    this._appendLine('user', question);
    this.history.push({ role: 'user', content: question });
    const answerEl = this._appendLine('assistant', '');

    const context = typeof getContext === 'function' ? getContext() : {};
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context, history: this.history.slice(0, -1) }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      answerEl.textContent = full;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
    this.history.push({ role: 'assistant', content: full });
  }
}
