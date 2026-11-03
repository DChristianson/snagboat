// Turn tree (icicle): where the tokens went, by session, then prompt, then
// agent, then tool category. See docs/design/conversation-view.md for the
// view and docs/design/visualization-explorer.md for the contract. Click
// zooms to a node (the focus) and announces { sessionId, turnId, focusId };
// focus(nodeId) on the instance does the same from outside (the Sessions
// tab's breadcrumb). Several sessions draw as a forest under a root
// "sessions" node, widths by tokens. Sees only its host and ctx: no VS Code.
(function () {
  window.snagboatViz.register({
    id: 'turn-tree',
    title: 'Turn tree',
    tags: { category: ['quantitative', 'actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor', 'hierarchy'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, short, findNode, pathTo, showTip, hideTip } = ctx;
      let views = []; // the SessionViews last given, in order
      let byId = new Map(); // sessionId -> SessionView
      let tree = null; // what's drawn: one session's own tree, or a forest over several
      let focusId = null; // node shown at full width; null for the root
      let selection = null;
      let expanded = false;
      let draws = 0;

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));

      // One session draws its own tree with its ids unchanged, so a host can
      // name nodes from the view it holds. Several draw a forest: a root over
      // each session's tree, ids prefixed by session so they stay distinct.
      // Every node remembers its session, for selection and prompt text.
      function assemble(sessions) {
        const tag = (node, sessionId, prefix) => ({ ...node, id: prefix + node.id, sessionId, children: node.children.map((c) => tag(c, sessionId, prefix)) });
        if (sessions.length === 1) return tag(sessions[0].tree, sessions[0].summary.sessionId, '');
        const children = sessions.map((v) => tag(v.tree, v.summary.sessionId, `${v.summary.sessionId}:`));
        return { id: 'sessions', label: 'Sessions', kind: 'sessions', tokens: children.reduce((a, c) => a + c.tokens, 0), children };
      }

      function labelOf(node) {
        if (node.kind !== 'session') return node.label;
        const v = byId.get(node.sessionId);
        if (!v) return node.label;
        return tree.kind === 'sessions' ? sessionLabel(v.summary) : `Session ${sessionLabel(v.summary)}`;
      }

      function update(sessions, sel, options) {
        const same = sessions.length === views.length && sessions.every((v, i) => v.summary.sessionId === views[i].summary.sessionId);
        views = sessions;
        byId = new Map(sessions.map((v) => [v.summary.sessionId, v]));
        selection = sel || null;
        expanded = !!(options && options.expanded);
        tree = sessions.length ? assemble(sessions) : null;
        if (!same) focusId = null;
        if (sel && sel.focusId && tree && findNode(tree, sel.focusId)) focusId = sel.focusId;
        draw();
      }

      // Zoom to a node: a leaf zooms to its parent. The turn selected is the
      // node's own, or the nearest turn above it.
      function focus(id) {
        if (!tree) return;
        const node = findNode(tree, id);
        if (!node) return;
        const path = pathTo(tree, id) || [node];
        focusId = node.children.length ? id : path.length >= 2 ? path[path.length - 2].id : tree.id;
        const turnId = node.turnId || path.map((n) => n.turnId).filter(Boolean).pop() || undefined;
        const before = draws;
        ctx.select({ sessionId: node.sessionId, turnId, focusId });
        if (draws === before) draw(); // the host didn't update in response; redraw anyway
      }

      function draw() {
        draws++;
        if (!tree) return host.replaceChildren();
        const root = (focusId && findNode(tree, focusId)) || tree;
        focusId = root.id;
        const width = Math.max(320, host.clientWidth || 800);
        const rowH = 40;
        const gap = 4;
        const maxDepth = expanded ? 1 : 3;
        const levels = [];
        (function walk(node, depth, x0, x1) {
          (levels[depth] = levels[depth] || []).push({ node, x0, x1 });
          if (depth >= maxDepth || node.tokens <= 0) return;
          let x = x0;
          for (const c of node.children) {
            const w = ((x1 - x0) * c.tokens) / node.tokens;
            walk(c, depth + 1, x, x + w);
            x += w;
          }
        })(root, 0, 0, width);
        const height = (expanded ? levels.length - 1 : levels.length) * (rowH + gap);
        const selectedTurn = selection && selection.turnId;
        const selectedSession = selection && selection.sessionId;
        const root$ = svg('svg', { class: 'tree', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': tree.kind === 'sessions' ? 'Turn tree: where these sessions’ tokens went' : 'Turn tree: where this session’s tokens went' });
        levels.forEach((row, depth) => {
          for (const { node, x0, x1 } of row) {
            if (depth === 0 && expanded) continue; // expanded: show only the prompt row
            const y = (expanded ? depth - 1 : depth) * (rowH + gap);
            const w = x1 - x0;
            if (w < 0.5) continue;
            const selected = node.kind === 'prompt' && node.turnId && node.turnId === selectedTurn && (!selectedSession || node.sessionId === selectedSession);
            const g = svg('g', { class: 'tree-node', tabindex: 0, role: 'button' });
            g.append(svg('rect', { class: nodeClass(node, selected), x: x0 + 1, y, width: Math.max(w - 2, 0.5), height: rowH, rx: 3 }));
            if (node.colorGroup) g.append(svg('rect', { class: `cat-stripe cat-${node.colorGroup}`, x: x0 + 1, y, width: Math.max(w - 2, 0.5), height: 4, rx: 2 }));
            const label = labelOf(node);
            if (w > 36) {
              const t = svg('text', { class: 'node-label', x: x0 + 7, y: y + 16 });
              t.textContent = fit(label, w - (node.findings ? 14 : 0));
              const t2 = svg('text', { class: 'node-sub-label', x: x0 + 7, y: y + 31 });
              t2.textContent = fit(`${node.approximate ? '≈ ' : ''}${compact(node.tokens)}`, w);
              g.append(t, t2);
            }
            if (node.findings && w > 18) {
              const warn = node.findings.some((f) => f.severity === 'warn');
              g.append(svg('path', { class: warn ? 'warn-mark' : 'info-mark', d: `M${x1 - 12},${y + 15} l5,-9 l5,9 z` }));
            }
            const v = byId.get(node.sessionId);
            const promptText = v && node.kind === 'prompt' && node.turnId ? v.prompts.find((p) => p.turnId === node.turnId && p.text)?.text : undefined;
            g.addEventListener('mousemove', (e) =>
              showTip(e, [label, ...(promptText ? [clip(promptText, 240)] : []), ['Tokens', `${node.approximate ? '≈ ' : ''}${fmt(node.tokens)}`], ...(node.findings || []).map((f) => [`▲ ${f.heuristicId}`, f.severity])])
            );
            g.addEventListener('mouseleave', hideTip);
            g.addEventListener('click', () => focus(node.id));
            g.addEventListener('keydown', (e) => e.key === 'Enter' && focus(node.id));
            root$.append(g);
          }
        });
        host.replaceChildren(root$, expanded ? '' : treeLegend(levels));
      }

      // Turns alternate two shades so neighbors contrast; categories take their color group (tinted, with a solid top stripe).
      function nodeClass(node, selected) {
        const parts = ['node'];
        if (node.kind === 'category') parts.push(`cat cat-${node.colorGroup || 0}`);
        else if (node.kind === 'prompt' || node.kind === 'agent') parts.push(node.shade === undefined ? 'node-unlinked' : `turn-${node.shade}`);
        if (node.kind === 'agent') parts.push(node.agentId ? 'node-sub' : 'node-agent');
        if (selected) parts.push('node-selected');
        return parts.join(' ');
      }

      function treeLegend(levels) {
        const shown = levels.flat().map((l) => l.node);
        const groups = new Set(shown.filter((n) => n.kind === 'category').map((n) => n.colorGroup || 0));
        if (!groups.size) return '';
        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        return el('div', { class: 'legend tree-legend small' }, [
          ...views[0].categoryGroups.map((label, i) => (groups.has(i + 1) ? key(`cat-${i + 1}`, label) : '')),
          groups.has(0) ? key('cat-0', 'Other and replies only') : null,
          shown.some((n) => n.kind === 'prompt' && n.shade === undefined) ? key('swatch-unlinked', 'Unlinked') : null,
        ]);
      }

      return {
        update,
        resize: draw,
        destroy() {
          host.replaceChildren();
        },
        focus,
      };
    },
  });
})();
