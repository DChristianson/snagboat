// Context fill: the context each main-agent call sent (input + cache read +
// cache creation) by the call's index within its session, one line per
// session, so sessions line up by progress rather than clock and their
// shapes compare. A dot marks the first call after each compaction; each
// model's largest-seen and limit lines are drawn as the timeline draws
// them. Lines take the validated hues in fixed order and repeat dashed past
// six. See docs/design/visualization-explorer.md for the contract. A
// project-level visualizer: one session draws one line. Hovering near a
// point gives its breakdown; clicking selects that call's turn. Sees only
// its host and ctx: no VS Code.
(function () {
  const HUES = 6; // line-0 .. line-5 in viz.css: --fc-series-1, then --fc-cat-1..5
  window.factoryClock.register({
    id: 'context-fill',
    title: 'Context fill',
    tags: { category: ['state', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, niceMax, clip, short, formatTime, ms, modelShort, showTip, hideTip } = ctx;
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small fill-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(chartHost, legend, note);
      let views = [];
      let selection = null;
      let draws = 0;

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));
      const ctxOf = (c) => c.input + c.cacheRead + c.cacheCreation;
      const lineClass = (i) => `line-${i % HUES}`;
      const dashed = (i) => i >= HUES;

      function update(sessions, sel) {
        views = sessions;
        selection = sel || null;
        draw();
      }

      /** Every model's marks across the sessions: the largest seen and the lowest limit, as the store merges them. */
      function mergedMarks() {
        const out = {};
        for (const v of views) {
          for (const [model, mk] of Object.entries(v.marks)) {
            const cur = out[model] || {};
            if (typeof mk.largestSeen === 'number' && (cur.largestSeen === undefined || mk.largestSeen > cur.largestSeen)) cur.largestSeen = mk.largestSeen;
            if (typeof mk.limit === 'number' && (cur.limit === undefined || mk.limit < cur.limit)) {
              cur.limit = mk.limit;
              cur.limitSource = mk.limitSource;
            }
            out[model] = cur;
          }
        }
        return out;
      }

      function draw() {
        draws++;
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const lines = views.map((v, i) => {
          const promptIndex = new Map(v.prompts.map((p) => [p.turnId, p.index]));
          const points = v.calls.filter((c) => !c.agentId).map((c, k) => ({ k, call: c, ctx: ctxOf(c), promptIndex: c.turnId ? promptIndex.get(c.turnId) : undefined }));
          return { v, i, sessionId: v.summary.sessionId, points };
        });
        if (lines.every((l) => l.points.length === 0)) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const marks = mergedMarks();
        const markValues = Object.values(marks).flatMap((m) => [m.largestSeen, m.limit]).filter((x) => typeof x === 'number');
        const maxN = Math.max(...lines.map((l) => l.points.length));
        const top = niceMax(Math.max(1, ...lines.flatMap((l) => l.points.map((p) => p.ctx)), ...markValues));
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 52, r: 12, t: 12, b: 24 };
        const ph = 180;
        const height = m.t + ph + m.b;
        const pw = width - m.l - m.r;
        const axisY = m.t + ph;
        const x = (k) => m.l + (k / Math.max(1, maxN - 1)) * pw;
        const y = (val) => m.t + ph - (val / top) * ph;
        const selectedTurn = selection && selection.turnId;
        const selectedSession = selection && selection.sessionId;
        const root = svg('svg', { class: 'viz-chart fill-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Context fill: context per main-agent call by call index, ${views.length} session${views.length === 1 ? '' : 's'}` });

        for (const val of [0, top / 2, top]) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: m.l + pw, y1: y(val), y2: y(val) }));
          const lab = svg('text', { class: 'axis-label', x: m.l - 6, y: y(val) + 4, 'text-anchor': 'end' });
          lab.textContent = compact(val);
          root.append(lab);
        }
        // Call index axis.
        let lastTick = null;
        for (let k = 0; k <= 5; k++) {
          const idx = Math.round(((maxN - 1) * k) / 5);
          if (idx === lastTick) continue;
          lastTick = idx;
          const lab = svg('text', { class: 'axis-label', x: x(idx), y: axisY + 14, 'text-anchor': k === 0 ? 'start' : k === 5 ? 'end' : 'middle' });
          lab.textContent = `call ${idx + 1}`;
          root.append(lab);
        }

        // Largest seen / limit, per model. Labels move below their line when they'd collide.
        const markLines = [];
        for (const [model, mk] of Object.entries(marks)) {
          for (const [val, label] of [[mk.largestSeen, 'largest seen'], [mk.limit, mk.limitSource === 'reported' ? 'limit' : 'limit (auto-compaction)']]) {
            if (typeof val === 'number' && val <= top) markLines.push({ val, text: `${label} ${compact(val)} · ${modelShort(model)}` });
          }
        }
        markLines.sort((a, b) => b.val - a.val);
        let lastLabelY = -Infinity;
        for (const mk of markLines) {
          root.append(svg('line', { class: 'mark-line', x1: m.l, x2: m.l + pw, y1: y(mk.val), y2: y(mk.val) }));
          const above = y(mk.val) - 4;
          const ly = above - lastLabelY < 13 ? y(mk.val) + 12 : above;
          lastLabelY = ly;
          const t = svg('text', { class: 'axis-label mark-label', x: m.l + pw - 4, y: ly, 'text-anchor': 'end' });
          t.textContent = mk.text;
          root.append(t);
        }

        // One polyline per session; a lone call draws as a point.
        let anyCompaction = false;
        for (const l of lines) {
          if (!l.points.length) continue;
          const attrs = { class: `fill-line ${lineClass(l.i)}`, d: l.points.map((p) => `${p.k ? 'L' : 'M'}${x(p.k).toFixed(1)},${y(p.ctx).toFixed(1)}`).join(' ') };
          if (dashed(l.i)) attrs['stroke-dasharray'] = '6 4';
          root.append(svg('path', attrs));
          if (l.points.length === 1) root.append(svg('circle', { class: `fill-point ${lineClass(l.i)}`, cx: x(0), cy: y(l.points[0].ctx), r: 3 }));
          // The selected turn's calls, ringed.
          if (selectedTurn && (!selectedSession || selectedSession === l.sessionId)) {
            for (const p of l.points) if (p.call.turnId === selectedTurn) root.append(svg('circle', { class: 'fill-selected', cx: x(p.k), cy: y(p.ctx), r: 4.5 }));
          }
          // A dot at the first call after each compaction.
          for (const c of l.v.compactions) {
            const p = l.points.find((q) => ms(q.call.ts) >= ms(c.ts));
            if (!p) continue;
            anyCompaction = true;
            const g = svg('g', { class: 'fill-compaction' });
            g.append(svg('circle', { class: 'compaction-dot', cx: x(p.k), cy: y(p.ctx), r: 4 }));
            g.append(svg('circle', { class: 'hit', cx: x(p.k), cy: y(p.ctx), r: 9 }));
            g.addEventListener('mousemove', (e) =>
              showTip(e, [`⤓ compacted${c.trigger === 'manual' ? ' (manual)' : ''} · ${formatTime(c.ts)}`, sessionLabel(l.v.summary), ...(c.preTokens ? [['Before', fmt(c.preTokens)]] : []), ...(c.postTokens ? [['After', fmt(c.postTokens)]] : []), ['Next call', `${p.k + 1}: ${fmt(p.ctx)}`]])
            );
            g.addEventListener('mouseleave', hideTip);
            root.append(g);
          }
        }

        // Hover layer: the nearest point within reach gets the tooltip and a marker; a click selects its turn.
        const marker = svg('circle', { class: 'fill-hover', r: 5, hidden: '' });
        const layer = svg('rect', { class: 'hover-layer', x: m.l, y: m.t, width: pw, height: ph });
        const local = (e) => {
          const r = root.getBoundingClientRect();
          return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height];
        };
        const nearest = (e) => {
          const [px, py] = local(e);
          let best = null;
          let bestD = 30;
          for (const l of lines) {
            for (const p of l.points) {
              const d = Math.hypot(x(p.k) - px, y(p.ctx) - py);
              if (d < bestD) {
                bestD = d;
                best = { l, p };
              }
            }
          }
          return best;
        };
        layer.addEventListener('mousemove', (e) => {
          const hit = nearest(e);
          if (!hit) {
            marker.setAttribute('hidden', '');
            hideTip();
            return;
          }
          const { l, p } = hit;
          marker.setAttribute('cx', String(x(p.k)));
          marker.setAttribute('cy', String(y(p.ctx)));
          marker.removeAttribute('hidden');
          showTip(e, [
            `${sessionLabel(l.v.summary)} · call ${p.k + 1} of ${l.points.length}`,
            `${formatTime(p.call.ts)}${p.call.model ? ` · ${modelShort(p.call.model)}` : ''}`,
            ['Prompt', p.promptIndex !== undefined ? `P${p.promptIndex}` : '—'],
            ['Context', fmt(p.ctx)],
            ['  cache read', fmt(p.call.cacheRead)],
            ['  cache creation', fmt(p.call.cacheCreation)],
            ['  fresh input', fmt(p.call.input)],
            ['Output', fmt(p.call.output)],
          ]);
        });
        layer.addEventListener('mouseleave', () => {
          marker.setAttribute('hidden', '');
          hideTip();
        });
        layer.addEventListener('click', (e) => {
          const hit = nearest(e);
          if (!hit || !hit.p.call.turnId) return;
          const next = { sessionId: hit.l.sessionId, turnId: hit.p.call.turnId };
          const before = draws;
          ctx.select(next);
          if (draws === before) {
            selection = next;
            draw();
          }
        });
        root.append(layer, marker);

        chartHost.replaceChildren(root);
        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        legend.replaceChildren(
          ...(lines.length >= 2 ? lines.map((l) => key(`line-swatch ${lineClass(l.i)}${dashed(l.i) ? ' dashed' : ''}`, sessionLabel(l.v.summary))) : []),
          anyCompaction ? key('swatch-compaction-dot', 'first call after a compaction') : null
        );
        note.textContent = 'Main agent’s context only (fresh input, cache read, and cache creation); subagents run in their own context. x is each call’s index within its session, so sessions line up by progress rather than clock. Hover a point for its breakdown; click to select its turn.';
      }

      return {
        update,
        resize: draw,
        destroy() {
          host.replaceChildren();
        },
      };
    },
  });
})();
