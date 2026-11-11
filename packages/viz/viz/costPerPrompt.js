// Cost per prompt: one column per turn, tokens stacked by agent (main agent,
// then subagents) or, with the toggle, by tool category, from the tree's
// prompt -> agent -> category nodes. Sessions sit side by side as small
// multiples on one y axis, each group labeled with the session's name; an
// Unlinked column appears where the tree has one. The category split is the
// tree's approximation, marked ≈. See docs/design/visualization-explorer.md
// for the contract. Clicking a column announces { sessionId, turnId }. The
// stacking mode lives in the instance, not in saved state. Sees only its
// host and ctx: no VS Code.
(function () {
  window.snagboatViz.register({
    id: 'cost-per-prompt',
    title: 'Cost per prompt',
    tags: { category: ['quantitative', 'conversational'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, niceMax, clip, fit, short, showTip, hideTip } = ctx;
      let mode = 'agent'; // 'agent' | 'category'
      let views = [];
      let selection = null;
      let draws = 0;

      const byAgentBtn = el('button', { text: 'By agent', 'aria-pressed': 'true' });
      const byCategoryBtn = el('button', { text: 'By tool category', 'aria-pressed': 'false' });
      const setMode = (next) => {
        mode = next;
        byAgentBtn.setAttribute('aria-pressed', String(mode === 'agent'));
        byCategoryBtn.setAttribute('aria-pressed', String(mode === 'category'));
        draw();
      };
      byAgentBtn.addEventListener('click', () => setMode('agent'));
      byCategoryBtn.addEventListener('click', () => setMode('category'));
      const controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Stack tokens by' }, [el('span', { class: 'muted small', text: 'Stack by' }), byAgentBtn, byCategoryBtn]);
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small cost-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(controls, chartHost, legend, note);

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));

      function update(sessions, sel) {
        views = sessions;
        selection = sel || null;
        draw();
      }

      /** The series of the current mode, in fixed order: { key, cls, label }. */
      function seriesOf() {
        if (mode === 'agent') {
          return [
            { key: 'main', cls: 's1', label: 'main agent' },
            { key: 'sub', cls: 's2', label: 'subagents' },
          ];
        }
        const groups = views.length ? views[0].categoryGroups : [];
        return [...groups.map((label, i) => ({ key: `cat${i + 1}`, cls: `cat-${i + 1}`, label })), { key: 'cat0', cls: 'cat-0', label: 'Other and replies only' }];
      }

      /** One column per prompt node of the tree: its tokens split into the mode's series. */
      function columnsOf(v) {
        return v.tree.children
          .filter((p) => p.kind === 'prompt')
          .map((p) => {
            const parts = {};
            for (const a of p.children) {
              if (mode === 'agent') {
                const key = a.agentId ? 'sub' : 'main';
                parts[key] = (parts[key] || 0) + a.tokens;
              } else {
                for (const c of a.children) {
                  const key = `cat${c.colorGroup || 0}`;
                  parts[key] = (parts[key] || 0) + c.tokens;
                }
              }
            }
            const total = Object.values(parts).reduce((x, y) => x + y, 0);
            const prompt = p.turnId ? v.prompts.find((q) => q.turnId === p.turnId) : undefined;
            const text = p.turnId ? (v.prompts.find((q) => q.turnId === p.turnId && q.text) || {}).text : undefined;
            return { node: p, turnId: p.turnId, index: prompt ? prompt.index : undefined, label: p.label, parts, total, text };
          });
      }

      function draw() {
        draws++;
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const groups = views.map((v) => ({ v, columns: columnsOf(v) })).filter((g) => g.columns.length);
        const nCols = groups.reduce((a, g) => a + g.columns.length, 0);
        if (!nCols || views.every((v) => v.calls.length === 0)) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const series = seriesOf();
        const approx = mode === 'category';
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 52, r: 12, t: 12, b: 40 };
        const ph = 170;
        const height = m.t + ph + m.b;
        const pw = width - m.l - m.r;
        const gapS = groups.length > 1 ? 18 : 0;
        const colW = (pw - gapS * (groups.length - 1)) / nCols;
        const top = niceMax(Math.max(1, ...groups.flatMap((g) => g.columns.map((c) => c.total))));
        const y = (val) => m.t + ph - (val / top) * ph;
        const axisY = m.t + ph;
        const selectedTurn = selection && selection.turnId;
        const selectedSession = selection && selection.sessionId;
        const root = svg('svg', { class: 'viz-chart cost-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Cost per prompt: tokens per turn stacked by ${mode === 'agent' ? 'agent' : 'tool category'}, ${views.length} session${views.length === 1 ? '' : 's'}` });

        for (const val of [0, top / 2, top]) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: m.l + pw, y1: y(val), y2: y(val) }));
          const lab = svg('text', { class: 'axis-label', x: m.l - 6, y: y(val) + 4, 'text-anchor': 'end' });
          lab.textContent = compact(val);
          root.append(lab);
        }

        // Labels are thinned when columns are narrow; the first column of each group is always labeled.
        const every = Math.max(1, Math.ceil(28 / colW));
        let x = m.l;
        for (const g of groups) {
          const sessionId = g.v.summary.sessionId;
          const x0 = x;
          g.columns.forEach((c, k) => {
            const selected = !!c.turnId && c.turnId === selectedTurn && (!selectedSession || selectedSession === sessionId);
            const col = svg('g', { class: `cost-col${selected ? ' col-selected' : ''}`, tabindex: 0, role: 'button' });
            let base = 0;
            for (const s of series) {
              const val = c.parts[s.key] || 0;
              if (val <= 0) continue;
              const h = y(base) - y(base + val);
              col.append(svg('rect', { class: `seg ${s.cls}`, x: x + 1, y: y(base + val), width: Math.max(0.5, colW - 2), height: Math.max(0.5, h > 2 ? h - 1 : h) }));
              base += val;
            }
            col.append(svg('rect', { class: 'hit', x: x, y: m.t, width: colW, height: ph }));
            if (selected) col.append(svg('rect', { class: 'col-outline', x: x + 0.5, y: y(c.total) - 1, width: Math.max(1, colW - 1), height: Math.max(2, y(0) - y(c.total) + 1), rx: 2 }));
            if (k % every === 0) {
              const t = svg('text', { class: 'axis-label', x: x + colW / 2, y: axisY + 12, 'text-anchor': 'middle' });
              t.textContent = c.turnId ? `P${c.index}` : colW >= 56 ? 'Unlinked' : 'Unl.';
              col.append(t);
            }
            const pick = () => {
              const before = draws;
              ctx.select(c.turnId ? { sessionId, turnId: c.turnId } : { sessionId });
              if (draws === before) {
                selection = c.turnId ? { sessionId, turnId: c.turnId } : { sessionId };
                draw();
              }
            };
            col.addEventListener('click', pick);
            col.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
            col.addEventListener('mousemove', (e) =>
              showTip(e, [
                `${c.turnId ? `P${c.index}` : 'Unlinked calls'} · ${sessionLabel(g.v.summary)}`,
                ...(c.text ? [clip(c.text, 240)] : []),
                ...series.filter((s) => (c.parts[s.key] || 0) > 0).map((s) => [s.label, `${approx ? '≈ ' : ''}${fmt(c.parts[s.key])}`]),
                ['Total', `${approx ? '≈ ' : ''}${fmt(c.total)}`],
              ])
            );
            col.addEventListener('mouseleave', hideTip);
            root.append(col);
            x += colW;
          });
          const gl = svg('text', { class: 'axis-label group-label', x: x0 + 2, y: axisY + 28 });
          gl.textContent = fit(sessionLabel(g.v.summary), x - x0 + gapS - 4);
          root.append(gl);
          x += gapS;
        }

        chartHost.replaceChildren(root);
        // Legend for the series present; a single series needs none.
        const present = series.filter((s) => groups.some((g) => g.columns.some((c) => (c.parts[s.key] || 0) > 0)));
        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        legend.replaceChildren(...(present.length >= 2 ? present.map((s) => key(s.cls, s.label)) : []));
        note.textContent =
          mode === 'agent'
            ? `One y axis across sessions. Subagents run in their own context, counted in their turn’s column.${groups.some((g) => g.columns.some((c) => !c.turnId)) ? ' Unlinked: model calls no prompt claims.' : ''} Click a column to select the turn.`
            : '≈ By tool category is approximate: a turn’s tokens are split across the tool categories it used in proportion to how many calls each made. Click a column to select the turn.';
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
