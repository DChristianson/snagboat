// Treemap: tokens as area, from the turn tree's data by another layout. By turn
// nests session, prompt, then tool category; by tool category turns that around,
// so one category's share across sessions reads as one block. Layout is
// squarified (Bruls, Huizing, van Wijk), so blocks stay near square and easy to
// compare. The category split is the tree's approximation, marked ≈. See
// docs/design/visualization-explorer.md for the contract. Clicking a block
// announces { sessionId, turnId? }. The mode lives in the instance. Sees only
// its host and ctx: no VS Code.
(function () {
  const HEIGHT = 440;
  const HEADER = 18; // px kept for a group's label when it's big enough for one
  const GAP = 2;

  /** Lays items ({ value }) out in { x, y, w, h }, largest first; returns [{ item, x, y, w, h }]. */
  function squarify(items, box) {
    const out = [];
    const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
    const total = sorted.reduce((a, i) => a + i.value, 0);
    if (total <= 0 || box.w <= 0 || box.h <= 0) return out;
    const scale = (box.w * box.h) / total;
    let { x, y, w, h } = box;
    let row = [];
    let rowArea = 0;
    // The worst aspect ratio in a row of this area laid along a side of this length.
    const worst = (areas, sum, side) => {
      let max = 0;
      for (const a of areas) max = Math.max(max, (side * side * a) / (sum * sum), (sum * sum) / (side * side * a));
      return max;
    };
    const flush = () => {
      const horizontal = w >= h; // lay the row along the short side
      const side = horizontal ? h : w;
      const thick = rowArea / side;
      let at = horizontal ? y : x;
      for (const r of row) {
        const len = r.area / thick;
        out.push(horizontal ? { item: r.item, x, y: at, w: thick, h: len } : { item: r.item, x: at, y, w: len, h: thick });
        at += len;
      }
      if (horizontal) {
        x += thick;
        w -= thick;
      } else {
        y += thick;
        h -= thick;
      }
      row = [];
      rowArea = 0;
    };
    for (const item of sorted) {
      const area = item.value * scale;
      const side = Math.min(w, h);
      const areas = row.map((r) => r.area);
      if (row.length && worst([...areas, area], rowArea + area, side) > worst(areas, rowArea, side)) flush();
      row.push({ item, area });
      rowArea += area;
    }
    if (row.length) flush();
    return out;
  }

  window.factoryClock.register({
    id: 'treemap',
    title: 'Treemap',
    tags: { category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, short, showTip, hideTip } = ctx;
      let mode = 'turn'; // 'turn' | 'category'
      let views = [];
      let selection = null;

      const byTurnBtn = el('button', { text: 'By turn', 'aria-pressed': 'true' });
      const byCategoryBtn = el('button', { text: 'By tool category', 'aria-pressed': 'false' });
      const setMode = (next) => {
        mode = next;
        byTurnBtn.setAttribute('aria-pressed', String(mode === 'turn'));
        byCategoryBtn.setAttribute('aria-pressed', String(mode === 'category'));
        draw();
      };
      byTurnBtn.addEventListener('click', () => setMode('turn'));
      byCategoryBtn.addEventListener('click', () => setMode('category'));
      const controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Group tokens by' }, [el('span', { class: 'muted small', text: 'Group' }), byTurnBtn, byCategoryBtn]);
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small treemap-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(controls, chartHost, legend, note);

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));
      const OTHER = 'Other and replies only';

      /** A prompt node's tokens by color group, across its agents: Map(group -> tokens). */
      function categoriesOf(prompt) {
        const by = new Map();
        for (const a of prompt.children) {
          if (!a.children.length && a.tokens > 0) by.set(0, (by.get(0) || 0) + a.tokens);
          for (const c of a.children) by.set(c.colorGroup || 0, (by.get(c.colorGroup || 0) || 0) + c.tokens);
        }
        return by;
      }
      const promptText = (v, turnId) => (turnId ? (v.prompts.find((p) => p.turnId === turnId && p.text) || {}).text : undefined);
      const promptName = (v, p) => {
        const q = p.turnId && v.prompts.find((x) => x.turnId === p.turnId);
        return q ? `P${q.index}` : 'Unlinked';
      };
      const groupName = (v, g) => (g ? v.categoryGroups[g - 1] : OTHER);

      /** Nested groups for the current mode; a leaf has cls and no children. */
      function hierarchy() {
        if (mode === 'turn') {
          const sessions = views.map((v) => ({
            label: sessionLabel(v.summary),
            value: v.tree.tokens,
            sessionId: v.summary.sessionId,
            children: v.tree.children
              .filter((p) => p.kind === 'prompt' && p.tokens > 0)
              .map((p) => {
                const name = promptName(v, p);
                const text = promptText(v, p.turnId);
                return {
                  label: name,
                  value: p.tokens,
                  sessionId: v.summary.sessionId,
                  turnId: p.turnId,
                  children: [...categoriesOf(p)].map(([g, value]) => ({
                    label: groupName(v, g),
                    value,
                    cls: `cat-${g}`,
                    sessionId: v.summary.sessionId,
                    turnId: p.turnId,
                    tip: [`${name} · ${groupName(v, g)}`, ...(text ? [clip(text, 200)] : []), sessionLabel(v.summary), ['≈ Tokens', fmt(Math.round(value))], ['Of the turn', `≈ ${Math.round((value / p.tokens) * 100)}%`]],
                  })),
                };
              }),
          }));
          // A single session needs no frame of its own.
          return sessions.length === 1 ? sessions[0].children : sessions;
        }
        const groups = new Map();
        for (const v of views) {
          for (const p of v.tree.children) {
            if (p.kind !== 'prompt') continue;
            for (const [g, value] of categoriesOf(p)) {
              if (value <= 0) continue;
              const key = g;
              const group = groups.get(key) || { label: groupName(v, g), value: 0, g, children: new Map() };
              group.value += value;
              // Within a category: sessions when there are several, turns when there's one.
              const childKey = views.length > 1 ? v.summary.sessionId : p.id;
              const name = views.length > 1 ? sessionLabel(v.summary) : promptName(v, p);
              const child = group.children.get(childKey) || { label: name, value: 0, cls: `cat-${g}`, sessionId: v.summary.sessionId, turnId: views.length > 1 ? undefined : p.turnId, turns: 0 };
              child.value += value;
              child.turns++;
              child.text = views.length > 1 ? undefined : promptText(v, p.turnId);
              group.children.set(childKey, child);
              groups.set(key, group);
            }
          }
        }
        return [...groups.values()].map((group) => ({
          label: group.label,
          value: group.value,
          children: [...group.children.values()].map((c) => ({
            ...c,
            tip: [`${group.label} · ${c.label}`, ...(c.text ? [clip(c.text, 200)] : []), ['≈ Tokens', fmt(Math.round(c.value))], ...(views.length > 1 ? [['Turns', fmt(c.turns)]] : []), ['Of the category', `≈ ${Math.round((c.value / group.value) * 100)}%`]],
          })),
        }));
      }

      const isSelected = (node) => {
        const s = selection;
        if (!s || !node.turnId || node.turnId !== s.turnId) return false;
        return !s.sessionId || s.sessionId === node.sessionId;
      };

      function drawLeaf(root, node, r) {
        const g = svg('g', { class: 'treemap-leaf', tabindex: 0, role: 'button', 'aria-label': `${node.tip[0]}, about ${compact(Math.round(node.value))} tokens` });
        g.append(svg('rect', { class: `treemap-block ${node.cls}`, x: r.x, y: r.y, width: Math.max(0.5, r.w - 1), height: Math.max(0.5, r.h - 1) }));
        const text = r.h >= 16 ? fit(node.label, r.w) : '';
        if (text) {
          const t = svg('text', { class: 'treemap-label', x: r.x + 4, y: r.y + 13 });
          t.textContent = text;
          g.append(t);
          if (r.h >= 30 && r.w >= 44) {
            const v = svg('text', { class: 'treemap-label treemap-value', x: r.x + 4, y: r.y + 26 });
            v.textContent = `≈ ${compact(Math.round(node.value))}`;
            g.append(v);
          }
        }
        g.addEventListener('mousemove', (e) => showTip(e, node.tip));
        g.addEventListener('mouseleave', hideTip);
        if (node.sessionId) {
          const pick = () => ctx.select(node.turnId ? { sessionId: node.sessionId, turnId: node.turnId } : { sessionId: node.sessionId });
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
        }
        root.append(g);
      }

      /** Draws one level: frames with a label for groups, blocks for leaves; selected frames are outlined last. */
      function drawLevel(root, nodes, box, outlines) {
        for (const r of squarify(nodes, box)) {
          const node = r.item;
          if (!node.children) {
            drawLeaf(root, node, r);
            // By tool category, a turn has no frame of its own, so its leaf takes the outline.
            if (mode === 'category' && isSelected(node)) outlines.push(r);
            continue;
          }
          const roomy = r.h > HEADER + 14 && r.w > 34;
          const inner = roomy ? { x: r.x + GAP, y: r.y + HEADER, w: r.w - GAP * 2, h: r.h - HEADER - GAP } : { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
          root.append(svg('rect', { class: 'treemap-frame', x: r.x + 0.5, y: r.y + 0.5, width: Math.max(0, r.w - 1), height: Math.max(0, r.h - 1) }));
          if (roomy) {
            const t = svg('text', { class: 'treemap-group', x: r.x + 4, y: r.y + 13 });
            const value = ` ${compact(Math.round(node.value))}`;
            t.textContent = fit(`${node.label}${value}`, r.w);
            root.append(t);
          }
          drawLevel(root, node.children, inner, outlines);
          if (isSelected(node)) outlines.push(r);
        }
      }

      function draw() {
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const nodes = hierarchy();
        if (!nodes.length || nodes.every((n) => n.value <= 0)) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const root = svg('svg', { class: 'viz-chart treemap-chart', viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img', 'aria-label': `Treemap of tokens ${mode === 'turn' ? 'by turn' : 'by tool category'}, ${views.length} session${views.length === 1 ? '' : 's'}` });
        const outlines = [];
        drawLevel(root, nodes, { x: 0, y: 0, w: width, h: HEIGHT }, outlines);
        for (const r of outlines) root.append(svg('rect', { class: 'treemap-selected', x: r.x + 1, y: r.y + 1, width: Math.max(0, r.w - 2), height: Math.max(0, r.h - 2) }));
        chartHost.replaceChildren(root);

        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        const labels = views[0].categoryGroups;
        legend.replaceChildren(...labels.map((label, i) => key(`cat-${i + 1}`, label)), key('cat-0', OTHER));
        note.textContent = '≈ Area is tokens. A turn’s tokens are split across the tool categories it used in proportion to how many calls each made, so the category sizes are approximate. Click a block to select its turn.';
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
