// Prompt terms: the words in your prompts as a co-occurrence graph, the
// proposal's word and phrase graph. Computed here from prompts[].text at draw
// time, by counting: no model, no embeddings, nothing stored or sent. A term
// counts once per prompt; a node's size is how many prompts use it, a line
// joins two terms that share prompts, thicker when they share more. See
// docs/design/visualization-explorer.md for the contract. A project-level
// visualizer: every session it's given goes into one graph, one session makes
// one graph. Clicking a term lists its prompts, and clicking one of those
// announces { sessionId, turnId }. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_TERMS = 30;
  const MAX_EDGES = 60;
  const LABEL_CHARS = 24;
  const ITERATIONS = 240;
  // Words are counted the same way Conversation Landscape counts them (vizkit.js).
  const { termsOf: tokenize, foldPlural: singular } = window.snagboatVizKit;

  /** The graph for these sessions: prompts with their terms, the top terms with counts, the strongest edges. */
  function analyze(views) {
    const prompts = [];
    let withoutText = 0;
    for (const v of views) {
      for (const p of v.prompts) {
        if (p.text) prompts.push({ sessionId: v.summary.sessionId, summary: v.summary, turnId: p.turnId, index: p.index, text: p.text, terms: tokenize(p.text) });
        else withoutText++;
      }
    }
    const all = new Set(prompts.flatMap((p) => [...p.terms]));
    const counts = new Map();
    for (const p of prompts) {
      p.terms = new Set([...p.terms].map((t) => singular(t, all)));
      for (const t of p.terms) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const repeated = ranked.filter(([, n]) => n >= 2);
    // Terms in two or more prompts, unless a small session has too few of those to draw.
    const chosen = (repeated.length >= 8 ? repeated : ranked).slice(0, MAX_TERMS);
    const terms = chosen.map(([term, count], i) => ({ term, count, i }));
    const byTerm = new Map(terms.map((t) => [t.term, t]));

    const pairs = new Map();
    for (const p of prompts) {
      const here = [...p.terms].filter((t) => byTerm.has(t)).map((t) => byTerm.get(t).i).sort((a, b) => a - b);
      for (let i = 0; i < here.length; i++) {
        for (let j = i + 1; j < here.length; j++) {
          const key = `${here[i]},${here[j]}`;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
    }
    const allEdges = [...pairs].map(([key, shared]) => {
      const [a, b] = key.split(',').map(Number);
      return { a, b, shared };
    });
    // Pairs sharing two or more prompts, when there are enough of them to give the graph a shape.
    const strong = allEdges.filter((e) => e.shared >= 2);
    const edges = (strong.length >= terms.length / 2 ? strong : allEdges).sort((x, y) => y.shared - x.shared || x.a - y.a || x.b - y.b).slice(0, MAX_EDGES);
    return { prompts, withoutText, terms, byTerm, edges, termTotal: counts.size };
  }

  /**
   * Node centers for a graph in a box. Force-directed from a fixed spiral start
   * (common terms in the middle), with no randomness, so a redraw lands in the
   * same place; then a pass pushes apart any labels that still overlap.
   */
  function layout(model, width, height, radius, labelWidth) {
    const n = model.terms.length;
    const cx = width / 2;
    const cy = height / 2;
    const nodes = model.terms.map((t, i) => {
      const r = Math.sqrt((i + 0.5) / n);
      const theta = i * 2.39996;
      return { x: cx + r * width * 0.42 * Math.cos(theta), y: cy + r * height * 0.42 * Math.sin(theta), dx: 0, dy: 0, r: radius(t), w: labelWidth(t) };
    });
    const halfW = (node) => Math.max(node.r, node.w / 2) + 3;
    const clamp = (node) => {
      node.x = Math.min(width - halfW(node), Math.max(halfW(node), node.x));
      node.y = Math.min(height - node.r - 16, Math.max(node.r + 3, node.y));
    };
    const k = Math.sqrt((width * height) / Math.max(1, n)) * 0.72;
    const gravityX = (n * k * k) / Math.pow(0.4 * width, 2);
    const gravityY = (n * k * k) / Math.pow(0.4 * height, 2);
    for (let it = 0; it < ITERATIONS; it++) {
      const temperature = (Math.min(width, height) / 8) * (1 - it / ITERATIONS) + 0.5;
      for (const node of nodes) node.dx = node.dy = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x || 0.01;
          const dy = a.y - b.y || 0.01;
          const d = Math.max(1, Math.hypot(dx, dy));
          const f = (k * k) / d / d;
          a.dx += dx * f;
          a.dy += dy * f;
          b.dx -= dx * f;
          b.dy -= dy * f;
        }
      }
      for (const e of model.edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d / k) * (1 + Math.log(e.shared));
        a.dx -= dx * f * 0.5;
        a.dy -= dy * f * 0.5;
        b.dx += dx * f * 0.5;
        b.dy += dy * f * 0.5;
      }
      for (const node of nodes) {
        // Gravity toward the middle, set per axis to balance the repulsion about
        // 40% of the way out, so unconnected groups fill the box instead of pressing on its edges.
        node.dx += (cx - node.x) * gravityX;
        node.dy += (cy - node.y) * gravityY;
        const d = Math.max(1, Math.hypot(node.dx, node.dy));
        const step = Math.min(d, temperature);
        node.x += (node.dx / d) * step;
        node.y += (node.dy / d) * step;
        clamp(node);
      }
    }
    // Each node's box holds its circle and the label below it.
    for (let pass = 0; pass < 120; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const overlapX = halfW(a) + halfW(b) - Math.abs(a.x - b.x);
          const aTop = a.y - a.r - 2;
          const aBottom = a.y + a.r + 15;
          const bTop = b.y - b.r - 2;
          const bBottom = b.y + b.r + 15;
          const overlapY = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          if (overlapY < overlapX) {
            const push = (overlapY / 2 + 0.5) * (aTop + aBottom <= bTop + bBottom ? -1 : 1);
            a.y += push;
            b.y -= push;
          } else {
            const push = (overlapX / 2 + 0.5) * (a.x <= b.x ? -1 : 1);
            a.x += push;
            b.x -= push;
          }
          clamp(a);
          clamp(b);
        }
      }
      if (!moved) break;
    }
    return nodes;
  }

  window.snagboatViz.register({
    id: 'prompt-terms',
    title: 'Prompt terms',
    tags: { category: ['semantic'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['content'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, fmt, clip, short, showTip, hideTip } = ctx;
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small terms-legend' });
      const note = el('p', { class: 'muted small' });
      const listHost = el('div', { class: 'terms-list' });
      host.replaceChildren(chartHost, legend, note, listHost);
      let views = null;
      let model = null;
      let selection = null;
      let pinned = null; // the term whose prompts are listed
      let draws = 0;
      // What a focusable part stands for, so a redraw can put focus back on its replacement.
      let focusKeys = new WeakMap();

      const sessionLabel = (s) => (s.name ? clip(s.name, 40) : short(s.sessionId));
      const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

      function update(sessions, sel) {
        if (sessions !== views) {
          views = sessions;
          model = analyze(views);
          if (pinned && !model.byTerm.has(pinned)) pinned = null;
        }
        selection = sel || null;
        draw();
      }

      const clear = () => {
        chartHost.replaceChildren();
        legend.replaceChildren();
        note.textContent = '';
        listHost.replaceChildren();
      };

      function inSelection(p) {
        return !!selection && !!selection.turnId && p.turnId === selection.turnId && (!selection.sessionId || selection.sessionId === p.sessionId);
      }

      function draw() {
        draws++;
        const focused = focusKeys.get(document.activeElement);
        if (!views || !views.length) {
          clear();
          return;
        }
        if (!model.prompts.length) {
          clear();
          chartHost.replaceChildren(el('p', { class: 'muted', text: `No prompt text in ${views.length === 1 ? 'this session' : 'these sessions'}: text capture (snagboat.captureContent) was off when ${views.length === 1 ? 'it' : 'they'} ran, or the text has aged out.` }));
          return;
        }
        if (!model.terms.length) {
          clear();
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'No terms to draw: the prompts use only common words.' }));
          return;
        }

        const width = Math.max(320, host.clientWidth || 800);
        const height = Math.round(Math.min(560, Math.max(340, width * 0.5)));
        const maxCount = Math.max(...model.terms.map((t) => t.count));
        const maxShared = Math.max(1, ...model.edges.map((e) => e.shared));
        const radius = (t) => 4 + 11 * Math.sqrt(t.count / maxCount);
        const labelOf = (t) => clip(t.term, LABEL_CHARS);
        const labelWidth = (t) => labelOf(t).length * 6.8;
        const nodes = layout(model, width, height, radius, labelWidth);

        const turnTerms = new Set(model.prompts.filter(inSelection).flatMap((p) => [...p.terms]));
        const related = new Set(pinned ? [model.byTerm.get(pinned).i] : []);
        if (pinned) {
          const at = model.byTerm.get(pinned).i;
          for (const e of model.edges) {
            if (e.a === at) related.add(e.b);
            if (e.b === at) related.add(e.a);
          }
        }
        const partners = (i) =>
          model.edges
            .filter((e) => e.a === i || e.b === i)
            .sort((x, y) => y.shared - x.shared)
            .slice(0, 4)
            .map((e) => model.terms[e.a === i ? e.b : e.a].term);

        const root = svg('svg', { class: 'viz-chart terms-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Prompt terms: ${plural(model.terms.length, 'term')} from ${plural(model.prompts.length, 'prompt')}, joined when they share a prompt` });

        for (const e of model.edges) {
          const a = nodes[e.a];
          const b = nodes[e.b];
          const touches = pinned && (model.terms[e.a].term === pinned || model.terms[e.b].term === pinned);
          const g = svg('g', { class: `term-edge${pinned && !touches ? ' dim' : ''}${touches ? ' on' : ''}` });
          g.append(svg('line', { class: 'term-line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': 1 + (3 * (e.shared - 1)) / Math.max(1, maxShared - 1) }));
          g.append(svg('line', { class: 'term-line-hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
          g.addEventListener('mousemove', (evt) => showTip(evt, [`${model.terms[e.a].term} + ${model.terms[e.b].term}`, ['Prompts together', fmt(e.shared)]]));
          g.addEventListener('mouseleave', hideTip);
          root.append(g);
        }

        const parts = new Map(); // focus key -> element
        model.terms.forEach((t, i) => {
          const node = nodes[i];
          const on = t.term === pinned;
          const g = svg('g', { class: `term-node${on ? ' pinned' : ''}${turnTerms.has(t.term) ? ' in-turn' : ''}${pinned && !related.has(i) ? ' dim' : ''}`, tabindex: 0, role: 'button', 'aria-pressed': String(on), 'aria-label': `${t.term}, in ${plural(t.count, 'prompt')}` });
          const halfW = Math.max(node.r, node.w / 2) + 2;
          g.append(svg('rect', { class: 'hit', x: node.x - halfW, y: node.y - node.r - 2, width: halfW * 2, height: node.r * 2 + 17 }));
          g.append(svg('circle', { class: 'term-dot', cx: node.x, cy: node.y, r: node.r }));
          const label = svg('text', { class: 'term-label', x: node.x, y: node.y + node.r + 12, 'text-anchor': 'middle' });
          label.textContent = labelOf(t);
          g.append(label);
          const pin = () => {
            hideTip();
            pinned = on ? null : t.term;
            draw();
          };
          g.addEventListener('click', pin);
          g.addEventListener('keydown', (evt) => {
            if (evt.key !== 'Enter') return;
            evt.preventDefault();
            pin();
          });
          g.addEventListener('mousemove', (evt) => {
            const with_ = partners(i);
            showTip(evt, [t.term, ['Prompts', fmt(t.count)], ...(with_.length ? [`Often with ${with_.join(', ')}`] : []), on ? 'Click to stop listing its prompts' : 'Click to list its prompts']);
          });
          g.addEventListener('mouseleave', hideTip);
          parts.set(`term:${t.term}`, g);
          root.append(g);
        });
        chartHost.replaceChildren(root);

        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        legend.replaceChildren(key('swatch-term', 'term'), key('swatch-term-turn', 'term in the selected turn'), key('swatch-term-pinned', 'term whose prompts are listed'));

        const shown = model.termTotal > model.terms.length ? `The ${fmt(model.terms.length)} most used of ${fmt(model.termTotal)} terms. ` : '';
        const missing = model.withoutText ? ` ${plural(model.withoutText, 'prompt')} without text ${model.withoutText === 1 ? 'is' : 'are'} left out.` : '';
        note.textContent = `Word counts, not a model’s reading: this says which words you used together, not what they meant. ${shown}A circle’s size is how many prompts use the word; a line joins words in the same prompt, thicker when they share more. Computed here; nothing is stored or sent.${missing} Click a term to list its prompts.`;

        drawList(parts);
        focusKeys = new WeakMap([...parts].map(([k, part]) => [part, k]));
        if (focused && parts.has(focused)) parts.get(focused).focus({ preventScroll: true });
      }

      function drawList(parts) {
        if (!pinned) {
          listHost.replaceChildren();
          return;
        }
        const having = model.prompts.filter((p) => p.terms.has(pinned));
        listHost.replaceChildren(
          el('p', { class: 'small terms-list-head' }, [el('strong', { text: pinned }), el('span', { class: 'muted', text: ` in ${plural(having.length, 'prompt')}` })]),
          el(
            'ul',
            { class: 'terms-prompts' },
            having.map((p, i) => {
              const pick = () => {
                const before = draws;
                ctx.select({ sessionId: p.sessionId, turnId: p.turnId });
                if (draws === before) {
                  selection = { sessionId: p.sessionId, turnId: p.turnId };
                  draw();
                }
              };
              const row = el('button', { class: 'terms-prompt', 'aria-current': String(inSelection(p)), title: p.text }, [
                el('strong', { text: `P${p.index}` }),
                el('span', { class: 'muted', text: ` ${sessionLabel(p.summary)} ` }),
                el('span', { text: clip(p.text, 200) }),
              ]);
              row.addEventListener('click', pick);
              parts.set(`prompt:${i}`, row);
              return el('li', {}, [row]);
            })
          )
        );
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
