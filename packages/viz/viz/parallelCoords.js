// Parallel coordinates: every turn as a line across six measures, each axis on
// its own scale from zero, colored by session. Bundles show turns that behave
// alike, and a line that crosses against the rest is a turn worth reading. See
// docs/design/visualization-explorer.md for the contract. Clicking a line
// announces { sessionId, turnId }. Sees only its host and ctx: no VS Code.
(function () {
  const AXES = [
    ['Tokens', (t) => t.tokens, 'compact'],
    ['Model calls', (t) => t.calls, 'fmt'],
    ['Tool calls', (t) => t.tools, 'fmt'],
    ['Failed tools', (t) => t.failures, 'fmt'],
    ['Subagents', (t) => t.subagents.size, 'fmt'],
    ['Length', (t) => (t.to - t.from) / 1000, 'secondsText'],
  ];
  window.factoryClock.register({
    id: 'parallel-coords',
    title: 'Parallel coordinates',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, clip, niceMax, turnStats, sessionName, sessionClass, legendKey, vizPanel, interact } = ctx;
      let views = [];
      let selection = null;
      const panel = vizPanel(host, []);

      function draw() {
        const lines = views.flatMap((v, s) => turnStats(v).map((t) => ({ t, v, s })));
        if (!lines.length) {
          panel.empty(views.length ? `No turns in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const width = Math.max(420, host.clientWidth || 800);
        const m = { l: 34, r: 34, t: 30, b: 22 };
        const ph = 300;
        const gap = (width - m.l - m.r) / (AXES.length - 1);
        const tops = AXES.map(([, of]) => niceMax(Math.max(1, ...lines.map((l) => of(l.t)))));
        const y = (a, v) => m.t + ph - (v / tops[a]) * ph;
        const root = svg('svg', { class: 'viz-chart par-chart', viewBox: `0 0 ${width} ${m.t + ph + m.b}`, role: 'img', 'aria-label': `Parallel coordinates: ${lines.length} turns over ${AXES.length} measures` });
        AXES.forEach(([name, , kind], a) => {
          const x = m.l + a * gap;
          root.append(svg('line', { class: 'par-axis', x1: x, x2: x, y1: m.t, y2: m.t + ph }));
          const anchor = a === 0 ? 'start' : a === AXES.length - 1 ? 'end' : 'middle';
          root.append(svgText({ class: 'row-label', x, y: m.t - 16, 'text-anchor': anchor }, name));
          root.append(svgText({ class: 'axis-label', x, y: m.t - 4, 'text-anchor': anchor }, ctx[kind](tops[a])));
          root.append(svgText({ class: 'axis-label', x, y: m.t + ph + 14, 'text-anchor': anchor }, '0'));
        });
        const sel = selection;
        const isOn = (l) => !!sel && sel.turnId === l.t.turnId && (!sel.sessionId || sel.sessionId === l.v.summary.sessionId);
        const anyOn = lines.some(isOn);
        // The selected line last, so nothing crosses over it.
        for (const l of [...lines].sort((a, b) => Number(isOn(a)) - Number(isOn(b)))) {
          const on = isOn(l);
          const points = AXES.map(([, of], a) => `${(m.l + a * gap).toFixed(1)} ${y(a, of(l.t)).toFixed(1)}`).join(' L');
          const g = svg('g', { class: `par-line${on ? ' par-on' : anyOn ? ' par-dim' : ''}` });
          g.append(svg('path', { class: `par-stroke ${sessionClass(l.s)}`, d: `M${points}` }));
          g.append(svg('path', { class: 'par-hit', d: `M${points}` }));
          interact(ctx, g, {
            label: `P${l.t.index}, ${sessionName(l.v.summary)}; select this turn`,
            tip: () => [`P${l.t.index} · ${sessionName(l.v.summary, 40)}`, ...(l.t.text ? [clip(l.t.text, 180)] : []), ...AXES.map(([name, of, kind]) => [name, ctx[kind](of(l.t))])],
            pick: () => ctx.select({ sessionId: l.v.summary.sessionId, turnId: l.t.turnId }),
          });
          root.append(g);
        }
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(...(views.length > 1 ? views.map((v, s) => legendKey(`${sessionClass(s)} scatter-key`, sessionName(v.summary, 40))) : []));
        panel.note.textContent = 'One line per turn. Each axis has its own scale, from zero at the bottom to the value at its top. Hover a line for its numbers, and click it to select the turn.';
      }
      return {
        update(sessions, sel) {
          views = sessions;
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
