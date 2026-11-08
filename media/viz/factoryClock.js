// Factory Clock (hero view, design language `horology`): a radial sweep of
// activity read like a watch. Angle is time, and one revolution is the window
// (the whole session, or a fixed span that follows the sweep); rings are
// depth, from you at the center through the primary agent and its subagents
// to the tools at the bezel. An arc spans a stretch of an actor's activity;
// hatching marks a quiet gap inside an open turn; one signal-orange hand
// sweeps through the history. See docs/design/visualization-explorer.md,
// "Factory Clock".
//
// Events have no durations, so as in the Gantt an arc runs from the first
// event of a stretch to its last. Waiting can't be told from working until
// phase 8 labels quiet gaps, so the hatching means "quiet gap", and the note
// says so. Playback comes from the shared replay clock: the hand is the
// clock's position and the arcs fill in behind it. Session and project
// level: every loaded session goes onto one dial, its rings shared and its
// turns kept per session. Clicking an arc selects its turn; clicking a ring's label isolates
// the ring. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_SUB_RINGS = 4; // subagent rings, the "+N" ring included
  const MAX_TOOL_RINGS = 2; // tool rings before an "other" ring
  const JOIN = 0.02; // events closer than this share of the window join one arc
  const QUIET_MIN_MS = 3 * 60 * 1000; // a quiet stretch inside an open turn is hatched past this
  const WINDOWS = [
    ['session', 'Whole span'],
    ['15m', '15 min'],
    ['1h', '1 hour'],
    ['4h', '4 hours'],
  ];
  const WINDOW_MS = { '15m': 15 * 60e3, '1h': 60 * 60e3, '4h': 4 * 60 * 60e3 };
  const OVERLAYS = [
    ['duration', 'Duration'],
    ['events', 'Event count'],
    ['tokens', 'Tokens'],
  ];
  let charts = 0;

  window.snagboatViz.register({
    id: 'factory-clock',
    title: 'Factory Clock',
    tags: { category: ['temporal'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['time', 'actor', 'hierarchy'], language: ['horology'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, short, secondsText, formatTime, arcPath, callTokens, modeButtons, showTip, hideTip } = ctx;
      const prefix = `fc${++charts}`;
      const frame = el('div', { class: 'hero-clock' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let views = [];
      let viewKey = '';
      let selection = null;
      let model = null;
      let windowMode = 'session';
      let overlay = 'duration';
      let isolated = null; // a ring id
      let scene = null;
      let shownWindow = null; // the window index drawn, for fixed windows
      const clock = ctx.createReplay({ onFrame: () => paint() });
      const bar = ctx.replayBar(clock, { label: 'the Factory Clock' });
      const fit = ctx.fitter(host); // the dial fills the slide's height
      const windowButtons = modeButtons('Window', WINDOWS, windowMode, (m) => {
        windowMode = m;
        shownWindow = null;
        draw();
      });
      const overlayButtons = modeButtons('Overlay', OVERLAYS, overlay, (m) => {
        overlay = m;
        draw();
      });

      function update(sessions, sel) {
        const key = sessions.map((v) => v.summary.sessionId).join('\n');
        if (key !== viewKey) {
          isolated = null;
          shownWindow = null;
        }
        viewKey = key;
        views = sessions;
        selection = sel || null;
        model = views.length ? analyze(views) : null;
        clock.setSessions(views);
        draw();
      }

      // Turns are keyed by session as well as id, so arcs and quiet gaps from several sessions stay apart.
      const turnKey = (sessionId, turnId) => (turnId ? `${sessionId}\n${turnId}` : undefined);
      const pickKey = (k) => {
        const [sessionId, turnId] = k.split('\n');
        ctx.select({ sessionId, turnId });
      };

      /** Rings, inside out, each with its events: { t, turnId (a turn key), tokens }, over every session given. */
      function analyze(vs) {
        const ms = (ts) => Date.parse(ts);
        const rings = [];
        const ring = (id, kind, label) => {
          const r = { id, kind, label, events: [] };
          rings.push(r);
          return r;
        };
        const each = (pick) => vs.flatMap((v) => pick(v).map((x) => ({ ...x, sessionId: v.summary.sessionId })));
        const prompts = each((v) => v.prompts);
        const calls = each((v) => v.calls);
        const tools = each((v) => v.tools);
        const subOf = (x) => `${x.sessionId}/${x.agentId}`;
        const human = ring('human', 'human', 'Human');
        for (const p of prompts) human.events.push({ t: ms(p.ts), turnId: turnKey(p.sessionId, p.turnId), tokens: 0 });
        const primary = ring('primary', 'primary', 'Primary');
        const subIds = [...new Set(calls.concat(tools).filter((x) => x.agentId).map(subOf))];
        const subWork = new Map(subIds.map((id) => [id, calls.filter((c) => c.agentId && subOf(c) === id).length]));
        const subKeep = [...subIds].sort((a, b) => subWork.get(b) - subWork.get(a) || a.localeCompare(b)).slice(0, subIds.length > MAX_SUB_RINGS ? MAX_SUB_RINGS - 1 : MAX_SUB_RINGS);
        const subRings = new Map(subKeep.map((id) => [id, ring(`sub:${id}`, 'sub', `Sub ${id.split('/')[1].replace(/^agent-/, '').slice(0, 5)}`)]));
        const subOther = subIds.length > subKeep.length ? ring('sub:+', 'sub', `+${subIds.length - subKeep.length} subs`) : null;
        const actorRing = (x) => (!x.agentId ? primary : subRings.get(subOf(x)) || subOther);
        for (const c of calls) actorRing(c).events.push({ t: ms(c.ts), turnId: turnKey(c.sessionId, c.turnId), tokens: callTokens(c), sessionId: c.sessionId });
        const cats = new Map();
        for (const t of tools) cats.set(t.category, (cats.get(t.category) || 0) + 1);
        const catKeep = [...cats.keys()].sort((a, b) => cats.get(b) - cats.get(a) || a.localeCompare(b)).slice(0, MAX_TOOL_RINGS);
        const toolRings = new Map(catKeep.map((c) => [c, ring(`tool:${c}`, 'tool', c)]));
        const toolOther = cats.size > catKeep.length ? ring('tool:+', 'tool', 'Other tools') : null;
        for (const t of tools) {
          const r = toolRings.get(t.category) || toolOther;
          r.events.push({ t: ms(t.ts), turnId: turnKey(t.sessionId, t.turnId), tokens: 0, failed: t.status === 'failure', name: t.name, sessionId: t.sessionId });
          // A tool call is the calling agent's activity too.
          actorRing(t).events.push({ t: ms(t.ts), turnId: turnKey(t.sessionId, t.turnId), tokens: 0, sessionId: t.sessionId });
        }
        for (const r of rings) r.events.sort((a, b) => a.t - b.t);
        // Turn spans, for the quiet gaps inside them; each session's events, for gaps within that session only.
        const turnEnd = new Map();
        for (const r of rings) for (const e of r.events) if (e.turnId) turnEnd.set(e.turnId, Math.max(turnEnd.get(e.turnId) || 0, e.t));
        const turns = prompts.map((p) => {
          const key = turnKey(p.sessionId, p.turnId);
          return { key, sessionId: p.sessionId, from: ms(p.ts), to: turnEnd.get(key) || ms(p.ts) };
        });
        const sessionTimes = new Map();
        for (const e of [...calls, ...tools, ...prompts]) (sessionTimes.get(e.sessionId) || sessionTimes.set(e.sessionId, []).get(e.sessionId)).push(ms(e.ts));
        for (const list of sessionTimes.values()) list.sort((a, b) => a - b);
        const events = ctx.replayEvents(vs);
        return {
          rings: rings.filter((r) => r.events.length || r.kind === 'human' || r.kind === 'primary'),
          turns,
          sessionTimes,
          start: events.length ? events[0].t : Math.min(...vs.map((v) => ms(v.summary.firstTs))),
          end: events.length ? events[events.length - 1].t : Math.max(...vs.map((v) => ms(v.summary.lastTs))),
        };
      }

      /** The window shown at time t: [from, to). */
      function windowAt(t) {
        if (windowMode === 'session') return { from: model.start, to: Math.max(model.end, model.start + 60e3), index: 0 };
        const w = WINDOW_MS[windowMode];
        const index = Math.max(0, Math.floor((t - model.start) / w));
        return { from: model.start + index * w, to: model.start + (index + 1) * w, index };
      }

      /** An actor's arcs within a window: stretches of events closer than JOIN of the window. */
      function arcsOf(r, win) {
        const span = win.to - win.from;
        const join = span * JOIN;
        const out = [];
        let cur = null;
        for (const e of r.events) {
          if (e.t < win.from || e.t >= win.to) continue;
          if (cur && e.t - cur.to <= join) {
            cur.to = e.t;
            cur.n += 1;
            cur.tokens += e.tokens;
            cur.failed += e.failed ? 1 : 0;
            if (e.turnId) cur.turns.add(e.turnId);
          } else {
            cur = { from: e.t, to: e.t, n: 1, tokens: e.tokens, failed: e.failed ? 1 : 0, turns: new Set(e.turnId ? [e.turnId] : []), ring: r };
            out.push(cur);
          }
        }
        return out;
      }

      /** Quiet stretches inside open turns on the primary ring: no event from anyone for QUIET_MIN_MS. */
      function quietGaps(win) {
        const out = [];
        for (const turn of model.turns) {
          let last = turn.from;
          for (const t of model.sessionTimes.get(turn.sessionId) || []) {
            if (t <= turn.from || t > turn.to) continue;
            if (t - last >= QUIET_MIN_MS) out.push({ from: last, to: t, key: turn.key });
            last = t;
          }
        }
        return out.filter((g) => g.to > win.from && g.from < win.to).map((g) => ({ ...g, from: Math.max(g.from, win.from), to: Math.min(g.to, win.to) }));
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!views.length || !model) {
          frame.replaceChildren(el('p', { class: 'fc-empty', text: 'No session.' }));
          note.textContent = '';
          scene = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const size = Math.min(width - 24, fit.height(620, 300));
        const R = size / 2 - 34; // the bezel's inner edge, numerals outside it
        const cx = size / 2;
        const cy = size / 2;
        const inner = R * 0.16; // the user's dial in the middle
        const outer = R * 0.9;
        const n = model.rings.length;
        const band = Math.min(26, (outer - inner) / Math.max(1, n));
        const radii = new Map(model.rings.map((r, i) => [r.id, { r0: inner + i * band + 2, r1: inner + (i + 1) * band - 2 }]));
        const win = windowAt(clock.time);
        shownWindow = win.index;
        const angle = (t) => ((t - win.from) / (win.to - win.from)) * 2 * Math.PI;

        const root = svg('svg', { class: 'fc-svg', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `Factory Clock of ${title()}: ${n} rings over ${windowLabel(win)}` });
        const defs = svg('defs');
        const face = svg('radialGradient', { id: `${prefix}-dial` });
        face.append(svg('stop', { offset: '0%', class: 'fc-dial-in' }), svg('stop', { offset: '100%', class: 'fc-dial-out' }));
        const hatch = svg('pattern', { id: `${prefix}-hatch`, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(40)' });
        hatch.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'fc-hatch-line' }));
        defs.append(face, hatch);
        root.append(defs);
        root.append(svg('circle', { class: 'fc-case', cx, cy, r: R + 8 }), svg('circle', { class: 'fc-face', cx, cy, r: R, fill: `url(#${prefix}-dial)` }));
        // Ring guides.
        for (const r of model.rings) root.append(svg('circle', { class: 'fc-guide', cx, cy, r: radii.get(r.id).r1 + 2 }));
        // The minute track: 60 ticks, every fifth long, twelve numerals of elapsed time.
        for (let k = 0; k < 60; k++) {
          const a = (k / 60) * 2 * Math.PI;
          const long = k % 5 === 0;
          const r0 = R - (long ? 12 : 6);
          root.append(svg('line', { class: long ? 'fc-tick fc-tick-long' : 'fc-tick', x1: cx + r0 * Math.sin(a), y1: cy - r0 * Math.cos(a), x2: cx + (R - 1) * Math.sin(a), y2: cy - (R - 1) * Math.cos(a) }));
          if (long) {
            const rn = R + 20;
            root.append(svgText({ class: 'fc-numeral', x: cx + rn * Math.sin(a), y: cy - rn * Math.cos(a) + 5, 'text-anchor': 'middle' }, numeral(k / 60, win)));
          }
        }
        // The user's dial at the center.
        root.append(svg('circle', { class: 'fc-user', cx, cy, r: inner - 4 }), svgText({ class: 'fc-label', x: cx, y: cy - 6, 'text-anchor': 'middle' }, 'YOU'), svg('circle', { class: 'fc-pin', cx, cy, r: 4 }));

        // The hand's wake goes under everything drawn on the dial.
        const wake = svg('path', { class: 'fc-wake' });
        root.append(wake);
        // Quiet gaps, hatched, on the primary ring, under its arcs.
        const qp = radii.get('primary');
        const quietLayer = svg('g');
        for (const g of quietGaps(win)) {
          const a0 = angle(g.from);
          const a1 = Math.max(a0 + 0.004, angle(g.to));
          const p = svg('path', { class: 'fc-quiet', d: arcPath(cx, cy, qp.r0, qp.r1, a0, a1), fill: `url(#${prefix}-hatch)` });
          p.dataset.from = g.from;
          ctx.interact(ctx, p, { tip: () => ['Quiet gap inside a turn: nothing recorded', 'Waiting on you or working can’t be told apart yet', ['From', formatTime(g.from)], ['For', secondsText((g.to - g.from) / 1000)]], pick: () => pickKey(g.key) });
          quietLayer.append(p);
        }
        root.append(quietLayer);

        // Arcs, per ring; their reveal follows the hand.
        const arcs = [];
        const maxN = Math.max(1, ...model.rings.flatMap((r) => arcsOf(r, win).map((a) => a.n)));
        const maxTok = Math.max(1, ...model.rings.flatMap((r) => arcsOf(r, win).map((a) => a.tokens)));
        const ringGroups = new Map();
        for (const r of model.rings) {
          const g = svg('g', { class: `fc-ring fc-${r.kind}` });
          ringGroups.set(r.id, g);
          const { r0, r1 } = radii.get(r.id);
          for (const a of arcsOf(r, win)) {
            let rr0 = r0;
            let rr1 = r1;
            let opacity = 1;
            if (overlay === 'events') opacity = 0.35 + 0.65 * Math.sqrt(a.n / maxN);
            if (overlay === 'tokens' && r.kind !== 'human' && r.kind !== 'tool') {
              const mid = (r0 + r1) / 2;
              const h = ((r1 - r0) / 2) * (0.25 + 0.75 * Math.sqrt(a.tokens / maxTok));
              rr0 = mid - h;
              rr1 = mid + h;
            }
            const p = svg('path', { class: `fc-arc${a.failed ? ' fc-has-failed' : ''}`, opacity: opacity.toFixed(2) });
            const turnId = [...a.turns][0];
            ctx.interact(ctx, p, {
              label: `${r.label} from ${formatTime(a.from)}`,
              tip: () => [r.label, ['From', formatTime(a.from)], ['Span', secondsText(Math.max(1, (a.to - a.from) / 1000))], ['Events', fmt(a.n)], ...(a.tokens ? [['Tokens', compact(a.tokens)]] : []), ...(a.failed ? [['Failed', fmt(a.failed)]] : []), ...(turnId ? ['Click to select its turn'] : [])],
              pick: turnId ? () => pickKey(turnId) : null,
            });
            g.append(p);
            arcs.push({ a, p, r0: rr0, r1: rr1, turnIds: a.turns });
          }
          root.append(g);
        }

        // Ring labels along the hand's starting line, clickable to isolate a ring.
        const labels = svg('g');
        for (const r of model.rings) {
          const { r0, r1 } = radii.get(r.id);
          const t = svgText({ class: `fc-label fc-ring-label${isolated === r.id ? ' on' : ''}`, x: cx - 6, y: cy - (r0 + r1) / 2 + 3, 'text-anchor': 'end', tabindex: 0, role: 'button', 'aria-pressed': String(isolated === r.id), 'aria-label': `Isolate the ${r.label} ring` }, r.label.toUpperCase());
          const pick = () => {
            isolated = isolated === r.id ? null : r.id;
            draw();
          };
          t.addEventListener('click', pick);
          t.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
          labels.append(t);
        }
        root.append(labels);
        for (const [id, g] of ringGroups) g.classList.toggle('fc-dim', !!isolated && isolated !== id);

        // The sweep: a faint wedge behind the hand, the hand, its counterweight.
        const hand = svg('line', { class: 'fc-hand', x1: cx, y1: cy });
        const tip = svg('circle', { class: 'fc-hand-tip', r: 4 });
        const playback = svgText({ class: 'fc-playback', x: cx, y: cy + inner + 14, 'text-anchor': 'middle' }, '');
        root.append(hand, tip, playback);
        root.append(svgText({ class: 'fc-label fc-caption', x: cx, y: cy + R * 0.97 - 22, 'text-anchor': 'middle' }, `Window · ${windowLabel(win)} · ${views.length === 1 ? `session ${short(views[0].summary.sessionId)}` : `${views.length} sessions`}`));

        const legend = el('div', { class: 'fc-legend' }, [
          key('fc-k-human', 'Human input'),
          key('fc-k-primary', 'Primary agent'),
          key('fc-k-sub', 'Subagents'),
          key('fc-k-tool', 'Tools'),
          key('fc-k-quiet', 'Quiet gap (not yet told apart from waiting)'),
        ]);
        frame.replaceChildren(el('div', { class: 'fc-head' }, [el('span', { class: 'fc-caps', text: 'Temporal distribution' }), el('span', { class: 'fc-caps', text: windowLabel(win) })]), el('div', { class: 'fc-body' }, [root, el('div', { class: 'fc-side' }, [legend, windowButtons, overlayButtons])]), bar.element);
        scene = { arcs, wake, hand, tip, playback, quietLayer, cx, cy, R, win, angle, selected: selectedTurn() };
        paint();

        note.textContent = [
          `Angle is time, one revolution the window (${windowLabel(win)}); rings are depth, from you at the center to the tools at the bezel.`,
          'An arc runs from the first event of a stretch of activity to its last; events have no durations of their own, so arc length is not compute.',
          'Hatching is a quiet gap of 3 minutes or more inside an open turn: nothing was recorded, and until Snagboat can tell waiting on you from working (phase 8), it means only that.',
          overlay === 'events' ? 'Overlay: darker arcs had more events.' : overlay === 'tokens' ? 'Overlay: thicker arcs spent more tokens.' : '',
          'Click an arc to select its turn, or a ring’s name to isolate it.',
        ]
          .filter(Boolean)
          .join(' ');
        fit.settle(size, draw);
      }

      function key(cls, text) {
        return el('span', { class: 'fc-key' }, [el('span', { class: `fc-swatch ${cls}` }), text]);
      }
      function title() {
        return views.length === 1 ? views[0].summary.name || short(views[0].summary.sessionId) : `${views.length} sessions`;
      }
      function windowLabel(win) {
        return windowMode === 'session' ? `${views.length === 1 ? 'the whole session' : 'all sessions'}, ${secondsText((win.to - win.from) / 1000)}` : `${WINDOWS.find((w) => w[0] === windowMode)[1]} from ${formatTime(win.from)}`;
      }
      function numeral(fraction, win) {
        if (fraction === 0) return '0';
        if (windowMode === '1h') return String(Math.round(fraction * 60));
        return secondsText(((win.to - win.from) * fraction) / 1000);
      }
      function selectedTurn() {
        if (!selection || !selection.turnId) return null;
        const v = views.find((x) => !selection.sessionId || x.summary.sessionId === selection.sessionId);
        return v ? turnKey(v.summary.sessionId, selection.turnId) : null;
      }

      /** Each frame: the hand at the clock's time, arcs revealed up to it. A fixed window follows the hand. */
      function paint() {
        bar.sync();
        if (!scene || !model) return;
        const t = clock.time;
        if (windowMode !== 'session' && windowAt(t).index !== shownWindow) {
          draw();
          return;
        }
        const { cx, cy, R, angle, win } = scene;
        const at = Math.min(Math.max(t, win.from), win.to);
        const a = clock.shown === 0 ? 0 : angle(at);
        const hx = cx + (R - 4) * Math.sin(a);
        const hy = cy - (R - 4) * Math.cos(a);
        scene.hand.setAttribute('x2', hx.toFixed(1));
        scene.hand.setAttribute('y2', hy.toFixed(1));
        scene.tip.setAttribute('cx', hx.toFixed(1));
        scene.tip.setAttribute('cy', hy.toFixed(1));
        const trail = Math.min(a, 0.45);
        scene.wake.setAttribute('d', trail > 0.01 ? ctx.arcPath(cx, cy, 0, R - 2, a - trail, a) : '');
        scene.playback.textContent = clock.playing ? `playback ×${clock.speed}` : '';
        for (const x of scene.arcs) {
          const from = x.a.from;
          const to = Math.min(x.a.to, at);
          if (clock.shown === 0 || from > at) {
            x.p.setAttribute('d', '');
            continue;
          }
          const a0 = angle(from);
          const a1 = Math.max(a0 + 0.012, angle(to)); // a single event still shows as a short block
          const key = `${a0.toFixed(4)}|${a1.toFixed(4)}`;
          if (x.drawn !== key) {
            x.p.setAttribute('d', ctx.arcPath(cx, cy, x.r0, x.r1, a0, a1));
            x.drawn = key;
          }
          x.p.classList.toggle('fc-selected', !!scene.selected && x.turnIds.has(scene.selected));
        }
        for (const q of scene.quietLayer.children) q.setAttribute('visibility', Number(q.dataset.from) <= at && clock.shown > 0 ? 'visible' : 'hidden');
      }

      return {
        update,
        resize: draw,
        setActive: (on) => clock.setActive(on),
        destroy() {
          clock.destroy();
          host.replaceChildren();
        },
      };
    },
  });
})();
