// Scatter plot: every turn as a point, how long it ran against what it used, on
// log axes because both usually span orders of magnitude. Long turns aren't
// always costly ones, and this is where that shows. See
// docs/design/visualization-explorer.md for the contract. Clicking a point
// announces { sessionId, turnId }. The y measure lives in the instance. Sees
// only its host and ctx: no VS Code.
(function () {
  const Y = [
    ['tokens', 'Tokens', (t) => t.tokens],
    ['calls', 'Model calls', (t) => t.calls],
    ['tools', 'Tool calls', (t) => t.tools],
  ];
  /** A log scale over positive values, with ticks on the powers of ten. */
  function logAxis(values) {
    const pos = values.filter((v) => v > 0);
    const lo = Math.floor(Math.log10(Math.min(...pos, 1)));
    const hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(...pos, 1))));
    const ticks = [];
    for (let p = lo; p <= hi; p++) ticks.push(Math.pow(10, p));
    return { lo, hi, ticks, at: (v) => (Math.log10(v) - lo) / (hi - lo) };
  }
  window.factoryClock.register({
    id: 'scatter',
    title: 'Scatter plot',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, clip, compact, turnStats, secondsText, sessionName, sessionClass, legendKey, modeButtons, vizPanel, interact } = ctx;
      let yKey = 'tokens';
      let views = [];
      let selection = null;
      const controls = modeButtons('Against time, plot', Y.map(([k, label]) => [k, label]), yKey, (key) => {
        yKey = key;
        draw();
      });
      const panel = vizPanel(host, [controls]);

      function draw() {
        const [, yLabel, yOf] = Y.find(([k]) => k === yKey);
        const all = views.flatMap((v, s) => turnStats(v).map((t) => ({ t, s, v, xv: (t.to - t.from) / 1000, yv: yOf(t) })));
        const points = all.filter((p) => p.xv > 0 && p.yv > 0);
        if (!points.length) {
          panel.empty(views.length ? `No turns with both a length and any ${yLabel.toLowerCase()} in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 56, r: 16, t: 10, b: 40 };
        const ph = 300;
        const xa = logAxis(points.map((p) => p.xv));
        const ya = logAxis(points.map((p) => p.yv));
        const x = (v) => m.l + xa.at(v) * (width - m.l - m.r);
        const y = (v) => m.t + ph - ya.at(v) * ph;
        const root = svg('svg', { class: 'viz-chart scatter-chart', viewBox: `0 0 ${width} ${m.t + ph + m.b}`, role: 'img', 'aria-label': `Scatter plot: ${yLabel} against turn length, ${points.length} turns` });
        for (const t of xa.ticks) {
          root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: m.t, y2: m.t + ph }));
          root.append(svgText({ class: 'axis-label', x: x(t), y: m.t + ph + 14, 'text-anchor': 'middle' }, secondsText(t)));
        }
        for (const t of ya.ticks) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
          root.append(svgText({ class: 'axis-label', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, compact(t)));
        }
        root.append(svgText({ class: 'axis-label', x: m.l, y: m.t + ph + 32 }, `Turn length, first event to last (log scale); up is ${yLabel.toLowerCase()} (log scale)`));
        const sel = selection;
        for (const p of points) {
          const sessionId = p.v.summary.sessionId;
          const on = !!sel && sel.turnId === p.t.turnId && (!sel.sessionId || sel.sessionId === sessionId);
          const dot = svg('circle', { class: `scatter-pt ${sessionClass(p.s)}${on ? ' scatter-on' : ''}`, cx: x(p.xv), cy: y(p.yv), r: on ? 6 : 4 });
          interact(ctx, dot, {
            label: `P${p.t.index}: ${secondsText(p.xv)}, ${compact(p.yv)} ${yLabel}`,
            tip: () => [`P${p.t.index} · ${sessionName(p.v.summary, 40)}`, ...(p.t.text ? [clip(p.t.text, 200)] : []), ['Length', secondsText(p.xv)], [yLabel, fmt(p.yv)]],
            pick: () => ctx.select({ sessionId, turnId: p.t.turnId }),
          });
          root.append(dot);
        }
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(...(views.length > 1 ? views.map((v, s) => legendKey(`${sessionClass(s)} scatter-key`, sessionName(v.summary, 40))) : []));
        const left = all.length - points.length;
        panel.note.textContent = `One point per turn, on log axes, where equal distances are equal ratios.${left ? ` Left out, because a log axis can’t draw zero: ${fmt(left)} turn${left === 1 ? '' : 's'} with no length or none of this measure.` : ''} Click a point to select its turn.`;
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
