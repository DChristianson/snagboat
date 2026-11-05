// Adjacency matrix: who acted on whom, as a grid. Rows are the actor acting, and
// columns the actor acted on: messages, delegation, model calls, and tool calls.
// A pair has one kind of relationship, named in its tooltip, and delegation is
// outlined dashed because it's inferred from agent ids and order. Unlike the
// actor graph, it stays readable when many actors interact. See
// docs/design/visualization-explorer.md for the contract. Clicking a cell
// announces the turn with the most of that interaction. Sees only its host and
// ctx: no VS Code.
(function () {
  const MAX_SUBAGENTS = 8;
  const CELL = 34;
  window.snagboatViz.register({
    id: 'adjacency-matrix',
    title: 'Adjacency matrix',
    tags: { category: ['actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, fit, modelShort, heatScale, legendKey, vizPanel, interact } = ctx;
      let views = [];
      let selection = null;
      const panel = vizPanel(host, []);

      function build() {
        const subagents = new Set();
        for (const v of views) for (const c of [...v.calls, ...v.tools]) if (c.agentId) subagents.add(c.agentId);
        const fold = subagents.size > MAX_SUBAGENTS;
        const short = (id) => `sub ${id.replace(/^agent-/, '').slice(0, 7)}`;
        const actors = new Map();
        const actor = (key, label, kind, order) => {
          if (!actors.has(key)) actors.set(key, { key, label, kind, order });
          return key;
        };
        const you = () => actor('you', 'You', 'you', 0);
        const agentOf = (id) => (!id ? actor('main', 'Main agent', 'agent', 1) : fold ? actor('subs', 'Subagents', 'subagent', 2) : actor(`sub:${id}`, short(id), 'subagent', 2));
        const cells = new Map();
        const add = (from, to, type, sessionId, turnId, inferred, failed) => {
          const key = `${from}|${to}`;
          const c = cells.get(key) || { from, to, type, inferred, count: 0, failed: 0, turns: new Map() };
          c.count++;
          if (failed) c.failed++;
          const t = `${sessionId}\n${turnId || ''}`;
          c.turns.set(t, (c.turns.get(t) || 0) + 1);
          cells.set(key, c);
        };
        for (const v of views) {
          const id = v.summary.sessionId;
          const turns = new Set(v.prompts.map((p) => p.turnId));
          for (const t of turns) add(you(), agentOf(null), 'Message: a prompt', id, t, false);
          const answered = new Set();
          const delegated = new Set();
          for (const c of v.calls) {
            const model = actor(`model:${c.model || '?'}`, modelShort(c.model || 'unknown model'), 'model', 3);
            add(agentOf(c.agentId), model, 'Model call', id, c.turnId, false);
            if (!c.agentId && c.turnId && !answered.has(c.turnId)) {
              answered.add(c.turnId);
              add(agentOf(null), you(), 'Message: a turn’s reply', id, c.turnId, false);
            }
          }
          for (const e of [...v.calls, ...v.tools]) {
            if (!e.agentId || !e.turnId) continue;
            const k = `${e.turnId}|${e.agentId}`;
            if (delegated.has(k)) continue;
            delegated.add(k);
            add(agentOf(null), agentOf(e.agentId), 'Delegation (inferred)', id, e.turnId, true);
          }
          for (const x of v.tools) {
            const tool = actor(`tool:${x.category}`, x.category, 'tool', 4 + (x.colorGroup || 9) / 10);
            add(agentOf(x.agentId), tool, 'Tool call', id, x.turnId, false, x.status === 'failure');
          }
        }
        const list = [...actors.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
        return { list, cells, fold };
      }

      function draw() {
        const { list, cells, fold } = build();
        if (!cells.size) {
          panel.empty(views.length ? `No interactions in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const label = 130;
        const head = 110;
        const fullW = label + list.length * CELL + 110;
        // Models and tools never act here, so they have a column but no row.
        const rows = list.filter((a) => [...cells.values()].some((c) => c.from === a.key));
        const fullH = head + rows.length * CELL + 2;
        const scale = heatScale(Math.max(...[...cells.values()].map((c) => c.count)));
        const root = svg('svg', { class: 'viz-chart adj-chart', width: fullW, height: fullH, viewBox: `0 0 ${fullW} ${fullH}`, role: 'img', 'aria-label': `Adjacency matrix of ${list.length} actors and ${cells.size} relationships` });
        const sel = selection;
        list.forEach((a, c) => {
          const x = label + c * CELL + CELL / 2 + 3;
          root.append(svgText({ class: 'axis-label', transform: `translate(${x} ${head - 6}) rotate(-45)` }, fit(a.label, 130)));
        });
        rows.forEach((row, r) => {
          const y = head + r * CELL;
          root.append(svgText({ class: 'row-label', x: 0, y: y + CELL / 2 + 4 }, fit(row.label, label - 4)));
          list.forEach((col, c) => {
            const x = label + c * CELL;
            const cell = cells.get(`${row.key}|${col.key}`);
            if (!cell) {
              root.append(svg('rect', { class: 'heat-empty', x, y, width: CELL - 2, height: CELL - 2 }));
              return;
            }
            const [best] = [...cell.turns].sort((p, q) => q[1] - p[1]);
            const [sessionId, turnId] = best[0].split('\n');
            const on = !!sel && !!sel.turnId && [...cell.turns.keys()].some((k) => k.endsWith(`\n${sel.turnId}`) && (!sel.sessionId || k.startsWith(`${sel.sessionId}\n`)));
            const g = svg('g', { class: 'heat-cell' });
            g.append(svg('rect', { class: `heat heat-${scale.stepOf(cell.count)}${cell.inferred ? ' adj-inferred' : ''}${on ? ' adj-on' : ''}`, x, y, width: CELL - 2, height: CELL - 2 }));
            g.append(svgText({ class: 'adj-count', x: x + (CELL - 2) / 2, y: y + CELL / 2 + 3, 'text-anchor': 'middle' }, compact(cell.count)));
            interact(ctx, g, {
              label: `${row.label} to ${col.label}: ${cell.type}, ${fmt(cell.count)}`,
              tip: () => [`${row.label} → ${col.label}`, cell.type, ['Times', fmt(cell.count)], ['Turns', fmt(cell.turns.size)], ...(cell.failed ? [['Failed', fmt(cell.failed)]] : [])],
              pick: () => ctx.select(turnId ? { sessionId, turnId } : { sessionId }),
            });
            root.append(g);
          });
        });
        panel.chart.replaceChildren(el('div', { class: 'cal-scroll' }, [root]));
        panel.legend.replaceChildren(
          el('span', { class: 'muted', text: 'times' }),
          ...Array.from({ length: scale.steps }, (_, i) => [i + 1, scale.text(i + 1, true)])
            .filter(([, text]) => text)
            .map(([i, text]) => legendKey(`heat-swatch heat-${i}`, text)),
          legendKey('swatch-adj-inferred', 'inferred')
        );
        panel.note.textContent = `Each row acts on each column; models and tools only receive, so they have no row. Delegation is inferred from agent ids and order, so it’s outlined dashed and counts each subagent once per turn.${fold ? ` More than ${MAX_SUBAGENTS} subagents, so they’re folded into one.` : ''} ${sel && sel.turnId ? 'Outlined cells happened in the selected turn. ' : ''}Click a cell to select the turn with the most of it.`;
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
