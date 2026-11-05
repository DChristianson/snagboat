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

  // ---------- words ----------
  // How the views that read text (Prompt terms, Conversation Landscape) count words: no model,
  // no embeddings, nothing kept.
  const STOPWORDS = new Set(
    `about above across after again against all almost along already also although always among and another any anybody anyone anything anyway anywhere are around because been before behind being below between both but came can cannot could did does doing done down during each either else even ever every everyone everything few for from further had has have having hence her here hers him his how however into its itself just least less many may maybe might mine more most much must myself near neither never next nor not nothing now off often once one only onto other others otherwise our ours out over own per quite rather really same she should since some somebody someone something somewhere still such than that the their theirs them themselves then there therefore these they thing things this those though through thus too toward towards under until upon very via was were what whatever when where whether which while who whom whose why will with within without would yet you your yours yourself
     please pls make makes making made want wants wanted need needs needed let lets get gets getting got use used uses using like just try trying tried sure okay yes yeah thanks thank help look looks looking see seems take give put keep way kind going know think http https www`
      .split(/\s+/)
  );

  /** A prompt's distinct terms before plural folding: lowercase words of 3+ letters, identifier-like tokens kept whole. */
  function termsOf(text) {
    const out = new Set();
    for (const raw of text.toLowerCase().replace(/’/g, "'").match(/[a-z0-9_]+(?:['.\-/][a-z0-9_]+)*/g) || []) {
      const token = raw.replace(/'s$/, '');
      if (token.includes("'")) continue; // contractions are stopwords in all but spelling
      if ((token.match(/[a-z]/g) || []).length < 3) continue;
      if (token.split(/[.\-/]/).every((part) => STOPWORDS.has(part))) continue;
      out.add(token);
    }
    return out;
  }

  /** Folds a plain plural only when its singular also appears, so "tests" joins "test" and "status" stays. */
  function foldPlural(term, all) {
    if (!/^[a-z]+$/.test(term) || term.length < 4) return term;
    if (term.endsWith('ies') && all.has(`${term.slice(0, -3)}y`)) return `${term.slice(0, -3)}y`;
    if (term.endsWith('s') && !term.endsWith('ss') && all.has(term.slice(0, -1))) return term.slice(0, -1);
    return term;
  }


  // ---------- replay ----------
  // One clock for the views that play a session back (docs/design/visualization-explorer.md,
  // "Shared replay"). It runs over session time: a view reads the clock's position and draws
  // the events up to it, keeping no timers of its own.

  /** Within one timestamp, the order a session's events are replayed in. */
  const REPLAY_KIND_ORDER = { prompt: 0, compaction: 1, call: 2, tool: 3 };
  /** Speeds offered, as multiples of the session's own clock. */
  const REPLAY_SPEEDS = [1, 10, 60, 600];
  const REPLAY_DEFAULT_SPEED = 60;
  /** A quiet stretch longer than this, in seconds of playback, is skipped down to QUIET_LEAD. */
  const QUIET_MAX = 1.5;
  const QUIET_LEAD = 0.4;
  /** A session whose last event is this recent can be live. */
  const LIVE_WINDOW_MS = 10 * 60 * 1000;

  /**
   * Every prompt, model call, tool call, and compaction of these sessions as one list in
   * timestamp order, with a fixed tie-break (kind, then session order, then position in the
   * session), so a replay always runs the same way. Each entry:
   * { t, kind, sessionId, turnId?, agentId?, item, index } where item is the view's own record.
   */
  function replayEvents(views) {
    const out = [];
    views.forEach((v, si) => {
      const sessionId = v.summary.sessionId;
      const add = (kind, list) =>
        list.forEach((item, index) => {
          const t = ms(item.ts);
          if (Number.isFinite(t)) out.push({ t, kind, sessionId, turnId: item.turnId, agentId: item.agentId, item, index, si });
        });
      add('prompt', v.prompts || []);
      add('compaction', v.compactions || []);
      add('call', v.calls || []);
      add('tool', v.tools || []);
    });
    out.sort((a, b) => a.t - b.t || REPLAY_KIND_ORDER[a.kind] - REPLAY_KIND_ORDER[b.kind] || a.si - b.si || a.index - b.index);
    for (const e of out) delete e.si;
    return out;
  }

  /** The number of events at or before time t (events sorted by t). */
  function countUpTo(events, t) {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * A replay clock. The caller gives it sessions and draws in onFrame(clock); the clock says
   * where it is (time, shown) and whether it's live. It ticks only while playing and active,
   * so a slide that isn't current costs nothing.
   *
   *   opts: { onFrame(clock), speed?, now?(), raf?(fn), caf?(id), reducedMotion?: boolean }
   *   clock.setSessions(views)   new or updated sessions; at the end, an update keeps the clock there
   *   clock.time, clock.start, clock.end, clock.events, clock.shown (events at or before time)
   *   clock.playing, clock.speed, clock.mode() 'live' | 'replay'
   *   clock.play(), pause(), toggle(), seek(t), seekShown(n), setSpeed(s), setActive(active), destroy()
   *
   * Live means at the end of a session that's still recent; scrubbing back leaves live until the
   * clock returns to the end. With reduced motion, the clock opens at the end and never autoplays.
   */
  function createReplay(opts) {
    const now = opts.now || (() => Date.now());
    const raf = opts.raf || ((fn) => window.requestAnimationFrame(fn));
    const caf = opts.caf || ((id) => window.cancelAnimationFrame(id));
    const reduced = opts.reducedMotion !== undefined ? !!opts.reducedMotion : typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = null;
    let last = null; // the wall time of the last tick
    let active = false;
    let opened = false; // whether the clock has been placed for the first sessions
    let autoplay = !reduced; // plays the first time it becomes active
    const clock = {
      events: [],
      start: 0,
      end: 0,
      time: 0,
      shown: 0,
      playing: false,
      speed: REPLAY_SPEEDS.includes(opts.speed) ? opts.speed : REPLAY_DEFAULT_SPEED,
      reduced,
      atEnd() {
        return clock.shown >= clock.events.length && clock.time >= clock.end;
      },
      recent() {
        return clock.events.length > 0 && now() - clock.end < LIVE_WINDOW_MS;
      },
      mode() {
        return clock.atEnd() && clock.recent() ? 'live' : 'replay';
      },
      setSessions(views) {
        const wasAtEnd = opened && clock.atEnd();
        clock.events = replayEvents(views);
        clock.start = clock.events.length ? clock.events[0].t : 0;
        clock.end = clock.events.length ? clock.events[clock.events.length - 1].t : 0;
        if (!opened) {
          opened = true;
          // A live session, or reduced motion, opens on what's there now.
          if (reduced || clock.recent()) {
            autoplay = false;
            place(clock.end);
          } else place(clock.start);
        } else if (wasAtEnd) place(clock.end);
        else place(Math.min(Math.max(clock.time, clock.start), clock.end));
        render();
      },
      play() {
        if (!clock.events.length) return;
        if (clock.atEnd()) place(clock.start); // play from the top again
        clock.playing = true;
        autoplay = false;
        schedule();
        render();
      },
      pause() {
        clock.playing = false;
        autoplay = false;
        unschedule();
        render();
      },
      toggle() {
        if (clock.playing) clock.pause();
        else clock.play();
      },
      seek(t) {
        autoplay = false;
        place(Math.min(Math.max(t, clock.start), clock.end));
        render();
      },
      /** Moves to just after the nth event (0 is before the first). */
      seekShown(n) {
        const i = Math.max(0, Math.min(clock.events.length, Math.round(n)));
        clock.seek(i === 0 ? clock.start : clock.events[i - 1].t);
        if (i === 0) clock.shown = 0;
        render();
      },
      setSpeed(s) {
        if (REPLAY_SPEEDS.includes(s)) clock.speed = s;
        render();
      },
      setActive(on) {
        active = !!on;
        if (active && autoplay && clock.events.length) {
          autoplay = false;
          clock.playing = true;
        }
        if (active && clock.playing) schedule();
        else unschedule();
      },
      destroy() {
        unschedule();
        clock.playing = false;
      },
    };
    function place(t) {
      clock.time = t;
      clock.shown = countUpTo(clock.events, t);
    }
    function render() {
      if (opts.onFrame) opts.onFrame(clock);
    }
    function schedule() {
      if (frame !== null || !active || !clock.playing) return;
      last = null;
      frame = raf(tick);
    }
    function unschedule() {
      if (frame !== null) caf(frame);
      frame = null;
      last = null;
    }
    function tick(wall) {
      frame = null;
      if (!clock.playing || !active) return;
      const dt = last === null ? 0 : Math.min(250, Math.max(0, wall - last)); // a stalled tab doesn't jump ahead
      last = wall;
      let t = clock.time + dt * clock.speed;
      // Skip a quiet stretch: the next event arrives QUIET_LEAD seconds of playback from now.
      const next = clock.events[clock.shown];
      if (next && (next.t - t) / clock.speed > QUIET_MAX * 1000) t = next.t - QUIET_LEAD * 1000 * clock.speed;
      if (t >= clock.end) {
        place(clock.end);
        clock.playing = false;
        render();
        return;
      }
      place(t);
      render();
      frame = raf(tick);
      last = wall;
    }
    return clock;
  }

  /**
   * The replay control bar for a clock: play and pause, a scrubber over the events, the speed,
   * and a badge naming what's on screen (LIVE, or REPLAY ×N), so replay is never taken for live.
   * Call bar.sync() from the clock's onFrame.
   */
  function replayBar(clock, { label } = {}) {
    const playBtn = el('button', { class: 'replay-play' });
    playBtn.addEventListener('click', () => clock.toggle());
    const scrub = el('input', { type: 'range', min: 0, max: 0, step: 1, value: 0, class: 'replay-scrub', 'aria-label': label ? `Replay position in ${label}` : 'Replay position' });
    scrub.addEventListener('input', () => {
      const n = Number(scrub.value); // read first: pausing re-syncs the bar, which resets the slider
      clock.pause();
      clock.seekShown(n);
    });
    const speed = el(
      'select',
      { class: 'replay-speed', 'aria-label': 'Replay speed' },
      REPLAY_SPEEDS.map((s) => el('option', { value: s, text: `×${s}` }))
    );
    speed.addEventListener('change', () => clock.setSpeed(Number(speed.value)));
    const badge = el('span', { class: 'replay-badge', role: 'status' });
    const where = el('span', { class: 'replay-where small' });
    const bar = el('div', { class: 'replay-bar', role: 'group', 'aria-label': 'Replay' }, [playBtn, scrub, speed, badge, where]);
    function sync() {
      const live = clock.mode() === 'live';
      playBtn.textContent = clock.playing ? 'Pause' : clock.atEnd() ? 'Replay' : 'Play';
      playBtn.disabled = clock.events.length === 0;
      scrub.max = String(clock.events.length);
      scrub.value = String(clock.shown);
      scrub.setAttribute('aria-valuetext', `${clock.shown} of ${clock.events.length} events`);
      speed.value = String(clock.speed);
      badge.textContent = live ? 'LIVE' : `REPLAY ×${clock.speed}`;
      badge.classList.toggle('live', live);
      where.textContent = clock.events.length ? `${clock.shown}/${clock.events.length} · ${formatTime(clock.time)}${clock.playing ? ' · quiet gaps skipped' : ''}` : 'No events';
    }
    sync();
    return { element: bar, sync };
  }

  // ---------- force layout ----------
  // A small force layout for the hero views that need one (docs/design/visualization-explorer.md,
  // "Shared force layout"). No dependencies and no randomness: a node starts where a hash of its
  // id puts it, so one session always gets the same picture; the layout settles before drawing,
  // and an update starts from the positions it had, so nodes move gently.

  /** A 32-bit FNV-1a hash of a string. */
  function hashId(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Positions for nodes joined by weighted links, inside a width × height box.
   *
   *   nodes:  [{ id, r?, pin?: { x, y } }]   r is the node's radius (collision); a pinned node doesn't move
   *   links:  [{ source, target, weight }]  weight > 0; heavier links pull their ends closer
   *   opts:   { width, height, previous?: Map(id -> { x, y }), iterations?, padding?, spacing?, gravity? }
   *   returns Map(id -> { x, y })
   *
   * The caller decides what the weights mean (interaction counts, delegation, …) and says so on
   * screen. With previous positions, known nodes start there and new ones start beside a
   * neighbor that has a position, and the layout runs a third as long, so an update nudges
   * rather than reshuffles.
   */
  function forceLayout(nodes, links, opts) {
    const width = Math.max(1, opts.width);
    const height = Math.max(1, opts.height);
    const pad = opts.padding !== undefined ? opts.padding : 24;
    const prev = opts.previous || null;
    const spacing = opts.spacing || Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.6;
    const gravity = opts.gravity !== undefined ? opts.gravity : 0.02;
    const warm = !!prev && nodes.some((n) => prev.has(n.id));
    const iterations = opts.iterations || (warm ? 100 : 300);
    const cx = width / 2;
    const cy = height / 2;
    const index = new Map();
    const pts = nodes.map((n, i) => {
      index.set(n.id, i);
      return { id: n.id, r: n.r || 6, pin: n.pin || null, x: 0, y: 0, vx: 0, vy: 0, placed: false };
    });
    const ls = links
      .filter((l) => index.has(l.source) && index.has(l.target) && l.source !== l.target && l.weight > 0)
      .map((l) => ({ a: index.get(l.source), b: index.get(l.target), w: l.weight }));
    const maxW = ls.reduce((m, l) => Math.max(m, l.w), 0) || 1;
    const clampX = (p, x) => Math.min(width - pad - p.r, Math.max(pad + p.r, x));
    const clampY = (p, y) => Math.min(height - pad - p.r, Math.max(pad + p.r, y));

    // Starting positions: pinned, then previous, then beside a placed neighbor, then by hash.
    for (const p of pts) {
      if (p.pin) Object.assign(p, { x: p.pin.x, y: p.pin.y, placed: true });
      else if (prev && prev.has(p.id)) Object.assign(p, { x: prev.get(p.id).x, y: prev.get(p.id).y, placed: true });
    }
    const seeded = (p, ox, oy, radius) => {
      const h = hashId(p.id);
      const angle = ((h & 0xffff) / 0x10000) * 2 * Math.PI;
      const dist = radius * (0.35 + 0.65 * ((h >>> 16) / 0x10000));
      p.x = ox + Math.cos(angle) * dist;
      p.y = oy + Math.sin(angle) * dist;
      p.placed = true;
    };
    for (const p of pts) {
      if (p.placed) continue;
      const i = index.get(p.id);
      const nb = ls.find((l) => (l.a === i && pts[l.b].placed) || (l.b === i && pts[l.a].placed));
      if (warm && nb) {
        const other = pts[nb.a === i ? nb.b : nb.a];
        seeded(p, other.x, other.y, spacing * 0.5);
      } else seeded(p, cx, cy, Math.min(width, height) * 0.4);
    }

    // Settle: repulsion between every pair, springs on links, a pull to the center, collisions.
    for (let step = 0; step < iterations; step++) {
      const alpha = (warm ? 0.3 : 1) * (1 - step / iterations);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const q = pts[j];
          let dx = q.x - p.x;
          let dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            // Coincident: separate along a direction from the ids, not at random.
            const a = ((hashId(p.id + '|' + q.id) & 0xffff) / 0x10000) * 2 * Math.PI;
            dx = Math.cos(a) * 0.1;
            dy = Math.sin(a) * 0.1;
            d2 = 0.01;
          }
          const d = Math.sqrt(d2);
          const push = ((spacing * spacing) / d) * 0.05 * alpha;
          const minD = p.r + q.r + 4;
          const overlap = d < minD ? (minD - d) * 0.5 : 0;
          const fx = (dx / d) * (push + overlap);
          const fy = (dy / d) * (push + overlap);
          p.vx -= fx;
          p.vy -= fy;
          q.vx += fx;
          q.vy += fy;
        }
      }
      for (const l of ls) {
        const p = pts[l.a];
        const q = pts[l.b];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const rest = spacing * (1.1 - 0.6 * (l.w / maxW)) + p.r + q.r;
        const k = (0.05 + 0.15 * (l.w / maxW)) * alpha;
        const f = (d - rest) * k;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
        q.vx -= (dx / d) * f;
        q.vy -= (dy / d) * f;
      }
      for (const p of pts) {
        if (p.pin) {
          p.vx = p.vy = 0;
          continue;
        }
        p.vx += (cx - p.x) * gravity * alpha;
        p.vy += (cy - p.y) * gravity * alpha;
        const speed = Math.hypot(p.vx, p.vy);
        const cap = spacing * 0.5;
        if (speed > cap) {
          p.vx *= cap / speed;
          p.vy *= cap / speed;
        }
        p.x = clampX(p, p.x + p.vx);
        p.y = clampY(p, p.y + p.vy);
        p.vx *= 0.6;
        p.vy *= 0.6;
      }
    }
    const out = new Map();
    for (const p of pts) out.set(p.id, { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
    return out;
  }

  /**
   * Ambient drift for decoration: a small offset that changes smoothly with time t (ms), the
   * same for the same id every time. It moves what's drawn, never the layout's positions.
   */
  function drift(id, t, amplitude) {
    const h = hashId(id);
    const px = 7000 + (h & 0xfff);
    const py = 9000 + ((h >>> 12) & 0xfff);
    return { dx: Math.sin((2 * Math.PI * t) / px + (h & 7)) * amplitude, dy: Math.cos((2 * Math.PI * t) / py + ((h >>> 3) & 7)) * amplitude };
  }

  window.snagboatShared = { el, svg, compact, fmt, niceMax, clip, formatTime, formatDay, tipFor, ms, short, duration, agentName, modelShort, fit, findNode, pathTo, callTokens, sessionName, secondsText, turnStats, METRICS, metricValues, quantile, density, niceAxis, heatScale, arcPath, modeButtons, vizPanel, interact, legendKey, sessionClass, svgText, REPLAY_SPEEDS, replayEvents, countUpTo, createReplay, replayBar, hashId, forceLayout, drift, termsOf, foldPlural };
})();
