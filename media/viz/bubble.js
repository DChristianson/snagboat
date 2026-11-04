// Bubble chart: each loaded session by how long it ran and how many tokens it
// used, with area for its tool calls and color for the worst finding it had.
// Span includes idle time, since events don't say when someone stepped away. See
// docs/design/visualization-explorer.md for the contract. Clicking a bubble
// announces its session. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_R = 42;
  window.snagboatViz.register({
    id: 'bubble',
    title: 'Bubble chart',
    tags: { category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, compact, fit, ms, niceAxis, secondsText, sessionName, legendKey, vizPanel, interact } = ctx;
      let views = [];
      let selection = null;
      const panel = vizPanel(host, []);

      function draw() {
        if (!views.length) {
          panel.empty('');
          return;
        }
        const rows = views.map((v) => {
          const s = v.summary;
          const warn = v.findings.filter((f) => f.severity === 'warn').length;
          return { v, s, span: (ms(s.lastTs) - ms(s.firstTs)) / 1000, warn, info: v.findings.length - warn };
        });
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 56, r: MAX_R, t: MAX_R, b: 40 };
        const ph = 300;
        const xa = niceAxis(Math.max(1, ...rows.map((r) => r.span)), 5);
        const ya = niceAxis(Math.max(1, ...rows.map((r) => r.s.tokens)), 4);
        const x = (v) => m.l + (v / xa.top) * (width - m.l - m.r);
        const y = (v) => m.t + ph - (v / ya.top) * ph;
        const maxTools = Math.max(1, ...rows.map((r) => r.s.toolCalls));
        const radius = (n) => Math.max(5, Math.sqrt(n / maxTools) * MAX_R);
        const root = svg('svg', { class: 'viz-chart bubble-chart', viewBox: `0 0 ${width} ${m.t + ph + m.b}`, role: 'img', 'aria-label': `Bubble chart of ${rows.length} sessions: tokens against span, area for tool calls` });
        for (const t of xa.ticks) {
          root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: m.t, y2: m.t + ph }));
          root.append(svgText({ class: 'axis-label', x: x(t), y: m.t + ph + 14, 'text-anchor': 'middle' }, secondsText(t)));
        }
        for (const t of ya.ticks) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
          root.append(svgText({ class: 'axis-label', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, compact(t)));
        }
        root.append(svgText({ class: 'axis-label', x: m.l, y: m.t + ph + 32 }, 'Session span, across is time and up is tokens'));
        // Largest first, so a small bubble is never hidden behind a big one.
        for (const r of [...rows].sort((a, b) => b.s.toolCalls - a.s.toolCalls)) {
          const on = selection && selection.sessionId === r.s.sessionId;
          const rad = radius(r.s.toolCalls);
          const g = svg('g', { class: 'bubble' });
          g.append(svg('circle', { class: `bubble-dot ${r.warn ? 'bubble-warn' : r.info ? 'bubble-info' : 'bubble-clean'}${on ? ' bubble-on' : ''}`, cx: x(r.span), cy: y(r.s.tokens), r: rad }));
          // A small bubble's name goes above it, so the name doesn't hide it.
          g.append(svgText({ class: 'bubble-label', x: x(r.span), y: rad < 24 ? y(r.s.tokens) - rad - 4 : y(r.s.tokens) + 4, 'text-anchor': 'middle' }, fit(sessionName(r.s, 40), rad * 2 + 90)));
          interact(ctx, g, {
            label: `${sessionName(r.s)}: ${compact(r.s.tokens)} tokens over ${secondsText(r.span)}`,
            tip: () => [sessionName(r.s), ['Span', secondsText(r.span)], ['Tokens', fmt(r.s.tokens)], ['Tool calls', fmt(r.s.toolCalls)], ['Prompts', fmt(r.s.prompts)], ['Findings', `${fmt(r.warn)} warnings, ${fmt(r.info)} info`]],
            pick: () => ctx.select({ sessionId: r.s.sessionId }),
          });
          root.append(g);
        }
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(legendKey('swatch-bubble-warn', 'has warnings'), legendKey('swatch-bubble-info', 'info findings only'), legendKey('swatch-bubble-clean', 'no findings'));
        panel.note.textContent = 'Area is tool calls. Span runs from first event to last, so it includes idle time. Click a bubble to select its session.';
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
