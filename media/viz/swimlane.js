// Swimlane: who had the ball, in order. A lane each for you, the main agent, each
// subagent, and tool calls, with steps left to right and a line for each
// hand-off. Unlike the sequence diagram it reads across, and shows responsibility
// rather than messages; unlike the Gantt, distance isn't time, so a burst stays
// readable. Repeated steps fold into ×N. Long sessions are cut short, with a note;
// a selected turn draws in full. See docs/design/visualization-explorer.md for
// the contract. Clicking a turn's band announces { sessionId, turnId }. Sees only
// its host and ctx: no VS Code.
(function () {
  const LANE = 44;
  const STEP = 30;
  const LABEL = 118;
  const HEAD = 22;
  const CAP = 400;
  window.snagboatViz.register({
    id: 'swimlane',
    title: 'Swimlane',
    tags: { category: ['conversational', 'actor'], purpose: ['informative', 'expressive'], level: ['session'], dimension: ['communication', 'actor'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, clip, fit, ms, legendKey, vizPanel, interact } = ctx;
      let view = null;
      let selection = null;
      const panel = vizPanel(host, []);

      const selectedTurn = () => {
        const s = selection;
        return s && s.turnId && (!s.sessionId || s.sessionId === view.summary.sessionId) && view.prompts.some((p) => p.turnId === s.turnId) ? s.turnId : null;
      };

      /** Steps in time order, repeats folded: { lane, kind, cls, n, failed, turnId, label }. */
      function stepsOf(v) {
        const events = [
          ...v.prompts.map((p, i) => ({ t: ms(p.ts), rank: 0, seq: i, lane: 'you', kind: 'prompt', cls: 'swim-prompt', turnId: p.turnId, label: `P${p.index} prompt`, text: p.text })),
          ...v.calls.map((c, i) => ({ t: ms(c.ts), rank: 1, seq: i, lane: c.agentId || 'main', kind: 'call', cls: 'swim-call', turnId: c.turnId, label: 'Model call' })),
          ...v.tools.map((x, i) => ({ t: ms(x.ts), rank: 2, seq: i, lane: 'tools', kind: `tool:${x.category}`, cls: `cat-${x.colorGroup}`, turnId: x.turnId, label: x.category, failed: x.status === 'failure' })),
          ...v.compactions.map((c, i) => ({ t: ms(c.ts), rank: 3, seq: i, lane: 'main', kind: 'compaction', cls: 'swim-compaction', label: `Compaction (${c.trigger})` })),
        ].sort((a, b) => a.t - b.t || a.rank - b.rank || a.seq - b.seq);
        const steps = [];
        for (const e of events) {
          const last = steps[steps.length - 1];
          // Compactions have no turn of their own: this one belongs to the turn it interrupted.
          if (e.kind === 'compaction' && last) e.turnId = last.turnId;
          if (last && last.lane === e.lane && last.kind === e.kind && last.turnId === e.turnId && e.kind !== 'prompt') {
            last.n++;
            last.failed = last.failed + (e.failed ? 1 : 0);
            continue;
          }
          steps.push({ ...e, n: 1, failed: e.failed ? 1 : 0 });
        }
        return steps;
      }

      function draw() {
        if (!view) {
          panel.empty('');
          return;
        }
        const all = stepsOf(view);
        if (!all.length) {
          panel.empty('Nothing happened in this session yet.');
          return;
        }
        const current = selectedTurn();
        let steps = all;
        let cut = 0;
        if (all.length > CAP) {
          steps = current ? all.filter((s) => s.turnId === current) : all.slice(0, CAP);
          cut = all.length - steps.length;
        }
        const subagents = [...new Set(view.calls.concat(view.tools).map((e) => e.agentId).filter(Boolean))];
        const lanes = [
          { key: 'you', label: 'You' },
          { key: 'main', label: 'Main agent' },
          ...subagents.map((id) => ({ key: id, label: `sub ${id.replace(/^agent-/, '').slice(0, 7)}` })),
          { key: 'tools', label: 'Tool calls' },
        ];
        const yOf = new Map(lanes.map((l, i) => [l.key, HEAD + i * LANE + LANE / 2]));
        const chartW = 12 + steps.length * STEP + 12;
        const height = HEAD + lanes.length * LANE + 2;
        const labels = svg('svg', { class: 'viz-chart swim-labels', width: LABEL, height, viewBox: `0 0 ${LABEL} ${height}` });
        lanes.forEach((l) => labels.append(svgText({ class: 'row-label', x: 0, y: yOf.get(l.key) + 4 }, fit(l.label, LABEL - 4))));
        const root = svg('svg', { class: 'viz-chart swim-chart', width: chartW, height, viewBox: `0 0 ${chartW} ${height}`, role: 'img', 'aria-label': `Swimlane of ${steps.length} steps across ${lanes.length} lanes` });
        const xOf = (i) => 12 + i * STEP + STEP / 2;

        // Bands: a run of steps in one turn.
        const shadeOf = new Map([...new Set(view.prompts.map((p) => p.turnId))].map((t, i) => [t, i % 2]));
        let start = 0;
        for (let i = 1; i <= steps.length; i++) {
          if (i < steps.length && steps[i].turnId === steps[start].turnId) continue;
          const turnId = steps[start].turnId;
          const x = 12 + start * STEP;
          const count = i - start;
          const w = count * STEP;
          if (turnId && shadeOf.has(turnId)) {
            const p = view.prompts.find((q) => q.turnId === turnId);
            const text = (view.prompts.find((q) => q.turnId === turnId && q.text) || {}).text;
            const on = turnId === current;
            const g = svg('g', { class: 'swim-band-hit' });
            g.append(svg('rect', { class: `swim-band turn-${shadeOf.get(turnId)}${on ? ' swim-on' : ''}`, x, y: 2, width: w, height: HEAD - 4, rx: 2 }));
            g.append(svgText({ class: 'swim-band-text', x: x + 4, y: HEAD - 7 }, fit(`P${p.index}`, w)));
            interact(ctx, g, {
              label: `P${p.index}; select this turn`,
              tip: () => [`P${p.index}`, ...(text ? [clip(text, 240)] : []), ['Steps here', fmt(count)]],
              pick: () => ctx.select({ sessionId: view.summary.sessionId, turnId }),
            });
            root.append(g);
            root.append(svg('line', { class: 'swim-divider', x1: x, x2: x, y1: HEAD, y2: height }));
          }
          start = i;
        }
        lanes.forEach((l, i) => root.append(svg('line', { class: 'swim-rule', x1: 0, x2: chartW, y1: HEAD + (i + 1) * LANE, y2: HEAD + (i + 1) * LANE })));
        // Hand-offs, then the steps over them.
        steps.forEach((s, i) => {
          if (i === 0 || steps[i - 1].turnId !== s.turnId) return;
          const a = yOf.get(steps[i - 1].lane);
          const b = yOf.get(s.lane);
          const x0 = xOf(i - 1);
          const x1 = xOf(i);
          const mid = (x0 + x1) / 2;
          root.append(svg('path', { class: 'swim-link', d: `M${x0} ${a} C${mid} ${a} ${mid} ${b} ${x1} ${b}` }));
        });
        steps.forEach((s, i) => {
          const y = yOf.get(s.lane);
          const x = xOf(i);
          const g = svg('g', { class: 'swim-step' });
          if (s.kind === 'compaction') g.append(svg('rect', { class: `swim-node ${s.cls}`, x: x - 6, y: y - 6, width: 12, height: 12, transform: `rotate(45 ${x} ${y})` }));
          else g.append(svg('rect', { class: `swim-node ${s.cls}${s.failed ? ' swim-fail' : ''}`, x: x - 11, y: y - 9, width: 22, height: 18, rx: 4 }));
          if (s.n > 1) g.append(svgText({ class: 'swim-count', x, y: y + 4, 'text-anchor': 'middle' }, s.n > 99 ? '99+' : `×${s.n}`));
          g.addEventListener('mousemove', (e) => ctx.showTip(e, [s.label, ...(s.text ? [clip(s.text, 240)] : []), ...(s.n > 1 ? [['Times in a row', fmt(s.n)]] : []), ...(s.failed ? [['Failed', fmt(s.failed)]] : [])]));
          g.addEventListener('mouseleave', ctx.hideTip);
          root.append(g);
        });
        const scroller = el('div', { class: 'swim-scroll' }, [root]);
        panel.chart.replaceChildren(el('div', { class: 'swim-wrap' }, [labels, scroller]));
        if (current && !cut) {
          const at = steps.findIndex((s) => s.turnId === current);
          if (at >= 0) scroller.scrollLeft = Math.max(0, at * STEP - 40);
        }
        const groups = [...new Set(view.tools.map((x) => x.colorGroup))].sort((a, b) => (a || 99) - (b || 99));
        panel.legend.replaceChildren(
          legendKey('swim-prompt', 'prompt'),
          legendKey('swim-call', 'model call'),
          ...groups.map((g) => legendKey(`cat-${g}`, g ? view.categoryGroups[g - 1] : 'Other tools')),
          ...(view.compactions.length ? [legendKey('swatch-compaction', 'compaction')] : []),
          ...(view.tools.some((x) => x.status === 'failure') ? [legendKey('swatch-gantt-fail', 'includes a failed call')] : [])
        );
        panel.note.textContent = `Steps run left to right in order, and distance isn’t time. Lines are the order of events within a turn, not evidence that one step caused the next. Repeats in a lane fold into ×N.${cut ? ` ${current ? `Showing the selected turn; ${fmt(cut)} other steps are left out.` : `Showing the first ${fmt(CAP)} steps of ${fmt(all.length)}; select a turn to draw it in full.`}` : ''} Click a band to select its turn.`;
      }
      return {
        update(sessions, sel) {
          view = sessions[0] || null;
          selection = sel || null;
          draw();
        },
        resize: draw,
        destroy() {
          ctx.hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
