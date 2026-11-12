// Radar: a compact profile of each session, one polygon per session over seven
// axes, each scaled to the largest value among the loaded sessions. So it's
// relative, and a lone session fills every axis; the proposal warns that area
// and axis scaling can mislead, and the note says the same. The tooltips have
// the real values. See docs/design/visualization-explorer.md for the contract.
// Clicking a point announces its session. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_SIZE = 480;
  const AXES = [
    ['Tokens', (r) => r.s.tokens],
    ['Prompts', (r) => r.s.prompts],
    ['Model calls', (r) => r.s.modelCalls],
    ['Tool calls', (r) => r.s.toolCalls],
    ['Failed tools', (r) => r.failed],
    ['Subagents', (r) => r.s.subagents],
    ['Findings', (r) => r.findings],
  ];
  window.factoryClock.register({
    id: 'radar',
    title: 'Radar',
    tags: { category: ['quantitative'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, compact, sessionName, sessionClass, legendKey, vizPanel, interact } = ctx;
      let views = [];
      let selection = null;
      const panel = vizPanel(host, []);

      function draw() {
        if (!views.length) {
          panel.empty('');
          return;
        }
        const rows = views.map((v) => ({ v, s: v.summary, failed: v.tools.filter((x) => x.status === 'failure').length, findings: v.findings.length }));
        const tops = AXES.map(([, of]) => Math.max(0, ...rows.map(of)));
        const pad = 110;
        const size = Math.max(220, Math.min(MAX_SIZE, (host.clientWidth || MAX_SIZE) - pad * 2));
        const cx = size / 2 + pad;
        const cy = size / 2 + 20;
        const radius = size / 2 - 8;
        const angle = (i) => (i / AXES.length) * 2 * Math.PI;
        const pt = (i, f) => [cx + radius * f * Math.sin(angle(i)), cy - radius * f * Math.cos(angle(i))];
        const fullW = size + pad * 2;
        const fullH = size + 40;
        const root = svg('svg', { class: 'viz-chart radar-chart', width: fullW, height: fullH, viewBox: `0 0 ${fullW} ${fullH}`, role: 'img', 'aria-label': `Radar of ${rows.length} session${rows.length === 1 ? '' : 's'} over ${AXES.length} axes` });
        for (const f of [0.25, 0.5, 0.75, 1]) root.append(svg('polygon', { class: 'radar-ring', points: AXES.map((_, i) => pt(i, f).join(',')).join(' ') }));
        AXES.forEach(([name], i) => {
          const [x, y] = pt(i, 1);
          root.append(svg('line', { class: 'grid', x1: cx, y1: cy, x2: x, y2: y }));
          const [lx, ly] = pt(i, 1.08);
          const sin = Math.sin(angle(i));
          root.append(svgText({ class: 'axis-label', x: lx, y: ly + 4, 'text-anchor': Math.abs(sin) < 0.1 ? 'middle' : sin > 0 ? 'start' : 'end' }, `${name} ${compact(tops[i])}`));
        });
        const fractions = (r) => AXES.map(([, of], i) => (tops[i] > 0 ? of(r) / tops[i] : 0));
        rows.forEach((r, s) => {
          const on = selection && selection.sessionId === r.s.sessionId;
          root.append(svg('polygon', { class: `radar-shape ${sessionClass(s)}${on ? ' radar-on' : ''}`, points: fractions(r).map((f, i) => pt(i, f).join(',')).join(' ') }));
        });
        rows.forEach((r, s) => {
          fractions(r).forEach((f, i) => {
            const [x, y] = pt(i, f);
            const dot = svg('circle', { class: `radar-pt ${sessionClass(s)}`, cx: x, cy: y, r: 4 });
            interact(ctx, dot, {
              label: `${sessionName(r.s)}, ${AXES[i][0]}: ${fmt(AXES[i][1](r))}`,
              tip: () => [sessionName(r.s), ...AXES.map(([name, of], j) => [`${j === i ? '▸ ' : ''}${name}`, fmt(of(r))])],
              pick: () => ctx.select({ sessionId: r.s.sessionId }),
            });
            root.append(dot);
          });
        });
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(...rows.map((r, s) => legendKey(`${sessionClass(s)} scatter-key`, sessionName(r.s, 40))));
        panel.note.textContent = `Each axis runs from zero to the largest value among the loaded sessions, printed by its name${rows.length === 1 ? ', so one session alone fills every axis it has any of; load more to compare' : ''}. Polygon area depends on the order of the axes, so read the points, not the shape. Hover a point for the numbers, and click one to select its session.`;
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
