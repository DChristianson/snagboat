// Heatmap: aggregate patterns across the loaded sessions, in three grids behind
// one control. Tokens by session and hour of day (local time), tool calls by
// session and tool category, and findings by heuristic and day. Darker is more,
// in five steps on a square-root scale, because a few cells usually dwarf the
// rest; the legend prints each step's bounds. See
// docs/design/visualization-explorer.md for the contract. Clicking a cell
// announces the session behind it, and its busiest turn where there is one. The
// grid choice lives in the instance. Sees only its host and ctx: no VS Code.
(function () {
  const CELL_H = 26;
  const LABEL = 168;
  const HEAD = 22; // the column labels' height
  const HEAD_TURNED = 48; // and when they're turned to fit
  const STEPS = 5;
  const pad2 = (n) => String(n).padStart(2, '0');

  window.snagboatViz.register({
    id: 'heatmap',
    title: 'Heatmap',
    tags: { category: ['quantitative', 'temporal'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, ms, short, showTip, hideTip } = ctx;
      let mode = 'hours'; // 'hours' | 'tools' | 'findings'
      let views = [];
      let selection = null;

      const buttons = [
        ['hours', 'Tokens by hour'],
        ['tools', 'Tool calls by category'],
        ['findings', 'Findings by day'],
      ].map(([id, text]) => {
        const b = el('button', { text, 'aria-pressed': String(id === mode) });
        b.addEventListener('click', () => {
          mode = id;
          for (const [other, btn] of buttons) btn.setAttribute('aria-pressed', String(other === mode));
          draw();
        });
        return [id, b];
      });
      const controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Which grid' }, [el('span', { class: 'muted small', text: 'Show' }), ...buttons.map(([, b]) => b)]);
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small heat-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(controls, chartHost, legend, note);

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));
      const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;
      const localDay = (ts) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      };
      const dayLabel = (key) => {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
      };
      const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });

      /** Adds to a cell: { value, sessionId, turnTokens: Map(turnId -> weight) }. */
      function add(cells, row, col, value, sessionId, turnId, extra) {
        const key = `${row}|${col}`;
        const cell = cells.get(key) || { row, col, value: 0, sessionId, turns: new Map(), warn: 0, info: 0, summaries: [] };
        cell.value += value;
        if (turnId) cell.turns.set(turnId, (cell.turns.get(turnId) || 0) + value);
        if (extra) extra(cell);
        cells.set(key, cell);
      }

      /** The grid for the current mode: { rows, cols, cells, unit, tip(cell), empty }. */
      function grid() {
        const cells = new Map();
        if (mode === 'hours') {
          const rows = views.map((v) => ({ key: v.summary.sessionId, label: sessionLabel(v.summary), sessionId: v.summary.sessionId }));
          const cols = Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: h % 3 === 0 ? hourLabel(h) : '', full: hourLabel(h) }));
          for (const v of views) for (const c of v.calls) add(cells, v.summary.sessionId, String(new Date(c.ts).getHours()), callTokens(c), v.summary.sessionId, c.turnId);
          return {
            rows,
            cols,
            cells,
            unit: 'tokens',
            empty: 'No model calls with token usage in these sessions.',
            tip: (cell, row, col) => [row.label, `${col.full} (local time)`, ['Tokens', fmt(cell.value)]],
          };
        }
        if (mode === 'tools') {
          const rows = views.map((v) => ({ key: v.summary.sessionId, label: sessionLabel(v.summary), sessionId: v.summary.sessionId }));
          const names = new Map();
          for (const v of views) for (const x of v.tools) names.set(x.category, x.colorGroup);
          const cols = [...names].sort((a, b) => (a[1] || 99) - (b[1] || 99) || a[0].localeCompare(b[0])).map(([name]) => ({ key: name, label: name, full: name }));
          for (const v of views) {
            for (const x of v.tools) {
              add(cells, v.summary.sessionId, x.category, 1, v.summary.sessionId, x.turnId, (cell) => {
                if (x.status === 'failure') cell.warn++;
              });
            }
          }
          return {
            rows,
            cols,
            cells,
            unit: 'tool calls',
            empty: 'No tool calls in these sessions.',
            tip: (cell, row, col) => [row.label, col.full, ['Tool calls', fmt(cell.value)], ...(cell.warn ? [['Failed', fmt(cell.warn)]] : [])],
          };
        }
        const days = new Set();
        const ids = new Set();
        let undated = 0;
        for (const v of views) {
          for (const f of v.findings) {
            const ts = f.startedTs || f.fromTs;
            if (!ts) {
              undated++;
              continue;
            }
            days.add(localDay(ts));
            ids.add(f.heuristicId);
            add(cells, f.heuristicId, localDay(ts), 1, v.summary.sessionId, f.turnIds[0], (cell) => {
              cell[f.severity === 'warn' ? 'warn' : 'info']++;
              if (cell.summaries.length < 3) cell.summaries.push(f.summary);
            });
          }
        }
        return {
          rows: [...ids].sort().map((id) => ({ key: id, label: id })),
          cols: [...days].sort().map((d) => ({ key: d, label: dayLabel(d), full: dayLabel(d) })),
          cells,
          unit: 'findings',
          undated,
          empty: 'No findings in these sessions.',
          tip: (cell, row, col) => [`${row.label} · ${col.full}`, ...cell.summaries.map((s) => clip(s, 160)), ['Findings', fmt(cell.value)], ...(cell.warn ? [['Warnings', fmt(cell.warn)]] : [])],
        };
      }

      function draw() {
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const g = grid();
        if (!g.rows.length || !g.cols.length || !g.cells.size) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: g.empty }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const label = Math.min(LABEL, Math.round(width * 0.3));
        const cellW = (width - label - 2) / g.cols.length;
        // A narrow column turns its label so a long name still has room.
        const turned = cellW < 64 && mode !== 'hours';
        const head = turned ? HEAD_TURNED : HEAD;
        const height = head + g.rows.length * CELL_H + 2;
        const max = Math.max(...[...g.cells.values()].map((c) => c.value));
        // Square-root steps; each step's top value goes in the legend.
        const bound = (i) => (max * (i * i)) / (STEPS * STEPS);
        const stepOf = (v) => {
          for (let i = 1; i <= STEPS; i++) if (v <= bound(i)) return i;
          return STEPS;
        };
        const root = svg('svg', { class: 'viz-chart heat-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Heatmap of ${g.unit}: ${g.rows.length} rows, ${g.cols.length} columns` });

        g.cols.forEach((col, i) => {
          if (!col.label) return;
          const x = label + i * cellW;
          const t = svg('text', turned ? { class: 'axis-label', transform: `translate(${x + cellW / 2 + 4} ${head - 4}) rotate(-30)` } : { class: 'axis-label', x: mode === 'hours' ? x : x + cellW / 2, y: head - 6, 'text-anchor': mode === 'hours' ? 'start' : 'middle' });
          t.textContent = turned ? fit(col.label, 76) : mode === 'hours' ? col.label : fit(col.label, cellW + 8);
          root.append(t);
        });

        const selectedSession = selection && selection.sessionId;
        g.rows.forEach((row, r) => {
          const y = head + r * CELL_H;
          const on = !!row.sessionId && row.sessionId === selectedSession;
          const lab = svg('text', { class: `row-label${on ? ' heat-row-on' : ''}`, x: 0, y: y + CELL_H / 2 + 4 });
          lab.textContent = fit(row.label, label - 4);
          const title = svg('title', {});
          title.textContent = row.label;
          lab.append(title);
          root.append(lab);
          g.cols.forEach((col, c) => {
            const x = label + c * cellW;
            const cell = g.cells.get(`${row.key}|${col.key}`);
            if (!cell) {
              root.append(svg('rect', { class: 'heat-empty', x, y, width: Math.max(0.5, cellW - 1), height: CELL_H - 1 }));
              return;
            }
            const group = svg('g', { class: 'heat-cell', tabindex: 0, role: 'button', 'aria-label': `${row.label}, ${col.full}: ${compact(cell.value)} ${g.unit}` });
            // The busiest turn in the cell, so a click leads to something to read.
            const turnId = [...cell.turns].sort((a, b) => b[1] - a[1]).map(([id]) => id)[0];
            const selected = !!turnId && selection && selection.turnId === turnId && (!selectedSession || selectedSession === cell.sessionId);
            group.append(svg('rect', { class: `heat heat-${stepOf(cell.value)}`, x, y, width: Math.max(0.5, cellW - 1), height: CELL_H - 1 }));
            if (selected) group.append(svg('rect', { class: 'heat-selected', x: x + 1, y: y + 1, width: Math.max(0.5, cellW - 3), height: CELL_H - 3 }));
            group.addEventListener('mousemove', (e) => showTip(e, g.tip(cell, row, col)));
            group.addEventListener('mouseleave', hideTip);
            const pick = () => ctx.select(turnId ? { sessionId: cell.sessionId, turnId } : { sessionId: cell.sessionId });
            group.addEventListener('click', pick);
            group.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
            root.append(group);
          });
        });
        chartHost.replaceChildren(root);

        // Tokens print each step's top. Counts are whole numbers, so they print the
        // numbers each step can hold, and a step too narrow to hold one is left out.
        const stepText = (i) => {
          if (mode === 'hours') return `up to ${compact(Math.round(bound(i)))}`;
          const lo = Math.floor(bound(i - 1)) + 1;
          const hi = Math.floor(bound(i));
          return hi < lo ? null : lo === hi ? fmt(hi) : `${fmt(lo)}–${fmt(hi)}`;
        };
        legend.replaceChildren(
          el('span', { class: 'muted', text: g.unit }),
          ...Array.from({ length: STEPS }, (_, i) => [i + 1, stepText(i + 1)])
            .filter(([, text]) => text)
            .map(([i, text]) => el('span', { class: 'key' }, [el('span', { class: `swatch heat-swatch heat-${i}` }), text]))
        );
        note.textContent =
          mode === 'hours'
            ? 'Hours are local time, across all the days in a session. Click a cell to select its session and that hour’s busiest turn.'
            : mode === 'tools'
              ? 'Calls counted by category, per session. Click a cell to select its session and the turn with the most of those calls.'
              : `Findings counted on the local day each started${g.undated ? `; ${fmt(g.undated)} with no time recorded left out` : ''}. Only the loaded sessions count. Click a cell to select a session and turn behind it.`;
      }

      return {
        update(sessions, sel) {
          views = sessions;
          selection = sel || null;
          draw();
        },
        resize: draw,
        destroy() {
          hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
