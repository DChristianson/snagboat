// Box and violin: how a measurement varies from session to session, one row
// each on a shared axis. The violin is the density of the values, the box their
// quartiles, the whiskers reach 1.5 times the box, and the dots beyond are
// outliers. See docs/design/visualization-explorer.md for the contract. Clicking
// an outlier announces its turn; clicking a row, its session. The metric lives
// in the instance. Sees only its host and ctx: no VS Code.
(function () {
  const ROW = 64;
  window.factoryClock.register({
    id: 'box-violin',
    title: 'Box and violin',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, niceAxis, quantile, density, METRICS, metricValues, sessionName, modeButtons, vizPanel, interact } = ctx;
      let metric = METRICS[3];
      let views = [];
      let selection = null;
      const controls = modeButtons('Measure', METRICS.map((m) => [m.key, m.label]), metric.key, (key) => {
        metric = METRICS.find((m) => m.key === key);
        draw();
      });
      const panel = vizPanel(host, [controls]);

      function draw() {
        const rows = views.map((v) => {
          const items = metricValues(v, metric.key);
          return { v, items, sorted: items.map((x) => x.value).sort((a, b) => a - b) };
        }).filter((r) => r.items.length);
        if (!rows.length) {
          panel.empty(views.length ? `Nothing to measure for “${metric.label}” in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const label = Math.min(160, Math.round(width * 0.25));
        const axisH = 34;
        const height = rows.length * ROW + axisH;
        const axis = niceAxis(Math.max(1, ...rows.flatMap((r) => r.sorted)), 5);
        const x = (v) => label + (v / axis.top) * (width - label - 16);
        const root = svg('svg', { class: 'viz-chart box-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${metric.label}, one row per session, ${rows.length} sessions` });
        for (const t of axis.ticks) {
          root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: 0, y2: height - axisH }));
          root.append(svgText({ class: 'axis-label', x: x(t), y: height - axisH + 14, 'text-anchor': 'middle' }, metric.text(t)));
        }
        root.append(svgText({ class: 'axis-label', x: label, y: height - axisH + 30 }, metric.label));
        rows.forEach((r, i) => {
          const y = i * ROW + ROW / 2;
          const sessionId = r.v.summary.sessionId;
          const s = r.sorted;
          const q1 = quantile(s, 0.25);
          const med = quantile(s, 0.5);
          const q3 = quantile(s, 0.75);
          const iqr = q3 - q1;
          const lowFence = s.find((v) => v >= q1 - 1.5 * iqr);
          const highFence = [...s].reverse().find((v) => v <= q3 + 1.5 * iqr);
          const on = selection && selection.sessionId === sessionId;
          const g = svg('g', { class: 'box-row' });
          g.append(svg('rect', { class: 'hit', x: 0, y: y - ROW / 2, width, height: ROW }));
          if (s.length > 2 && s[s.length - 1] > s[0]) {
            const curve = density(s, s[0], s[s.length - 1]);
            const peak = Math.max(...curve.map((p) => p.y)) || 1;
            const half = ROW / 2 - 6;
            const up = curve.map((p) => `${x(p.x).toFixed(1)} ${(y - (p.y / peak) * half).toFixed(1)}`);
            const down = [...curve].reverse().map((p) => `${x(p.x).toFixed(1)} ${(y + (p.y / peak) * half).toFixed(1)}`);
            g.append(svg('path', { class: 'violin', d: `M${up.join(' L')} L${down.join(' L')} Z` }));
          }
          g.append(svg('line', { class: 'whisker', x1: x(lowFence), x2: x(highFence), y1: y, y2: y }));
          g.append(svg('rect', { class: `box${on ? ' box-on' : ''}`, x: x(q1), y: y - 7, width: Math.max(1, x(q3) - x(q1)), height: 14 }));
          g.append(svg('line', { class: 'median', x1: x(med), x2: x(med), y1: y - 7, y2: y + 7 }));
          interact(ctx, g, {
            label: `${sessionName(r.v.summary)}: median ${metric.text(med)}`,
            tip: () => [sessionName(r.v.summary), ['Values', fmt(s.length)], ['Lowest', metric.text(s[0])], ['First quartile', metric.text(q1)], ['Median', metric.text(med)], ['Third quartile', metric.text(q3)], ['Highest', metric.text(s[s.length - 1])]],
            pick: () => ctx.select({ sessionId }),
          });
          root.append(g);
          const name = svgText({ class: `row-label${on ? ' heat-row-on' : ''}`, x: 0, y: y + 4 }, fit(sessionName(r.v.summary), label - 6));
          root.append(name);
          for (const item of r.items) {
            if (item.value >= lowFence && item.value <= highFence) continue;
            const dot = svg('circle', { class: 'outlier', cx: x(item.value), cy: y, r: 3 });
            interact(ctx, dot, {
              label: `Outlier ${metric.text(item.value)}`,
              tip: () => [`Outlier in ${sessionName(r.v.summary)}`, [metric.label, metric.text(item.value)]],
              pick: item.turnId ? () => ctx.select({ sessionId, turnId: item.turnId }) : () => ctx.select({ sessionId }),
            });
            root.append(dot);
          }
        });
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren();
        panel.note.textContent = 'The shape is the density of the values, the box runs between the quartiles with a line at the median, the whisker reaches 1.5 times the box, and dots beyond it are outliers. Click a row to select its session, or a dot to select its turn.';
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
