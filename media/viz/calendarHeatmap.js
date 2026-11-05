// Calendar heatmap: the loaded sessions by local day, a column per week, at
// least a quarter wide so the long view reads as one. It counts the loaded
// sessions, not all that happened on those days. See
// docs/design/visualization-explorer.md for the contract. Clicking a day
// announces that day's busiest session and turn. The measure lives in the
// instance. Sees only its host and ctx: no VS Code.
(function () {
  const MIN_WEEKS = 13;
  const MAX_CELL = 20;
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  window.snagboatViz.register({
    id: 'calendar-heatmap',
    title: 'Calendar heatmap',
    tags: { category: ['temporal', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, el, fmt, compact, callTokens, heatScale, sessionName, legendKey, modeButtons, vizPanel, interact } = ctx;
      let measure = 'tokens';
      let views = [];
      const controls = modeButtons('Show', [['tokens', 'Tokens'], ['calls', 'Model calls'], ['findings', 'Findings']], measure, (key) => {
        measure = key;
        draw();
      });
      const panel = vizPanel(host, [controls]);

      /** Map(dayKey -> { tokens, calls, findings, weights: Map(session\nturn -> tokens) }). */
      function collect() {
        const days = new Map();
        const at = (ts) => {
          const key = dayKey(new Date(ts));
          const d = days.get(key) || { tokens: 0, calls: 0, findings: 0, sessions: new Set(), weights: new Map() };
          days.set(key, d);
          return d;
        };
        for (const v of views) {
          const id = v.summary.sessionId;
          for (const c of v.calls) {
            const d = at(c.ts);
            d.tokens += callTokens(c);
            d.calls++;
            d.sessions.add(id);
            const w = `${id}\n${c.turnId || ''}`;
            d.weights.set(w, (d.weights.get(w) || 0) + callTokens(c));
          }
          for (const f of v.findings) {
            const ts = f.startedTs || f.fromTs;
            if (!ts) continue;
            const d = at(ts);
            d.findings++;
            d.sessions.add(id);
            const w = `${id}\n${f.turnIds[0] || ''}`;
            if (!d.weights.has(w)) d.weights.set(w, 0);
          }
        }
        return days;
      }

      function draw() {
        const days = collect();
        if (!days.size) {
          panel.empty(views.length ? 'No model calls or findings with a time in these sessions.' : '');
          return;
        }
        const keys = [...days.keys()].sort();
        const parse = (k) => {
          const [y, m, d] = k.split('-').map(Number);
          return new Date(y, m - 1, d);
        };
        const last = parse(keys[keys.length - 1]);
        const earliest = parse(keys[0]);
        const lastWeekEnd = addDays(last, 6 - last.getDay());
        const span = Math.ceil((lastWeekEnd - earliest) / (7 * 86400000)) + 1;
        const weeks = Math.max(MIN_WEEKS, span);
        const firstDay = addDays(lastWeekEnd, -(weeks * 7 - 1));
        const width = Math.max(320, host.clientWidth || 800);
        const dayLabel = 34;
        const head = 18;
        const cell = Math.max(8, Math.min(MAX_CELL, Math.floor((width - dayLabel) / weeks)));
        const value = (d) => (d ? d[measure] : 0);
        const scale = heatScale(Math.max(1, ...[...days.values()].map(value)));
        const fullWidth = dayLabel + weeks * cell;
        const root = svg('svg', { class: 'viz-chart cal-chart', width: fullWidth, height: head + 7 * cell, viewBox: `0 0 ${fullWidth} ${head + 7 * cell}`, role: 'img', 'aria-label': `Calendar of ${measure}, ${weeks} weeks` });
        [1, 3, 5].forEach((wd) => root.append(svgText({ class: 'axis-label', x: 0, y: head + wd * cell + cell - 3 }, new Date(2024, 0, 7 + wd).toLocaleDateString([], { weekday: 'short' }))));
        let lastMonth = -1;
        for (let w = 0; w < weeks; w++) {
          const top = addDays(firstDay, w * 7);
          if (top.getMonth() !== lastMonth) {
            lastMonth = top.getMonth();
            if (w < weeks - 1) root.append(svgText({ class: 'axis-label', x: dayLabel + w * cell, y: head - 6 }, top.toLocaleDateString([], { month: 'short' })));
          }
          for (let i = 0; i < 7; i++) {
            const date = addDays(top, i);
            const d = days.get(dayKey(date));
            const x = dayLabel + w * cell;
            const y = head + i * cell;
            if (!value(d)) {
              root.append(svg('rect', { class: 'heat-empty', x, y, width: cell - 2, height: cell - 2, rx: 2 }));
              continue;
            }
            const best = [...d.weights].sort((a, b) => b[1] - a[1])[0][0].split('\n');
            const name = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
            const sessionNames = [...d.sessions].slice(0, 3).map((id) => sessionName(views.find((v) => v.summary.sessionId === id).summary, 40));
            const rect = svg('rect', { class: `heat heat-${scale.stepOf(value(d))} cal-day`, x, y, width: cell - 2, height: cell - 2, rx: 2 });
            interact(ctx, rect, {
              label: `${name}: ${compact(value(d))} ${measure}`,
              tip: () => [name, ['Tokens', fmt(d.tokens)], ['Model calls', fmt(d.calls)], ['Findings', fmt(d.findings)], ...sessionNames, ...(d.sessions.size > 3 ? [`and ${d.sessions.size - 3} more sessions`] : [])],
              pick: () => ctx.select(best[1] ? { sessionId: best[0], turnId: best[1] } : { sessionId: best[0] }),
            });
            root.append(rect);
          }
        }
        panel.chart.replaceChildren(el('div', { class: 'cal-scroll' }, [root]));
        panel.legend.replaceChildren(
          el('span', { class: 'muted', text: measure === 'calls' ? 'model calls' : measure }),
          ...Array.from({ length: scale.steps }, (_, i) => [i + 1, scale.text(i + 1, measure !== 'tokens')])
            .filter(([, text]) => text)
            .map(([i, text]) => legendKey(`heat-swatch heat-${i}`, text))
        );
        panel.note.textContent = `Local days. Only the ${views.length === 1 ? 'loaded session counts' : `${fmt(views.length)} loaded sessions count`}, so a quiet day here may not have been quiet. Click a day to select its busiest turn.`;
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
