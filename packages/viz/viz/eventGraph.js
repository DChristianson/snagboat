// Event graph: one session as a left-to-right graph, one row per turn, a lane
// per agent in the turn. Prompts, model calls, tool calls, and compactions are
// nodes told apart by shape. The events only record their turn, their agent,
// and their order, so only that order is drawn solid; anything saying one event
// led to another is dashed and named as inferred (see the proposal's "don't
// confuse communication with causality"). Positions come from sequence, not
// clock time, so the layout is stable. See docs/design/visualization-explorer.md
// for the contract. A session-level visualizer: draws the first session it's
// given. Clicking a prompt announces { sessionId, turnId }. Sees only its host
// and ctx: no VS Code.
(function () {
  const COL = 36; // px per node along a lane; a lane wider than the host scrolls with the slide
  const GUTTER = 72; // lane labels
  const HEADER = 18; // a turn's time and prompt, above its lanes
  const LANE = 52; // room for arcs above and below a node, and its ×N
  const ROW_GAP = 6;
  const MAX_LANE_NODES = 80;
  const MAX_NODES = 500; // past this, turns keep only their prompt (the selected turn is always drawn)
  const RANK = { prompt: 0, compaction: 1, call: 2, tool: 3 };
  let charts = 0; // marker ids must be unique across stacked charts

  window.snagboatViz.register({
    id: 'event-graph',
    title: 'Event graph',
    tags: { category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, short, formatTime, modelShort, ms, showTip, hideTip } = ctx;
      const legend = el('div', { class: 'legend small eg-legend' });
      const note = el('p', { class: 'muted small eg-note' });
      const chartHost = el('div');
      // The legend comes first: the graph can be much taller than the slide.
      host.replaceChildren(legend, note, chartHost);
      const markerPrefix = `eg${++charts}`;
      let view = null;
      let selection = null;
      let draws = 0;
      let scrolledTo = null; // the selection last scrolled into view

      const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;
      const agentLabel = (id) => `sub ${id.replace(/^agent-/, '').slice(0, 6)}`;

      function update(sessions, sel) {
        view = sessions[0] || null;
        selection = sel || null;
        draw();
        scrollToSelection();
      }

      /** Every event in order, sorted into rows by turn; compactions (which have no turn) go to the turn they fell in. */
      function rowsOf(v) {
        const rows = new Map();
        const firstPrompt = [];
        for (const p of v.prompts) {
          if (!rows.has(p.turnId)) {
            rows.set(p.turnId, { turnId: p.turnId, index: p.index, items: [], firstTs: ms(p.ts) });
            firstPrompt.push({ turnId: p.turnId, at: ms(p.ts) });
          }
          rows.get(p.turnId).items.push({ kind: 'prompt', ts: p.ts, at: ms(p.ts), prompt: p });
        }
        firstPrompt.sort((a, b) => a.at - b.at);
        const unlinked = { turnId: null, index: 0, items: [], firstTs: -Infinity };
        const rowFor = (turnId) => (turnId && rows.get(turnId)) || unlinked;
        for (const c of v.calls) rowFor(c.turnId).items.push({ kind: 'call', ts: c.ts, at: ms(c.ts), agentId: c.agentId, call: c });
        for (const t of v.tools) rowFor(t.turnId).items.push({ kind: 'tool', ts: t.ts, at: ms(t.ts), agentId: t.agentId, tool: t });
        for (const c of v.compactions) {
          const at = ms(c.ts);
          let holder = null;
          for (const f of firstPrompt) if (f.at <= at) holder = f.turnId;
          rowFor(holder).items.push({ kind: 'compaction', ts: c.ts, at, compaction: c });
        }
        const ordered = [...rows.values()].sort((a, b) => a.index - b.index);
        if (unlinked.items.length) ordered.unshift(unlinked);
        for (const r of ordered) r.items.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
        return ordered;
      }

      /**
       * Items to nodes, collapsing repetition: adjacent tool calls of one
       * category become one node, and then a repeated call-and-tool loop (the
       * shape of an agent working one file) becomes one call node and one tool node.
       */
      function nodesOf(items) {
        const nodes = [];
        for (const it of items) {
          const last = nodes[nodes.length - 1];
          if (it.kind === 'tool' && last && last.kind === 'tool' && last.items[0].tool.category === it.tool.category) last.items.push(it);
          else nodes.push({ kind: it.kind, items: [it] });
        }
        const out = [];
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          const b = nodes[i + 1];
          if (a.kind === 'call' && b && b.kind === 'tool') {
            while (nodes[i + 2] && nodes[i + 3] && nodes[i + 2].kind === 'call' && nodes[i + 3].kind === 'tool' && nodes[i + 3].items[0].tool.category === b.items[0].tool.category) {
              a.items.push(...nodes[i + 2].items);
              b.items.push(...nodes[i + 3].items);
              nodes.splice(i + 2, 2);
            }
          }
          out.push(a);
        }
        return out;
      }

      /** One row's lanes: the main agent's, then one per subagent in order of appearance. */
      function lanesOf(row) {
        const groups = new Map([[null, []]]);
        for (const it of row.items) {
          const key = it.agentId || null;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(it);
        }
        return [...groups].map(([agentId, items]) => ({ agentId, items, nodes: nodesOf(items) }));
      }

      const eventCount = (lanes) => lanes.reduce((a, l) => a + l.items.length, 0);

      function tipFor(n) {
        const first = n.items[0];
        const count = n.items.length;
        const when = count > 1 ? `${formatTime(first.ts)} to ${formatTime(n.items[count - 1].ts)}` : formatTime(first.ts);
        if (n.kind === 'prompt') {
          const p = first.prompt;
          return [`Prompt P${p.index} · ${when}`, ...(p.text ? [clip(p.text, 240)] : [])];
        }
        if (n.kind === 'compaction') {
          const c = first.compaction;
          return [`Compaction${c.trigger === 'manual' ? ' (manual)' : ''} · ${when}`, ...(c.preTokens ? [['Before', fmt(c.preTokens)]] : []), ...(c.postTokens ? [['After', fmt(c.postTokens)]] : [])];
        }
        if (n.kind === 'call') {
          const calls = n.items.map((i) => i.call);
          const models = [...new Set(calls.map((c) => c.model).filter(Boolean))].map(modelShort);
          const reply = calls.map((c) => c.reply).find(Boolean);
          return [
            `${count > 1 ? `Model calls ×${count}` : 'Model call'} · ${when}`,
            ['Agent', first.agentId ? agentLabel(first.agentId) : 'main agent'],
            ...(models.length ? [['Model', models.join(', ')]] : []),
            ['Tokens', fmt(calls.reduce((a, c) => a + callTokens(c), 0))],
            ...(reply ? [clip(reply, 200)] : []),
          ];
        }
        const tools = n.items.map((i) => i.tool);
        const names = new Map();
        for (const t of tools) names.set(t.name || 'unnamed', (names.get(t.name || 'unnamed') || 0) + 1);
        const failed = tools.filter((t) => t.status === 'failure').length;
        const unknown = tools.filter((t) => t.status === 'unknown').length;
        const ok = count - failed - unknown;
        return [
          `${count > 1 ? `Tool calls ×${count}` : 'Tool call'} · ${when}`,
          ['Category', tools[0].category],
          ['Agent', first.agentId ? agentLabel(first.agentId) : 'main agent'],
          ...[...names].map(([name, k]) => [name, count > 1 ? `×${k}` : '']),
          ['Status', [ok ? `${ok} succeeded` : '', failed ? `${failed} failed` : '', unknown ? `${unknown} unknown` : ''].filter(Boolean).join(', ')],
        ];
      }

      function draw() {
        draws++;
        if (!view) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const v = view;
        if (!v.prompts.length && !v.calls.length && !v.tools.length && !v.compactions.length) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'No prompts, model calls, or tool calls in this session.' }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }

        const sessionId = v.summary.sessionId;
        const forThisSession = selection && (!selection.sessionId || selection.sessionId === sessionId);
        const selectedTurn = forThisSession ? selection.turnId : undefined;
        const rows = rowsOf(v);
        const hasSelected = !!selectedTurn && rows.some((r) => r.turnId === selectedTurn);

        // The caps: per lane, then for the session. A capped turn keeps its prompt so it stays selectable.
        let used = 0;
        let eventsLeftOut = 0;
        let turnsCapped = 0;
        for (const r of rows) {
          r.lanes = lanesOf(r);
          r.total = eventCount(r.lanes);
          r.shown = r.total;
          const size = r.lanes.reduce((a, l) => a + Math.min(MAX_LANE_NODES, l.nodes.length), 0);
          if (used + size > MAX_NODES && r.turnId !== selectedTurn) {
            r.capped = true;
            turnsCapped++;
            for (const l of r.lanes) l.nodes = l.nodes.filter((n) => n.kind === 'prompt');
            r.lanes = r.lanes.filter((l, i) => i === 0 || l.nodes.length);
          } else {
            used += size;
            for (const l of r.lanes) {
              if (l.nodes.length > MAX_LANE_NODES) l.nodes = l.nodes.slice(0, MAX_LANE_NODES);
            }
          }
          r.shown = r.lanes.reduce((a, l) => a + l.nodes.reduce((b, n) => b + n.items.length, 0), 0);
          eventsLeftOut += r.total - r.shown;
        }

        // Layout: sequence, not time. A subagent's lane starts just after the main-lane node it followed in time.
        let y = 0;
        let maxCols = 1;
        for (const r of rows) {
          r.top = y;
          const main = r.lanes[0];
          main.startCol = 0;
          r.lanes.forEach((lane, li) => {
            if (li > 0) {
              const firstAt = lane.items[0].at;
              let anchorIndex = -1;
              main.nodes.forEach((n, i) => {
                if (n.items[0].at <= firstAt) anchorIndex = i;
              });
              lane.anchor = anchorIndex >= 0 ? main.nodes[anchorIndex] : null;
              lane.startCol = anchorIndex + 1;
            }
            const laneY = y + HEADER + li * LANE + LANE / 2;
            lane.y = laneY;
            lane.nodes.forEach((n, i) => {
              n.x = GUTTER + (lane.startCol + i) * COL + COL / 2;
              n.y = laneY;
              n.halfW = n.kind === 'prompt' ? 15 : n.kind === 'call' ? (n.items.length > 1 ? 11 : 9) : 9;
            });
            maxCols = Math.max(maxCols, lane.startCol + lane.nodes.length);
          });
          r.height = HEADER + r.lanes.length * LANE;
          y += r.height + ROW_GAP;
        }
        const hostWidth = Math.max(320, host.clientWidth || 800);
        const width = Math.max(hostWidth, GUTTER + maxCols * COL + 16);
        const height = Math.max(40, y - ROW_GAP + 4);
        const root = svg('svg', { class: 'viz-chart eg-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Event graph: ${rows.length} row${rows.length === 1 ? '' : 's'}, left to right` });

        const defs = svg('defs');
        for (const kind of ['observed', 'inferred', 'retry']) {
          const marker = svg('marker', { id: `${markerPrefix}-${kind}`, viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, markerUnits: 'userSpaceOnUse', orient: 'auto' });
          marker.append(svg('path', { class: `eg-arrow eg-arrow-${kind}`, d: 'M0,0 L6,3 L0,6 z' }));
          defs.append(marker);
        }
        root.append(defs);

        const edge = (parent, kind, d) => parent.append(svg('path', { class: `eg-edge eg-edge-${kind}`, d, 'marker-end': `url(#${markerPrefix}-${kind})` }));
        const straight = (a, b) => `M${a.x + a.halfW},${a.y} L${b.x - b.halfW - 1},${b.y}`;
        const arcAbove = (a, b) => {
          const top = a.y - 24;
          return `M${a.x},${a.y - 10} C${a.x},${top} ${b.x},${top} ${b.x},${b.y - 11}`;
        };
        const arcBelow = (a, b) => {
          const low = a.y + 25;
          return `M${a.x},${a.y + 10} C${a.x},${low} ${b.x},${low} ${b.x},${b.y + 11}`;
        };
        const selfLoop = (a) => `M${a.x - 5},${a.y + 10} C${a.x - 11},${a.y + 25} ${a.x + 11},${a.y + 25} ${a.x + 5},${a.y + 11}`;
        const link = (parent, kind, a, b, adjacent) => edge(parent, kind, adjacent ? straight(a, b) : arcAbove(a, b));

        // The main lanes' model calls in order, for a compaction's next one.
        const mainCalls = rows.flatMap((r) => r.lanes[0].nodes.filter((n) => n.kind === 'call'));
        const crossRow = [];

        rows.forEach((r) => {
          const selected = !!r.turnId && r.turnId === selectedTurn;
          const g = svg('g', { class: `eg-row${selected ? ' eg-selected' : ''}${hasSelected && !selected ? ' eg-dim' : ''}` });
          r.el = g;
          g.append(svg('rect', { class: 'eg-band', x: 0, y: r.top, width, height: r.height, rx: 3 }));
          const head = svg('text', { class: 'axis-label eg-head', x: 6, y: r.top + 13 });
          const prompt = r.lanes[0].nodes.find((n) => n.kind === 'prompt');
          const left = r.capped ? ` · ${fmt(r.total - r.shown)} event${r.total - r.shown === 1 ? '' : 's'} left out` : '';
          const lead = r.turnId === null ? 'Unlinked: events with no prompt' : `${formatTime(prompt.items[0].ts)}${prompt.items[0].prompt.text ? ` · ${prompt.items[0].prompt.text}` : ''}`;
          head.textContent = fit(`${lead}`, hostWidth - 12 - left.length * 7) + left;
          g.append(head);

          const edges = svg('g', { class: 'eg-edges' });
          const nodes = svg('g');
          g.append(edges, nodes);

          r.lanes.forEach((lane, li) => {
            const label = svg('text', { class: 'axis-label eg-lane', x: 6, y: lane.y + 4 });
            label.textContent = lane.agentId ? agentLabel(lane.agentId) : r.lanes.length > 1 ? 'main' : '';
            nodes.append(label);
            const ns = lane.nodes;

            // Order within this agent is what's observed; a call and the tools after it, and those tools and the next call, are inference.
            ns.forEach((n, i) => {
              const next = ns[i + 1];
              if (next && !((n.kind === 'call' && next.kind === 'tool') || (n.kind === 'tool' && next.kind === 'call') || (n.kind === 'compaction' && next.kind === 'call'))) link(edges, 'observed', n, next, true);
              if (n.kind === 'call') {
                for (let j = i + 1; j < ns.length && ns[j].kind === 'tool'; j++) link(edges, 'inferred', n, ns[j], j === i + 1);
              }
              if (n.kind === 'tool') {
                let k = i + 1;
                while (k < ns.length && ns[k].kind !== 'call' && ns[k].kind !== 'prompt') k++;
                if (ns[k] && ns[k].kind === 'call') link(edges, 'inferred', n, ns[k], k === i + 1);
              }
              if (n.kind === 'compaction') {
                const target = mainCalls.find((c) => c.items[0].at >= n.items[0].at);
                if (target) {
                  const k = ns.indexOf(target);
                  if (k >= 0) link(edges, 'inferred', n, target, k === i + 1);
                  else crossRow.push([n, target, r]);
                }
              }
            });

            // A failed tool call and the next call of the same tool, in this lane: possibly a retry.
            const flat = ns.filter((n) => n.kind === 'tool').flatMap((n) => n.items.map((it) => ({ it, n })));
            const drawn = new Set();
            flat.forEach((f, i) => {
              if (f.it.tool.status !== 'failure') return;
              const key = f.it.tool.name || f.it.tool.category;
              const next = flat.slice(i + 1).find((o) => (o.it.tool.name || o.it.tool.category) === key);
              if (!next) return;
              const id = `${ns.indexOf(f.n)}-${ns.indexOf(next.n)}`;
              if (drawn.has(id)) return;
              drawn.add(id);
              edge(edges, 'retry', next.n === f.n ? selfLoop(f.n) : arcBelow(f.n, next.n));
            });

            if (li > 0 && ns.length) {
              const first = ns[0];
              const a = lane.anchor || r.lanes[0].nodes[0];
              if (a) edge(edges, 'inferred', `M${a.x},${a.y + 10} C${a.x},${first.y} ${a.x},${first.y} ${first.x - first.halfW - 1},${first.y}`);
            }

            for (const n of ns) nodes.append(nodeEl(n, r, sessionId));
          });
          if (r.turnId === null) {
            const dash = svg('text', { class: 'axis-label', x: GUTTER + COL / 2, y: r.lanes[0].y + 4, 'text-anchor': 'middle' });
            if (!r.lanes[0].nodes.length) dash.textContent = 'no main-agent events';
            nodes.append(dash);
          }
          root.append(g);
        });

        // A compaction's next call can be in a later turn: drawn over the rows it crosses.
        if (crossRow.length) {
          const layer = svg('g', { class: 'eg-edges eg-cross' });
          for (const [a, b] of crossRow) {
            const midY = (a.y + b.y) / 2;
            edge(layer, 'inferred', `M${a.x},${a.y + 10} C${a.x},${midY} ${b.x - 40},${midY} ${b.x - b.halfW - 1},${b.y}`);
          }
          root.append(layer);
        }

        chartHost.replaceChildren(root);
        drawLegend(v, rows);
        const parts = ['Solid edges are order the events recorded: same turn, same agent, one after the other. Dashed edges are inferred from that order: the events don’t say what caused what.'];
        const collapsed = rows.some((r) => r.lanes.some((l) => l.nodes.some((n) => n.items.length > 1)));
        if (collapsed) parts.push('×N is a repeated step folded into one node; hover for its parts.');
        if (eventsLeftOut) parts.push(`Left out to stay readable: ${fmt(eventsLeftOut)} of ${fmt(rows.reduce((a, r) => a + r.total, 0))} events${turnsCapped ? ` (${fmt(turnsCapped)} turn${turnsCapped === 1 ? ' shows' : 's show'} only the prompt; select one to draw it)` : ''}.`);
        note.textContent = parts.join(' ');
      }

      function nodeEl(n, r, sessionId) {
        const { x, y } = n;
        const g = svg('g', { class: `eg-node eg-node-${n.kind}` });
        if (n.kind === 'prompt') {
          const p = n.items[0].prompt;
          g.setAttribute('tabindex', '0');
          g.setAttribute('role', 'button');
          g.setAttribute('aria-label', `Prompt ${p.index}: select this turn`);
          g.append(svg('rect', { class: `eg-prompt turn-${p.index % 2}`, x: x - 15, y: y - 11, width: 30, height: 22, rx: 11 }));
          const text = svg('text', { class: 'eg-prompt-label', x, y: y + 4, 'text-anchor': 'middle' });
          text.textContent = `P${p.index}`;
          g.append(text);
          const pick = () => {
            const before = draws;
            ctx.select({ sessionId, turnId: p.turnId });
            if (draws === before) {
              selection = { sessionId, turnId: p.turnId };
              draw();
            }
          };
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
        } else if (n.kind === 'call') {
          g.append(svg('circle', { class: 'eg-call', cx: x, cy: y, r: n.halfW }));
        } else if (n.kind === 'compaction') {
          g.append(svg('path', { class: 'eg-compaction', d: `M${x},${y - 10} L${x + 10},${y} L${x},${y + 10} L${x - 10},${y} z` }));
        } else {
          const group = n.items[0].tool.colorGroup;
          g.append(svg('rect', { class: `eg-tool eg-cat-${group}`, x: x - 9, y: y - 9, width: 18, height: 18, rx: 2 }));
          if (n.items.some((i) => i.tool.status === 'failure')) {
            g.append(svg('circle', { class: 'eg-fail-badge', cx: x + 8, cy: y - 8, r: 5 }));
            g.append(svg('path', { class: 'eg-fail-x', d: `M${x + 6},${y - 10} L${x + 10},${y - 6} M${x + 10},${y - 10} L${x + 6},${y - 6}` }));
          }
        }
        if (n.items.length > 1) {
          const times = svg('text', { class: 'mark-label eg-times', x, y: y + 22, 'text-anchor': 'middle' });
          times.textContent = `×${n.items.length}`;
          g.append(times);
        }
        g.addEventListener('mousemove', (e) => showTip(e, tipFor(n)));
        g.addEventListener('mouseleave', hideTip);
        return g;
      }

      function drawLegend(v, rows) {
        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        const groups = new Set(rows.flatMap((r) => r.items.filter((i) => i.kind === 'tool').map((i) => i.tool.colorGroup)));
        const anyRetry = v.tools.some((t) => t.status === 'failure');
        const keys = [
          key('eg-key-prompt', 'prompt'),
          key('eg-key-call', 'model call'),
          key('eg-key-tool', 'tool call'),
          key('eg-key-compaction', 'compaction'),
          anyRetry ? key('eg-key-fail', 'failed tool call') : null,
          key('eg-key-observed', 'observed order'),
          key('eg-key-inferred', 'inferred: led to'),
          anyRetry ? key('eg-key-retry', 'inferred: possible retry') : null,
          ...v.categoryGroups.map((label, i) => (groups.has(i + 1) ? key(`cat-${i + 1}`, label) : null)),
          groups.has(0) ? key('cat-0', 'other tools') : null,
        ];
        legend.replaceChildren(...keys.filter(Boolean)); // replaceChildren would write a null as text
      }

      /** Brings a newly selected turn into view inside whatever scrolls this chart, never the page. */
      function scrollToSelection() {
        const sessionId = view && view.summary.sessionId;
        const target = view && selection && selection.turnId && (!selection.sessionId || selection.sessionId === sessionId) ? `${selection.turnId}` : null;
        if (target === scrolledTo) return;
        if (!target) {
          scrolledTo = null;
          return;
        }
        const band = chartHost.querySelector('.eg-selected .eg-band');
        if (!band) return;
        const rect = band.getBoundingClientRect();
        if (!rect.height) return; // not laid out yet; the next update tries again
        scrolledTo = target;
        let scroller = host.parentElement;
        while (scroller && scroller !== document.body && scroller !== document.documentElement) {
          const o = getComputedStyle(scroller).overflowY;
          if ((o === 'auto' || o === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
          scroller = scroller.parentElement;
        }
        if (!scroller || scroller === document.body || scroller === document.documentElement) return;
        const box = scroller.getBoundingClientRect();
        if (rect.top < box.top) scroller.scrollTop += rect.top - box.top - 8;
        else if (rect.bottom > box.bottom) scroller.scrollTop += Math.min(rect.top - box.top - 8, rect.bottom - box.bottom + 8);
        scroller.scrollLeft = 0; // the prompt is at the row's start
      }

      return {
        update,
        resize: draw,
        destroy() {
          host.replaceChildren();
        },
      };
    },
  });
})();
