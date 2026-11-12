// Session strips: one row per session over clock time, each turn a block
// from its first prompt to its last call (two alternating shades, as the
// tree), compactions as ticks, findings as the timeline's badges. Idle gaps
// stay visible, which the tree can't show. See
// docs/design/visualization-explorer.md for the contract. A project-level
// visualizer: draws every session it's given on one time axis, one session
// as one row. Clicking a turn announces { sessionId, turnId }. Sees only its
// host and ctx: no VS Code.
(function () {
  window.factoryClock.register({
    id: 'session-strips',
    title: 'Session strips',
    tags: { category: ['temporal', 'state'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, short, formatTime, ms, showTip, hideTip } = ctx;
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small strips-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(chartHost, legend, note);
      let views = [];
      let selection = null;
      let draws = 0;

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));
      function spanText(fromMs, toMs) {
        const s = Math.round((toMs - fromMs) / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.round(s / 60);
        return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
      }
      const findingState = (f) => (f.active ? 'Active now' : 'Earlier');
      function findingTip(f) {
        return [`▲ ${f.heuristicId} (${f.severity === 'warn' ? 'warning' : 'info'})`, f.summary, ['State', findingState(f)], ['Started', formatTime(f.startedTs || f.fromTs)]];
      }

      function update(sessions, sel) {
        views = sessions;
        selection = sel || null;
        draw();
      }

      /** The session's turns in prompt order: [from, to] over its prompts and calls, with tokens and calls. */
      function turnsOf(v) {
        const byTurn = new Map();
        for (const p of v.prompts) {
          const t = byTurn.get(p.turnId) || { turnId: p.turnId, index: p.index, from: ms(p.ts), to: ms(p.ts), tokens: 0, calls: 0, text: undefined };
          t.from = Math.min(t.from, ms(p.ts));
          t.to = Math.max(t.to, ms(p.ts));
          if (!t.text && p.text) t.text = p.text;
          byTurn.set(p.turnId, t);
        }
        const unlinked = { from: Infinity, to: -Infinity, tokens: 0, calls: 0 };
        for (const c of v.calls) {
          const t = c.turnId && byTurn.get(c.turnId);
          const target = t || unlinked;
          target.from = Math.min(target.from, ms(c.ts));
          target.to = Math.max(target.to, ms(c.ts));
          target.tokens += c.input + c.cacheRead + c.cacheCreation + c.output;
          target.calls += 1;
        }
        return { turns: [...byTurn.values()].sort((a, b) => a.index - b.index), unlinked: unlinked.calls ? unlinked : null };
      }

      function draw() {
        draws++;
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        if (views.every((v) => v.calls.length === 0)) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const rows = views.map((v) => ({ v, ...turnsOf(v) }));
        const times = rows.flatMap((r) => [...r.turns.flatMap((t) => [t.from, t.to]), ...(r.unlinked ? [r.unlinked.from, r.unlinked.to] : []), ms(r.v.summary.firstTs), ms(r.v.summary.lastTs)]);
        const t0 = Math.min(...times);
        const t1raw = Math.max(...times);
        const t1 = t1raw > t0 ? t1raw : t0 + 60_000;
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 130, r: 12, t: 18, b: 22 };
        const rowH = 26;
        const gap = 14; // room for a badge above each row
        const height = m.t + rows.length * (rowH + gap) - gap + 6 + m.b;
        const pw = width - m.l - m.r;
        const x = (t) => m.l + ((t - t0) / (t1 - t0)) * pw;
        const axisY = height - m.b;
        const selectedTurn = selection && selection.turnId;
        const selectedSession = selection && selection.sessionId;
        const root = svg('svg', { class: 'viz-chart strips-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Session strips: ${views.length} session${views.length === 1 ? '' : 's'} over clock time` });

        // Time axis: vertical grid with labels, dated when the span crosses a day.
        const multiDay = new Date(t0).toDateString() !== new Date(t1).toDateString();
        for (let k = 0; k <= 5; k++) {
          const t = t0 + ((t1 - t0) * k) / 5;
          root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: m.t - 4, y2: axisY }));
          const lab = svg('text', { class: 'axis-label', x: x(t), y: axisY + 14, 'text-anchor': k === 0 ? 'start' : k === 5 ? 'end' : 'middle' });
          const d = new Date(t);
          lab.textContent = (multiDay ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          root.append(lab);
        }

        rows.forEach((r, i) => {
          const v = r.v;
          const sessionId = v.summary.sessionId;
          const y = m.t + i * (rowH + gap);
          const label = svg('text', { class: 'row-label', x: m.l - 10, y: y + 17, 'text-anchor': 'end' });
          label.textContent = fit(sessionLabel(v.summary), m.l - 14);
          label.addEventListener('mousemove', (e) => showTip(e, [v.summary.name ? `${v.summary.name} (${short(sessionId)})` : sessionId, ['Prompts', fmt(v.summary.prompts)], ['Tokens', fmt(v.summary.tokens)], ['Span', spanText(ms(v.summary.firstTs), ms(v.summary.lastTs))]]));
          label.addEventListener('mouseleave', hideTip);
          root.append(label);

          if (r.unlinked) {
            const u = r.unlinked;
            const block = svg('rect', { class: 'strip-turn node-unlinked', x: x(u.from), y, width: Math.max(2, x(u.to) - x(u.from)), height: rowH, rx: 2 });
            block.addEventListener('mousemove', (e) => showTip(e, [`Unlinked calls · ${formatTime(new Date(u.from).toISOString())}`, ['Model calls', fmt(u.calls)], ['Tokens', fmt(u.tokens)]]));
            block.addEventListener('mouseleave', hideTip);
            root.append(block);
          }
          for (const t of r.turns) {
            const selected = t.turnId === selectedTurn && (!selectedSession || selectedSession === sessionId);
            const g = svg('g', { class: 'strip-turn-hit', tabindex: 0, role: 'button' });
            g.append(svg('rect', { class: `strip-turn turn-${t.index % 2}${selected ? ' strip-selected' : ''}`, x: x(t.from), y, width: Math.max(2, x(t.to) - x(t.from)), height: rowH, rx: 2 }));
            const pick = () => {
              const before = draws;
              ctx.select({ sessionId, turnId: t.turnId });
              if (draws === before) {
                selection = { sessionId, turnId: t.turnId };
                draw();
              }
            };
            g.addEventListener('click', pick);
            g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
            g.addEventListener('mousemove', (e) =>
              showTip(e, [`P${t.index} · ${formatTime(new Date(t.from).toISOString())}`, ...(t.text ? [clip(t.text, 240)] : []), ['Duration', spanText(t.from, t.to)], ['Model calls', fmt(t.calls)], ['Tokens', fmt(t.tokens)]])
            );
            g.addEventListener('mouseleave', hideTip);
            root.append(g);
          }
          for (const c of v.compactions) {
            const cx = x(ms(c.ts));
            const g = svg('g', { class: 'strip-compaction' });
            g.append(svg('line', { class: 'compaction-line', x1: cx, x2: cx, y1: y - 3, y2: y + rowH + 3 }));
            g.append(svg('rect', { class: 'hit', x: cx - 3, y: y - 3, width: 6, height: rowH + 6 }));
            g.addEventListener('mousemove', (e) => showTip(e, [`⤓ compacted${c.trigger === 'manual' ? ' (manual)' : ''} · ${formatTime(c.ts)}`, ...(c.preTokens ? [['Before', fmt(c.preTokens)]] : []), ...(c.postTokens ? [['After', fmt(c.postTokens)]] : [])]));
            g.addEventListener('mouseleave', hideTip);
            root.append(g);
          }
          // Findings: a badge above the row where each starts, nudged right when two would overlap.
          let lastBadgeX = -Infinity;
          for (const f of v.findings) {
            if (!f.fromTs) continue;
            const bx = Math.max(x(ms(f.fromTs)) - 5, lastBadgeX + 12);
            lastBadgeX = bx;
            const by = y - 3;
            const g = svg('g', { class: `finding-mark${f.active ? '' : ' past'}` });
            g.append(svg('path', { class: f.severity === 'warn' ? 'warn-mark' : 'info-mark', d: `M${bx},${by} l5,-9 l5,9 z` }));
            g.append(svg('rect', { class: 'hit', x: bx - 2, y: by - 11, width: 14, height: 13 }));
            g.addEventListener('mousemove', (e) => showTip(e, findingTip(f)));
            g.addEventListener('mouseleave', hideTip);
            root.append(g);
          }
        });

        chartHost.replaceChildren(root);
        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        legend.replaceChildren(
          key('swatch-turn-0', 'turn'),
          key('swatch-turn-1', 'next turn'),
          ...(rows.some((r) => r.unlinked) ? [key('swatch-unlinked', 'unlinked calls')] : []),
          key('swatch-compaction', 'compaction'),
          key('swatch-warn', 'finding (warning)'),
          key('swatch-info', 'finding (info)')
        );
        note.textContent = 'A block runs from a turn’s first prompt to its last model call; gaps between blocks are idle time. Finding badges are filled while active, outlined when past. Hover a block for its prompt; click to select the turn.';
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
