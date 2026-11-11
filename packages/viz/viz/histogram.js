// Histogram: how a measurement is spread, across the loaded sessions, stacked
// by session when there are several. The last bar gathers anything past the
// 99th percentile, so one huge call doesn't flatten the rest. See
// docs/design/visualization-explorer.md for the contract. Clicking a bar
// announces the turn behind its largest value. The metric lives in the
// instance. Sees only its host and ctx: no VS Code.
(function () {
  const BINS = 20;
  window.snagboatViz.register({
    id: 'histogram',
    title: 'Histogram',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, niceMax, niceAxis, quantile, METRICS, metricValues, sessionName, sessionClass, legendKey, modeButtons, vizPanel, interact } = ctx;
      let metric = METRICS[0];
      let views = [];
      const controls = modeButtons('Measure', METRICS.map((m) => [m.key, m.label]), metric.key, (key) => {
        metric = METRICS.find((m) => m.key === key);
        draw();
      });
      const panel = vizPanel(host, [controls]);

      function draw() {
        const items = views.flatMap((v, s) => metricValues(v, metric.key).map((x) => ({ ...x, s, sessionId: v.summary.sessionId })));
        if (!items.length) {
          panel.empty(views.length ? `Nothing to measure for “${metric.label}” in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const sorted = items.map((x) => x.value).sort((a, b) => a - b);
        const max = sorted[sorted.length - 1];
        const p99 = quantile(sorted, 0.99);
        const clipped = max > p99 * 1.5;
        const top = clipped ? p99 : max;
        const width_ = niceMax(Math.max(top, 1) / BINS);
        const count = Math.max(1, Math.ceil((top + (clipped ? 0 : 1e-9)) / width_));
        const bins = Array.from({ length: count + (clipped ? 1 : 0) }, (_, i) => ({ i, items: [], bySession: views.map(() => 0) }));
        for (const x of items) {
          const b = bins[Math.min(bins.length - 1, Math.floor(x.value / width_))];
          b.items.push(x);
          b.bySession[x.s]++;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 44, r: 12, t: 10, b: 34 };
        const ph = 240;
        const tallest = niceMax(Math.max(...bins.map((b) => b.items.length)));
        const axis = niceAxis(tallest, tallest <= 2 ? tallest : 5); // whole numbers: tops are 1, 2, 5, or 10 times a power of ten
        const y = (v) => m.t + ph - (v / axis.top) * ph;
        const bw = (width - m.l - m.r) / bins.length;
        const root = svg('svg', { class: 'viz-chart', viewBox: `0 0 ${width} ${m.t + ph + m.b}`, role: 'img', 'aria-label': `Histogram of ${metric.label}: ${fmt(items.length)} values in ${bins.length} bins` });
        for (const t of axis.ticks) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
          root.append(svgText({ class: 'axis-label', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t)));
        }
        const rangeOf = (b) => (clipped && b.i === bins.length - 1 ? `${metric.text(b.i * width_)} and up` : `${metric.text(b.i * width_)} to ${metric.text((b.i + 1) * width_)}`);
        const every = Math.max(1, Math.ceil(56 / bw));
        for (const b of bins) {
          const x = m.l + b.i * bw;
          if (b.i % every === 0) root.append(svgText({ class: 'axis-label', x, y: m.t + ph + 14 }, metric.text(b.i * width_)));
          if (!b.items.length) continue;
          const g = svg('g', { class: 'hist-bar' });
          let base = 0;
          b.bySession.forEach((n, s) => {
            if (!n) return;
            g.append(svg('rect', { class: `hist-seg ${views.length > 1 ? sessionClass(s) : 's1'}`, x: x + 1, y: y(base + n), width: Math.max(1, bw - 2), height: Math.max(1, y(base) - y(base + n)) }));
            base += n;
          });
          g.append(svg('rect', { class: 'hit', x, y: m.t, width: bw, height: ph }));
          const biggest = b.items.reduce((a, x2) => (x2.value > a.value && x2.turnId ? x2 : a), b.items.find((x2) => x2.turnId) || b.items[0]);
          interact(ctx, g, {
            label: `${rangeOf(b)}: ${fmt(b.items.length)} values`,
            tip: () => [rangeOf(b), ['Values', fmt(b.items.length)], ...(views.length > 1 ? b.bySession.map((n, s) => [sessionName(views[s].summary, 32), fmt(n)]).filter((r) => r[1] !== '0') : [])],
            pick: () => ctx.select(biggest.turnId ? { sessionId: biggest.sessionId, turnId: biggest.turnId } : { sessionId: biggest.sessionId }),
          });
          root.append(g);
        }
        root.append(svgText({ class: 'axis-label', x: m.l, y: m.t + ph + 30 }, metric.label));
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(...(views.length > 1 ? views.map((v, s) => legendKey(sessionClass(s), sessionName(v.summary, 40))) : []));
        panel.note.textContent = `${fmt(items.length)} values${clipped ? `; the last bar gathers everything past the 99th percentile, up to ${metric.text(max)}` : ''}. Click a bar to select the turn behind its largest value.`;
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
