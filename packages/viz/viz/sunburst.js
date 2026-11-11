// Sunburst: the turn tree's tokens as rings, from sessions (when there are
// several) out through prompts and agents to tool categories. An arc's angle is
// its share of its parent; outer arcs are drawn longer than inner ones of the
// same value, so it shows structure, and the treemap compares sizes better. The
// tool category ring is the tree's approximate split, marked ≈. See
// docs/design/visualization-explorer.md for the contract. Clicking an arc
// announces { sessionId, turnId? }. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_SIZE = 560;
  const MIN_ANGLE = 0.004; // radians; thinner arcs can't be seen or hovered
  window.snagboatViz.register({
    id: 'sunburst',
    title: 'Sunburst',
    tags: { category: ['quantitative'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy', 'actor'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, compact, clip, arcPath, sessionName, sessionClass, legendKey, vizPanel, interact } = ctx;
      let views = [];
      let selection = null;
      const panel = vizPanel(host, []);

      /** The rings: nested { label, tokens, cls, sessionId, turnId, approx, children }. */
      function forest() {
        const turnOf = (v, p) => (p.turnId ? v.prompts.find((q) => q.turnId === p.turnId) : undefined);
        const sessions = views.map((v, s) => ({
          label: sessionName(v.summary),
          tokens: v.tree.tokens,
          cls: `sun-session ${sessionClass(s)}`,
          sessionId: v.summary.sessionId,
          children: v.tree.children
            .filter((p) => p.kind === 'prompt')
            .map((p) => {
              const q = turnOf(v, p);
              const text = p.turnId ? (v.prompts.find((x) => x.turnId === p.turnId && x.text) || {}).text : undefined;
              const base = { sessionId: v.summary.sessionId, turnId: p.turnId };
              return {
                ...base,
                label: q ? `P${q.index}` : 'Unlinked',
                text,
                tokens: p.tokens,
                cls: p.shade === undefined ? 'sun-unlinked' : `sun-turn-${p.shade}`,
                children: p.children.map((a) => ({
                  ...base,
                  label: a.label,
                  tokens: a.tokens,
                  cls: p.shade === undefined ? 'sun-unlinked' : `sun-agent-${p.shade}`,
                  children: a.children.map((c) => ({ ...base, label: c.label, tokens: c.tokens, approx: true, cls: `cat-${c.colorGroup || 0}`, children: [] })),
                })),
              };
            }),
        }));
        return sessions.length === 1 ? sessions[0].children : sessions;
      }

      function draw() {
        const nodes = forest();
        const total = nodes.reduce((a, n) => a + n.tokens, 0);
        if (!views.length || total <= 0) {
          panel.empty(views.length ? `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const depthOf = (list) => (list.length ? 1 + Math.max(...list.map((n) => depthOf(n.children))) : 0);
        const depth = depthOf(nodes);
        const size = Math.max(280, Math.min(MAX_SIZE, host.clientWidth || MAX_SIZE));
        const cx = size / 2;
        const outer = size / 2 - 4;
        const inner = outer * 0.2;
        const ring = (outer - inner) / depth;
        const root = svg('svg', { class: 'viz-chart sun-chart', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `Sunburst of ${compact(total)} tokens over ${depth} rings` });
        const sel = selection;
        const place = (list, parentTokens, a0, a1, d) => {
          let at = a0;
          for (const n of list) {
            const sweep = (n.tokens / parentTokens) * (a1 - a0);
            const end = at + sweep;
            if (n.tokens > 0 && sweep >= MIN_ANGLE) {
              // A whole ring can't be one arc: stop just short of closing the circle.
              const close = Math.min(end, at + 2 * Math.PI - 0.001);
              const on = !!sel && !!n.turnId && sel.turnId === n.turnId && (!sel.sessionId || sel.sessionId === n.sessionId);
              const p = svg('path', { class: `sun-arc ${n.cls}${on ? ' sun-on' : ''}`, d: arcPath(cx, cx, inner + d * ring, inner + (d + 1) * ring, at, close) });
              const share = Math.round((n.tokens / total) * 100);
              const mark = n.approx ? '≈ ' : '';
              interact(ctx, p, {
                label: `${n.label}: ${mark}${compact(Math.round(n.tokens))} tokens`,
                tip: () => [n.label, ...(n.text ? [clip(n.text, 200)] : []), ['Tokens', `${mark}${fmt(Math.round(n.tokens))}`], ['Of everything', `${mark}${share}%`]],
                pick: n.sessionId ? () => ctx.select(n.turnId ? { sessionId: n.sessionId, turnId: n.turnId } : { sessionId: n.sessionId }) : undefined,
              });
              root.append(p);
              place(n.children, n.tokens, at, end, d + 1);
            }
            at = end;
          }
        };
        place(nodes, total, 0, 2 * Math.PI, 0);
        root.append(svgText({ class: 'week-total', x: cx, y: cx + 2, 'text-anchor': 'middle' }, compact(total)));
        root.append(svgText({ class: 'axis-label', x: cx, y: cx + 17, 'text-anchor': 'middle' }, 'tokens'));
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(...views[0].categoryGroups.map((label, i) => legendKey(`cat-${i + 1}`, label)), legendKey('cat-0', 'Other and replies only'));
        panel.note.textContent = `From the center out: ${views.length > 1 ? 'sessions, ' : ''}prompts, agents, then tool categories, whose sizes are approximate (≈). Outer arcs look bigger than inner ones of the same value, so use the treemap to compare sizes. Click an arc to select its turn.`;
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
