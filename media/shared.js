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

  window.snagboatShared = { el, svg, compact, fmt, niceMax, clip, formatTime, formatDay, tipFor, ms, short, duration, agentName, modelShort, fit, findNode, pathTo };
})();
