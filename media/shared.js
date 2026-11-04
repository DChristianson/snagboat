// Helpers shared by the detail view's scripts (detail.js, sessions.js,
// explore.js) and the visualizers under media/viz/: DOM and SVG construction,
// number and time formatting, a tooltip pair bound to an element, and the
// small session helpers. Nothing here knows about VS Code, so the web demo
// loads this file as-is. Sets window.snagboatShared.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const child of [].concat(children || [])) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
  }

  const fmt = (n) => n.toLocaleString();
  function compact(n) {
    if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    for (const step of [1, 2, 5, 10]) if (step * pow >= v) return step * pow;
    return 10 * pow;
  }
  /** Shortens text for a cell, keeping the full text for a tooltip. */
  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }
  function formatDay(day) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  /**
   * A showTip/hideTip pair over one tooltip element. Rows are strings (one line
   * each) or [label, value] pairs; the tip sits above and to the right of the
   * pointer, kept inside the window.
   */
  function tipFor(tooltip) {
    function showTip(evt, rows) {
      tooltip.replaceChildren(...rows.map((r) => (typeof r === 'string' ? el('div', { text: r }) : el('div', { class: 'row' }, [el('span', { text: r[0] }), el('span', { text: r[1] })]))));
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth;
      tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, evt.clientX + 12))}px`;
      tooltip.style.top = `${Math.max(8, evt.clientY - tooltip.offsetHeight - 10)}px`;
    }
    const hideTip = () => {
      tooltip.hidden = true;
    };
    return { showTip, hideTip };
  }

  // ---------- sessions ----------
  const ms = (ts) => Date.parse(ts);
  const short = (id) => id.slice(0, 8);
  function duration(fromTs, toTs) {
    const m = Math.round((ms(toTs) - ms(fromTs)) / 60000);
    return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`;
  }
  const agentName = (a) => (a === 'claude-code' ? 'Claude Code' : a === 'copilot' ? 'Copilot' : a);
  const modelShort = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  /** Truncates text to fit a width (about 7px per character at 12px), with an ellipsis. */
  function fit(text, widthPx) {
    const max = Math.floor((widthPx - 12) / 7);
    return max < 2 ? '' : text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…';
  }
  /** The node with this id in a tree of { id, children }, or null. */
  function findNode(node, id) {
    if (node.id === id) return node;
    for (const c of node.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
    return null;
  }
  /** The nodes from the root down to this id, or null. */
  function pathTo(node, id, acc = []) {
    if (node.id === id) return [...acc, node];
    for (const c of node.children) {
      const p = pathTo(c, id, [...acc, node]);
      if (p) return p;
    }
    return null;
  }

  // ---------- charts ----------
  // What the distribution and comparison visualizers share: session numbers, scales, and the
  // parts of a slide (mode buttons, chart, legend, note). Each takes what it needs as arguments.
  const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;
  const sessionName = (s, max = 60) => (s.name ? clip(s.name, max) : short(s.sessionId));
  /** Minutes and hours for a length of time given in seconds. */
  function secondsText(s) {
    if (s < 90) return `${Math.round(s)}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    return `${+(s / 3600).toFixed(1)}h`;
  }

  /** One entry per turn, in order: its first prompt, last event, and counts. */
  function turnStats(view) {
    const turns = new Map();
    for (const p of view.prompts) {
      const t = turns.get(p.turnId) || { turnId: p.turnId, index: p.index, text: undefined, from: ms(p.ts), to: ms(p.ts), tokens: 0, calls: 0, tools: 0, failures: 0, subagents: new Set() };
      t.from = Math.min(t.from, ms(p.ts));
      t.to = Math.max(t.to, ms(p.ts));
      if (!t.text && p.text) t.text = p.text;
      turns.set(p.turnId, t);
    }
    for (const c of view.calls) {
      const t = c.turnId && turns.get(c.turnId);
      if (!t) continue;
      t.to = Math.max(t.to, ms(c.ts));
      t.tokens += callTokens(c);
      t.calls++;
      if (c.agentId) t.subagents.add(c.agentId);
    }
    for (const x of view.tools) {
      const t = x.turnId && turns.get(x.turnId);
      if (!t) continue;
      t.to = Math.max(t.to, ms(x.ts));
      t.tools++;
      if (x.status === 'failure') t.failures++;
    }
    return [...turns.values()].sort((a, b) => a.from - b.from);
  }

  /** What can be measured many times in a session, for the distribution views. `perCall` marks the ones with a model and agent. */
  const METRICS = [
    { key: 'tokens', label: 'Tokens per model call', perCall: true, text: compact },
    { key: 'output', label: 'Output tokens per model call', perCall: true, text: compact },
    { key: 'gap', label: 'Seconds between a turn’s model calls', perCall: true, text: secondsText },
    { key: 'turnTokens', label: 'Tokens per turn', text: compact },
    { key: 'turnTools', label: 'Tool calls per turn', text: fmt },
    { key: 'turnSpan', label: 'Seconds per turn', text: secondsText },
  ];
  /** A session's measurements: [{ value, turnId, model?, agentId? }]. */
  function metricValues(view, key) {
    if (key === 'tokens') return view.calls.map((c) => ({ value: callTokens(c), turnId: c.turnId, model: c.model, agentId: c.agentId }));
    if (key === 'output') return view.calls.map((c) => ({ value: c.output, turnId: c.turnId, model: c.model, agentId: c.agentId }));
    if (key === 'gap') {
      const last = new Map();
      const out = [];
      for (const c of [...view.calls].sort((a, b) => ms(a.ts) - ms(b.ts))) {
        if (!c.turnId) continue;
        const stream = `${c.turnId}|${c.agentId || ''}`;
        if (last.has(stream)) out.push({ value: (ms(c.ts) - last.get(stream)) / 1000, turnId: c.turnId, model: c.model, agentId: c.agentId });
        last.set(stream, ms(c.ts));
      }
      return out;
    }
    const pick = { turnTokens: (t) => t.tokens, turnTools: (t) => t.tools, turnSpan: (t) => (t.to - t.from) / 1000 }[key];
    return turnStats(view).map((t) => ({ value: pick(t), turnId: t.turnId }));
  }

  /** The q-quantile of an ascending list, interpolated. */
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const at = (sorted.length - 1) * q;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  }
  /** A density estimate at n points from lo to hi (Gaussian, Silverman's bandwidth): [{ x, y }]. */
  function density(values, lo, hi, n = 48) {
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / values.length);
    const bw = Math.max(1.06 * sd * Math.pow(values.length, -0.2), (hi - lo) / 80, 1e-9);
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = lo + ((hi - lo) * i) / (n - 1);
      let y = 0;
      for (const v of values) y += Math.exp(-0.5 * ((x - v) / bw) * ((x - v) / bw));
      out.push({ x, y: y / (values.length * bw * Math.sqrt(2 * Math.PI)) });
    }
    return out;
  }
  /** Round tick values from 0 to a nice top: { top, ticks }. */
  function niceAxis(max, n = 4) {
    const top = niceMax(max);
    return { top, ticks: Array.from({ length: n + 1 }, (_, i) => (top * i) / n) };
  }
  /** Five square-root steps up to max: stepOf(value), and each step's bound; counts name the whole numbers a step holds. */
  function heatScale(max, steps = 5) {
    const bound = (i) => (max * (i * i)) / (steps * steps);
    return {
      steps,
      stepOf(v) {
        for (let i = 1; i <= steps; i++) if (v <= bound(i)) return i;
        return steps;
      },
      text(i, whole) {
        if (!whole) return `up to ${compact(Math.round(bound(i)))}`;
        const lo = Math.floor(bound(i - 1)) + 1;
        const hi = Math.floor(bound(i));
        return hi < lo ? null : lo === hi ? fmt(hi) : `${fmt(lo)}–${fmt(hi)}`;
      },
    };
  }
  /** An annular wedge from angle a0 to a1 (radians, clockwise from the top), between radii r0 and r1. */
  function arcPath(cx, cy, r0, r1, a0, a1) {
    const pt = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${pt(r0, a0)} L${pt(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
  }
  /** Buttons that pick one of several modes, under a muted label; options are [[id, text]]. */
  function modeButtons(label, options, initial, onChange) {
    const buttons = options.map(([id, text]) => {
      const b = el('button', { text, 'aria-pressed': String(id === initial) });
      b.addEventListener('click', () => {
        for (const [other, btn] of buttons) btn.setAttribute('aria-pressed', String(other === id));
        onChange(id);
      });
      return [id, b];
    });
    return el('div', { class: 'controls', role: 'group', 'aria-label': label }, [el('span', { class: 'muted small', text: label }), ...buttons.map(([, b]) => b)]);
  }
  /** Lays out a slide: controls, chart, legend, note. empty(message) shows a message in place of all three. */
  function vizPanel(host, controls) {
    const chart = el('div');
    const legend = el('div', { class: 'legend small viz-legend' });
    const note = el('p', { class: 'muted small' });
    host.replaceChildren(...controls, chart, legend, note);
    const empty = (message) => {
      chart.replaceChildren(...(message ? [el('p', { class: 'muted', text: message })] : []));
      legend.replaceChildren();
      note.textContent = '';
    };
    return { chart, legend, note, empty };
  }
  /** A tooltip, and when there's a pick, a click and Enter that do it. */
  function interact(ctx, node, { label, tip, pick }) {
    node.addEventListener('mousemove', (e) => ctx.showTip(e, tip(e)));
    node.addEventListener('mouseleave', ctx.hideTip);
    if (!pick) return node;
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', pick);
    node.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
    return node;
  }
  const legendKey = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
  /** A session's color by its position: six hues, then the same six as rings. */
  const sessionClass = (i) => `line-${i % 6}${i >= 6 ? ' ring' : ''}`;
  /** Text in an SVG, with the attributes given. */
  function svgText(attrs, text) {
    const t = svg('text', attrs);
    t.textContent = text;
    return t;
  }

  window.snagboatShared = { el, svg, compact, fmt, niceMax, clip, formatTime, formatDay, tipFor, ms, short, duration, agentName, modelShort, fit, findNode, pathTo, callTokens, sessionName, secondsText, turnStats, METRICS, metricValues, quantile, density, niceAxis, heatScale, arcPath, modeButtons, vizPanel, interact, legendKey, sessionClass, svgText };
})();
