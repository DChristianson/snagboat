// Streamgraph: how a session's activity changed over clock time, as flowing
// layers around a center line. Tokens by agent or by model, or tool calls by
// category, summed into time bins; a layer's thickness is the amount, its
// position only there to keep the layers together. See
// docs/design/visualization-explorer.md for the contract. Clicking a layer
// announces the busiest turn at that time. The mode lives in the instance. Sees
// only its host and ctx: no VS Code.
(function () {
  const BINS = 60;
  window.snagboatViz.register({
    id: 'streamgraph',
    title: 'Streamgraph',
    tags: { category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['session'], dimension: ['time', 'quantity', 'actor'] },
    mount(host, ctx) {
      const { svg, svgText, el, compact, fmt, ms, modelShort, callTokens, secondsText, legendKey, modeButtons, vizPanel } = ctx;
      let mode = 'agent'; // 'agent' | 'model' | 'category'
      let view = null;
      const controls = modeButtons('Show', [['agent', 'Tokens by agent'], ['model', 'Tokens by model'], ['category', 'Tool calls by category']], mode, (key) => {
        mode = key;
        draw();
      });
      const panel = vizPanel(host, [controls]);

      /** The current mode's events: { ts, layer, cls, label, amount, turnId }. */
      function eventsOf(v) {
        if (mode === 'category') return v.tools.map((x) => ({ ts: x.ts, layer: `c${x.colorGroup}`, order: x.colorGroup || 99, cls: `cat-${x.colorGroup}`, label: x.colorGroup ? v.categoryGroups[x.colorGroup - 1] : 'Other tools', amount: 1, turnId: x.turnId }));
        const hues = new Map();
        return v.calls.map((c) => {
          const name = mode === 'agent' ? (c.agentId ? 'Subagents' : 'Main agent') : modelShort(c.model || 'unknown model');
          if (!hues.has(name)) hues.set(name, hues.size);
          return { ts: c.ts, layer: name, order: mode === 'agent' ? (c.agentId ? 1 : 0) : hues.get(name), cls: mode === 'agent' ? (c.agentId ? 'line-1' : 'line-0') : `line-${hues.get(name) % 6}`, label: name, amount: callTokens(c), turnId: c.turnId };
        });
      }

      function draw() {
        if (!view) {
          panel.empty('');
          return;
        }
        const events = eventsOf(view);
        if (!events.length) {
          panel.empty(mode === 'category' ? 'No tool calls in this session.' : 'No model calls with token usage in this session.');
          return;
        }
        const times = events.map((e) => ms(e.ts));
        const from = Math.min(...times);
        const to = Math.max(from + 1000, ...times);
        const binOf = (t) => Math.min(BINS - 1, Math.floor(((t - from) / (to - from)) * BINS));
        const layers = new Map();
        const turns = Array.from({ length: BINS }, () => new Map());
        for (const e of events) {
          const l = layers.get(e.layer) || { key: e.layer, label: e.label, cls: e.cls, order: e.order, bins: new Array(BINS).fill(0), total: 0 };
          const b = binOf(ms(e.ts));
          l.bins[b] += e.amount;
          l.total += e.amount;
          layers.set(e.layer, l);
          if (e.turnId) turns[b].set(e.turnId, (turns[b].get(e.turnId) || 0) + e.amount);
        }
        const stack = [...layers.values()].sort((a, b) => a.order - b.order);
        const totals = Array.from({ length: BINS }, (_, i) => stack.reduce((a, l) => a + l.bins[i], 0));
        const peak = Math.max(1, ...totals);
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 12, r: 12, t: 8, b: 26 };
        const ph = 260;
        const xAt = (i) => m.l + ((i + 0.5) / BINS) * (width - m.l - m.r);
        const k = ph / peak;
        const mid = m.t + ph / 2;
        const root = svg('svg', { class: 'viz-chart stream-chart', viewBox: `0 0 ${width} ${m.t + ph + m.b}`, role: 'img', 'aria-label': `Streamgraph of ${mode === 'category' ? 'tool calls by category' : `tokens by ${mode}`}, ${stack.length} layers` });
        // Ticks on round local times: the first step that fits, offset by the time zone.
        const step = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((n) => n * 60000).find((n) => (to - from) / n <= Math.max(2, Math.floor(width / 110))) || 86400000;
        const zone = new Date(from).getTimezoneOffset() * 60000;
        for (let t = Math.ceil((from - zone) / step) * step + zone; t <= to; t += step) {
          const x = m.l + ((t - from) / (to - from)) * (width - m.l - m.r);
          root.append(svg('line', { class: 'grid', x1: x, x2: x, y1: m.t, y2: m.t + ph }));
          root.append(svgText({ class: 'axis-label', x, y: m.t + ph + 16, 'text-anchor': 'middle' }, new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
        }
        // Silhouette: the stack is centered on the middle line in every bin.
        const base = totals.map((total) => mid - (total * k) / 2);
        const curve = (ys, reverse) => {
          const idx = ys.map((_, i) => i);
          if (reverse) idx.reverse();
          let d = '';
          idx.forEach((i, n) => {
            if (n === 0) {
              d += `${reverse ? 'L' : 'M'}${xAt(i).toFixed(1)} ${ys[i].toFixed(1)}`;
              return;
            }
            const p = idx[n - 1];
            const cx = (xAt(p) + xAt(i)) / 2;
            d += ` C${cx.toFixed(1)} ${ys[p].toFixed(1)} ${cx.toFixed(1)} ${ys[i].toFixed(1)} ${xAt(i).toFixed(1)} ${ys[i].toFixed(1)}`;
          });
          return d;
        };
        const binWidthS = (to - from) / BINS / 1000;
        const binAtEvent = (e) => {
          const box = root.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * width;
          return Math.max(0, Math.min(BINS - 1, Math.floor(((px - m.l) / (width - m.l - m.r)) * BINS)));
        };
        let under = base.slice();
        for (const l of stack) {
          const over = under.map((y, i) => y + l.bins[i] * k);
          const path = svg('path', { class: `stream-layer ${l.cls}`, d: `${curve(under, false)} ${curve(over, true)} Z` });
          path.addEventListener('mousemove', (e) => {
            const b = binAtEvent(e);
            ctx.showTip(e, [l.label, new Date(from + ((b + 0.5) / BINS) * (to - from)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), [mode === 'category' ? 'Calls here' : 'Tokens here', fmt(l.bins[b])], [mode === 'category' ? 'Calls in all' : 'Tokens in all', fmt(l.total)]]);
          });
          path.addEventListener('mouseleave', ctx.hideTip);
          path.addEventListener('click', (e) => {
            const b = binAtEvent(e);
            const best = [...turns[b]].sort((x, y) => y[1] - x[1])[0];
            ctx.select(best ? { sessionId: view.summary.sessionId, turnId: best[0] } : { sessionId: view.summary.sessionId });
          });
          root.append(path);
          under = over;
        }
        panel.chart.replaceChildren(el('div', {}, [root]));
        panel.legend.replaceChildren(...stack.map((l) => legendKey(l.cls, l.label)));
        panel.note.textContent = `Thickness is the amount in a ${secondsText(binWidthS)} bin; the height of the peak is ${mode === 'category' ? `${fmt(peak)} calls` : `${compact(peak)} tokens`}. Up and down have no meaning here, so read thickness rather than position. Click a layer to select the busiest turn at that time.`;
      }
      return {
        update(sessions) {
          view = sessions[0] || null;
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
