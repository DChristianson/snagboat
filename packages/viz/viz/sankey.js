// Sankey: where tokens went, flowing from sessions to the main agent or
// subagents to models. Widths are measured tokens, with no tool category split,
// which would be an approximation. See docs/design/visualization-explorer.md for
// the contract. Clicking a ribbon lists the turns behind it, each announcing
// { sessionId, turnId }; a selected turn narrows the ribbons to its own. The
// pinned ribbon lives in the instance. Sees only its host and ctx: no VS Code.
(function () {
  const NODE_W = 12;
  const NODE_GAP = 14;
  const HEIGHT = 340;
  window.snagboatViz.register({
    id: 'sankey',
    title: 'Sankey',
    tags: { category: ['actor', 'quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, clip, fit, modelShort, callTokens, sessionName, sessionClass, legendKey, vizPanel, interact } = ctx;
      let views = [];
      let selection = null;
      let pinned = null;
      const panel = vizPanel(host, []);
      const turnsHost = el('div');
      host.append(turnsHost);

      /** Links: Map(from|to -> { from, to, tokens, turns: Map(session\nturn -> tokens) }), between three columns of nodes. */
      function flows() {
        const nodes = [new Map(), new Map(), new Map()];
        const links = new Map();
        const addNode = (col, key, label, cls, tokens) => {
          const n = nodes[col].get(key) || { key, col, label, cls, value: 0 };
          n.value += tokens;
          nodes[col].set(key, n);
        };
        const addLink = (from, to, cls, tokens, sessionId, turnId) => {
          const key = `${from}|${to}`;
          const l = links.get(key) || { key, from, to, cls, tokens: 0, turns: new Map() };
          l.tokens += tokens;
          const t = `${sessionId}\n${turnId || ''}`;
          l.turns.set(t, (l.turns.get(t) || 0) + tokens);
          links.set(key, l);
        };
        views.forEach((v, s) => {
          const id = v.summary.sessionId;
          for (const c of v.calls) {
            const t = callTokens(c);
            if (t <= 0) continue;
            const agent = c.agentId ? 'a:Subagents' : 'a:Main agent';
            const model = `m:${c.model || 'unknown model'}`;
            addNode(0, `s:${id}`, sessionName(v.summary, 40), sessionClass(s), t);
            addNode(1, agent, agent.slice(2), c.agentId ? 's2' : 's1', t);
            addNode(2, model, modelShort(c.model || 'unknown model'), 'sankey-model', t);
            addLink(`s:${id}`, agent, sessionClass(s), t, id, c.turnId);
            addLink(agent, model, c.agentId ? 's2' : 's1', t, id, c.turnId);
          }
        });
        return { columns: nodes.map((m) => [...m.values()]), links: [...links.values()] };
      }

      function drawTurns(links) {
        const link = links.find((l) => l.key === pinned);
        if (!link) {
          turnsHost.replaceChildren();
          return;
        }
        const rows = [...link.turns].sort((a, b) => b[1] - a[1]).slice(0, 12);
        const nameOf = (k) => {
          if (k.startsWith('m:')) return modelShort(k.slice(2));
          if (k.startsWith('a:')) return k.slice(2);
          return sessionName(views.find((v) => v.summary.sessionId === k.slice(2)).summary, 40);
        };
        turnsHost.replaceChildren(
          el('p', { class: 'small ribbon-turns-head', text: `${nameOf(link.from)} → ${nameOf(link.to)}: the costliest turns${link.turns.size > rows.length ? ` (${rows.length} of ${fmt(link.turns.size)})` : ''}` }),
          el(
            'ul',
            { class: 'terms-prompts' },
            rows.map(([key, tokens]) => {
              const [sessionId, turnId] = key.split('\n');
              const v = views.find((x) => x.summary.sessionId === sessionId);
              const p = turnId && v.prompts.find((q) => q.turnId === turnId);
              const text = turnId && (v.prompts.find((q) => q.turnId === turnId && q.text) || {}).text;
              const b = el('button', { class: 'terms-prompt' }, [el('span', { class: 'muted', text: `${p ? `P${p.index}` : 'Unlinked'} · ${compact(tokens)} tokens ` }), text ? clip(text, 120) : '']);
              b.addEventListener('click', () => ctx.select(turnId ? { sessionId, turnId } : { sessionId }));
              return el('li', {}, [b]);
            })
          )
        );
      }

      function draw() {
        const { columns, links } = flows();
        if (!links.length) {
          panel.empty(views.length ? `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          turnsHost.replaceChildren();
          return;
        }
        const width = Math.max(420, host.clientWidth || 800);
        const total = columns[1].reduce((a, n) => a + n.value, 0);
        const most = Math.max(...columns.map((c) => c.length));
        const scale = (HEIGHT - (most - 1) * NODE_GAP) / total;
        const label = Math.min(150, width * 0.22);
        const xs = [label, (width - NODE_W) / 2, width - label - NODE_W];
        const byKey = new Map();
        let bottom = HEIGHT;
        columns.forEach((col, c) => {
          const room = HEIGHT - (col.reduce((a, n) => a + n.value * scale, 0) + (col.length - 1) * NODE_GAP);
          let y = room / 2 + 3;
          col.sort((a, b) => (c === 1 ? a.key.localeCompare(b.key) : b.value - a.value));
          for (const n of col) {
            n.y = y;
            n.h = Math.max(2, n.value * scale);
            n.out = 0;
            n.in = 0;
            n.x = xs[c];
            byKey.set(n.key, n);
            y += n.h + NODE_GAP;
          }
          bottom = Math.max(bottom, y - NODE_GAP);
        });
        const root = svg('svg', { class: 'viz-chart sankey-chart', viewBox: `0 0 ${width} ${bottom + 6}`, role: 'img', 'aria-label': `Sankey of ${compact(total)} tokens from sessions through agents to models` });
        const sel = selection;
        for (const l of [...links].sort((a, b) => byKey.get(a.from).y - byKey.get(b.from).y || byKey.get(a.to).y - byKey.get(b.to).y)) {
          const a = byKey.get(l.from);
          const b = byKey.get(l.to);
          const h = l.tokens * scale;
          const y0 = a.y + a.out;
          const y1 = b.y + b.in;
          a.out += h;
          b.in += h;
          const x0 = a.x + NODE_W;
          const x1 = b.x;
          const mid = (x0 + x1) / 2;
          const inTurn = !sel || !sel.turnId || [...l.turns.keys()].some((k) => k.endsWith(`\n${sel.turnId}`) && (!sel.sessionId || k.startsWith(`${sel.sessionId}\n`)));
          const g = svg('g', { class: `ribbon${inTurn ? '' : ' ribbon-dim'}${l.key === pinned ? ' ribbon-on' : ''}` });
          g.append(svg('path', { class: `ribbon-shape ${l.cls}`, d: `M${x0} ${y0} C${mid} ${y0} ${mid} ${y1} ${x1} ${y1} L${x1} ${y1 + h} C${mid} ${y1 + h} ${mid} ${y0 + h} ${x0} ${y0 + h} Z` }));
          interact(ctx, g, {
            label: `${a.label} to ${b.label}: ${compact(l.tokens)} tokens; list its turns`,
            tip: () => [`${a.label} → ${b.label}`, ['Tokens', fmt(l.tokens)], ['Share', `${Math.round((l.tokens / total) * 100)}%`], ['Turns', fmt(l.turns.size)]],
            pick: () => {
              pinned = pinned === l.key ? null : l.key;
              draw();
            },
          });
          root.append(g);
        }
        for (const col of columns) {
          for (const n of col) {
            root.append(svg('rect', { class: `sankey-node ${n.cls}`, x: n.x, y: n.y, width: NODE_W, height: n.h, rx: 2 }));
            const left = n.x < width / 3;
            const right = n.x > (width * 2) / 3;
            const avail = left || right ? label - 8 : 160;
            const t = svgText({ class: 'row-label sankey-label', x: left ? n.x - 6 : n.x + NODE_W + 6, y: n.y + n.h / 2 + 4, 'text-anchor': left ? 'end' : 'start' }, fit(`${n.label} ${compact(n.value)}`, avail));
            root.append(t);
          }
        }
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(legendKey('s1', 'main agent'), legendKey('s2', 'subagents'), legendKey('sankey-model', 'model'));
        panel.note.textContent = `Width is measured tokens, ${compact(total)} in all. A ribbon takes its source’s color. Click a ribbon to list its costliest turns${sel && sel.turnId ? '; ribbons outside the selected turn are dimmed' : ''}.`;
        drawTurns(links);
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
