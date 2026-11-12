// Ridgeline: the shape of a per-call measurement across sessions or models, as
// overlapping density curves on one axis. Each curve is scaled to its own peak,
// so it compares where values fall, not how many there were; the row's label
// has the count. See docs/design/visualization-explorer.md for the contract.
// Clicking a session's ridge announces that session. The choices live in the
// instance. Sees only its host and ctx: no VS Code.
(function () {
  const STEP = 44;
  const LIFT = 70; // a ridge's height; more than STEP, so ridges overlap
  window.factoryClock.register({
    id: 'ridgeline',
    title: 'Ridgeline',
    tags: { category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, modelShort, niceAxis, quantile, density, METRICS, metricValues, sessionName, modeButtons, vizPanel, interact } = ctx;
      const metrics = METRICS.filter((m) => m.perCall);
      let metric = metrics[0];
      let groupBy = 'session';
      let views = [];
      const metricControl = modeButtons('Measure', metrics.map((m) => [m.key, m.label]), metric.key, (key) => {
        metric = metrics.find((m) => m.key === key);
        draw();
      });
      const groupControl = modeButtons('One ridge per', [['session', 'Session'], ['model', 'Model']], groupBy, (key) => {
        groupBy = key;
        draw();
      });
      const panel = vizPanel(host, [metricControl, groupControl]);

      function groups() {
        const out = new Map();
        for (const v of views) {
          for (const x of metricValues(v, metric.key)) {
            const key = groupBy === 'session' ? v.summary.sessionId : x.model || 'unknown model';
            const g = out.get(key) || { key, label: groupBy === 'session' ? sessionName(v.summary) : modelShort(key), values: [], sessionId: groupBy === 'session' ? key : undefined };
            g.values.push(x.value);
            out.set(key, g);
          }
        }
        return [...out.values()];
      }

      function draw() {
        const rows = groups();
        if (!rows.length) {
          panel.empty(views.length ? `Nothing to measure for “${metric.label}” in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const label = Math.min(170, Math.round(width * 0.26));
        const axisH = 34;
        const height = LIFT + (rows.length - 1) * STEP + axisH + 4;
        const axis = niceAxis(Math.max(1, ...rows.flatMap((r) => r.values)), 5);
        const x = (v) => label + (v / axis.top) * (width - label - 16);
        const plotBottom = height - axisH;
        const root = svg('svg', { class: 'viz-chart ridge-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Ridgeline of ${metric.label}: ${rows.length} ridges` });
        for (const t of axis.ticks) {
          root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: 0, y2: plotBottom }));
          root.append(svgText({ class: 'axis-label', x: x(t), y: plotBottom + 14, 'text-anchor': 'middle' }, metric.text(t)));
        }
        root.append(svgText({ class: 'axis-label', x: label, y: plotBottom + 30 }, metric.label));
        rows.forEach((r, i) => {
          const base = LIFT + i * STEP;
          const sorted = [...r.values].sort((a, b) => a - b);
          const curve = density(sorted, 0, axis.top, 80);
          const peak = Math.max(...curve.map((p) => p.y)) || 1;
          const points = curve.map((p) => `${x(p.x).toFixed(1)} ${(base - (p.y / peak) * (LIFT - 6)).toFixed(1)}`);
          const g = svg('g', { class: 'ridge' });
          g.append(svg('path', { class: 'ridge-fill', d: `M${x(0)} ${base} L${points.join(' L')} L${x(axis.top)} ${base} Z` }));
          g.append(svg('path', { class: 'ridge-line', d: `M${points.join(' L')}` }));
          const med = quantile(sorted, 0.5);
          g.append(svg('line', { class: 'ridge-median', x1: x(med), x2: x(med), y1: base - 8, y2: base }));
          interact(ctx, g, {
            label: `${r.label}: median ${metric.text(med)}`,
            tip: () => [r.label, ['Values', fmt(sorted.length)], ['Median', metric.text(med)], ['Highest', metric.text(sorted[sorted.length - 1])]],
            pick: r.sessionId ? () => ctx.select({ sessionId: r.sessionId }) : undefined,
          });
          root.append(g);
          root.append(svgText({ class: 'row-label', x: 0, y: base }, fit(`${r.label} (${fmt(sorted.length)})`, label - 6)));
        });
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren();
        panel.note.textContent = `Each ridge is scaled to its own peak, so compare where the values fall, not the heights; the count is by the name, and the tick is the median.${groupBy === 'session' ? ' Click a ridge to select its session.' : ''}`;
      }
      return {
        update(sessions) {
          views = sessions;
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
