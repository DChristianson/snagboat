// Tool-call ribbon: which tool category followed which within turns. Each
// agent's calls in a turn form one sequence, so a subagent's calls don't read
// as following the main agent's; sources stand on the left, what came next on
// the right, and a ribbon's width is how many times that step happened. Start
// and End mark the edges of a sequence. Order is observed, but one call
// following another doesn't show that it depended on it, and the note says so.
// See docs/design/visualization-explorer.md for the contract. Clicking a ribbon
// lists the turns it came from, each announcing { sessionId, turnId }; a
// selected turn narrows the ribbons to its own. The pinned ribbon lives in the
// instance. Sees only its host and ctx: no VS Code.
(function () {
  const START = '\u0000start';
  const END = '\u0000end';
  const NODE_W = 12;
  const NODE_GAP = 10;
  const LABEL = 150;
  const MIN_HEIGHT = 240;
  const PX_PER_STEP = 5;

  window.snagboatViz.register({
    id: 'tool-ribbon',
    title: 'Tool-call ribbon',
    tags: { category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'] },
    mount(host, ctx) {
      const { el, svg, fmt, clip, fit, ms, showTip, hideTip } = ctx;
      let view = null;
      let selection = null;
      let pinned = null; // a ribbon's key, from|to

      const chartHost = el('div');
      const legend = el('div', { class: 'legend small ribbon-legend' });
      const note = el('p', { class: 'muted small' });
      const turnsHost = el('div');
      host.replaceChildren(chartHost, legend, note, turnsHost);

      const nameOf = (key) => (key === START ? 'Start' : key === END ? 'End' : key);
      const selectedTurn = () => {
        const s = selection;
        if (!s || !s.turnId || (s.sessionId && s.sessionId !== view.summary.sessionId)) return null;
        return view.tools.some((x) => x.turnId === s.turnId) ? s.turnId : null;
      };

      /** Every step in the session: Map(from|to -> { from, to, count, failedFrom, turns: Map(turnId -> count) }). */
      function stepsOf(v) {
        const sequences = new Map();
        for (const x of v.tools) {
          if (!x.turnId) continue; // calls no turn claims have no sequence to belong to
          const key = `${x.turnId}|${x.agentId || ''}`;
          const list = sequences.get(key) || { turnId: x.turnId, calls: [] };
          list.calls.push(x);
          sequences.set(key, list);
        }
        const steps = new Map();
        const addStep = (from, to, turnId, failed) => {
          const key = `${from}|${to}`;
          const step = steps.get(key) || { key, from, to, count: 0, failedFrom: 0, turns: new Map() };
          step.count++;
          if (failed) step.failedFrom++;
          step.turns.set(turnId, (step.turns.get(turnId) || 0) + 1);
          steps.set(key, step);
        };
        for (const { turnId, calls } of sequences.values()) {
          calls.sort((a, b) => ms(a.ts) - ms(b.ts));
          addStep(START, calls[0].category, turnId, false);
          for (let i = 1; i < calls.length; i++) addStep(calls[i - 1].category, calls[i].category, turnId, calls[i - 1].status === 'failure');
          addStep(calls[calls.length - 1].category, END, turnId, calls[calls.length - 1].status === 'failure');
        }
        return [...steps.values()];
      }

      /** One column's nodes, in a fixed order so the same category keeps its place: { key, value, y, h }. */
      function layoutColumn(keys, valueOf, rank, top, pxPerStep) {
        const nodes = [...keys].sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b))).map((key) => ({ key, value: valueOf(key) }));
        let y = top;
        for (const n of nodes) {
          n.y = y;
          n.h = Math.max(3, n.value * pxPerStep);
          n.used = 0;
          y += n.h + NODE_GAP;
        }
        return nodes;
      }

      function drawTurns(steps) {
        const step = steps.find((s) => s.key === pinned);
        if (!step) {
          turnsHost.replaceChildren();
          return;
        }
        const promptOf = new Map();
        for (const p of view.prompts) if (!promptOf.has(p.turnId) || (!promptOf.get(p.turnId).text && p.text)) promptOf.set(p.turnId, p);
        const turns = [...step.turns].sort((a, b) => b[1] - a[1]);
        const current = selection && selection.turnId;
        turnsHost.replaceChildren(
          el('p', { class: 'small ribbon-turns-head', text: `${nameOf(step.from)} → ${nameOf(step.to)}: the ${turns.length === 1 ? 'turn' : `${fmt(turns.length)} turns`} it came from` }),
          el(
            'ul',
            { class: 'terms-prompts' },
            turns.map(([turnId, n]) => {
              const p = promptOf.get(turnId);
              const b = el('button', { class: 'terms-prompt', 'aria-current': String(turnId === current) }, [el('span', { class: 'muted', text: `${p ? `P${p.index}` : 'Turn'} ×${fmt(n)} ` }), p && p.text ? clip(p.text, 140) : '']);
              b.addEventListener('click', () => ctx.select({ sessionId: view.summary.sessionId, turnId }));
              return el('li', {}, [b]);
            })
          )
        );
      }

      function draw() {
        if (!view) {
          chartHost.replaceChildren();
          turnsHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const steps = stepsOf(view);
        if (!steps.length) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'No tool calls in a turn in this session.' }));
          turnsHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const groupOf = new Map();
        for (const x of view.tools) groupOf.set(x.category, x.colorGroup);
        const rank = (key) => (key === START ? -1 : key === END ? 1000 : groupOf.get(key) || 99);
        const sum = (list) => list.reduce((a, s) => a + s.count, 0);
        const lefts = new Set(steps.map((s) => s.from));
        const rights = new Set(steps.map((s) => s.to));
        const width = Math.max(420, host.clientWidth || 800);
        const leftX = Math.min(LABEL, width * 0.26);
        const rightX = width - leftX - NODE_W;
        const totalLeft = sum(steps);
        const roomy = Math.max(MIN_HEIGHT, Math.min(520, totalLeft * PX_PER_STEP));
        // One scale for both columns, so a step is as wide leaving as it is arriving.
        const gaps = Math.max(lefts.size, rights.size) * NODE_GAP;
        const scale = roomy / totalLeft;
        const left = layoutColumn(lefts, (k) => sum(steps.filter((s) => s.from === k)), rank, 2, scale);
        const right = layoutColumn(rights, (k) => sum(steps.filter((s) => s.to === k)), rank, 2, scale);
        const height = roomy + gaps + 6;
        const root = svg('svg', { class: 'viz-chart ribbon-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Tool-call ribbon: ${fmt(totalLeft)} steps between ${lefts.size} sources and ${rights.size} next steps` });

        const leftOf = new Map(left.map((n) => [n.key, n]));
        const rightOf = new Map(right.map((n) => [n.key, n]));
        const order = (nodes) => new Map(nodes.map((n, i) => [n.key, i]));
        const leftOrder = order(left);
        const rightOrder = order(right);
        const current = selectedTurn();
        // Ribbons stack within a node in the other column's order, which keeps crossings down.
        const ordered = [...steps].sort((a, b) => rightOrder.get(a.to) - rightOrder.get(b.to));
        const placed = new Map();
        for (const s of ordered) {
          const n = leftOf.get(s.from);
          const h = s.count * scale;
          placed.set(s.key, { y0: n.y + n.used, h });
          n.used += h;
        }
        for (const s of [...steps].sort((a, b) => leftOrder.get(a.from) - leftOrder.get(b.from))) {
          const n = rightOf.get(s.to);
          placed.get(s.key).y1 = n.y + n.used;
          n.used += s.count * scale;
        }
        const x0 = leftX + NODE_W;
        const x1 = rightX;
        const mid = (x0 + x1) / 2;
        for (const s of [...steps].sort((a, b) => b.count - a.count)) {
          const { y0, y1, h } = placed.get(s.key);
          const inTurn = !current || s.turns.has(current);
          const on = s.key === pinned;
          const g = svg('g', { class: `ribbon${inTurn ? '' : ' ribbon-dim'}${on ? ' ribbon-on' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${nameOf(s.from)} to ${nameOf(s.to)}: ${fmt(s.count)} times; list its turns` });
          const shape = `M${x0} ${y0} C${mid} ${y0} ${mid} ${y1} ${x1} ${y1} L${x1} ${y1 + h} C${mid} ${y1 + h} ${mid} ${y0 + h} ${x0} ${y0 + h} Z`;
          g.append(svg('path', { class: `ribbon-shape ribbon-cat-${s.from === START ? 'start' : groupOf.get(s.from) || 0}`, d: shape }));
          const inTurnCount = current ? s.turns.get(current) || 0 : 0;
          g.addEventListener('mousemove', (e) =>
            showTip(e, [`${nameOf(s.from)} → ${nameOf(s.to)}`, ['Times', fmt(s.count)], ['Turns', fmt(s.turns.size)], ...(current ? [['In the selected turn', fmt(inTurnCount)]] : []), ...(s.failedFrom ? [['After a failed call', fmt(s.failedFrom)]] : [])])
          );
          g.addEventListener('mouseleave', hideTip);
          const pin = () => {
            pinned = pinned === s.key ? null : s.key;
            draw();
          };
          g.addEventListener('click', pin);
          g.addEventListener('keydown', (e) => e.key === 'Enter' && pin());
          root.append(g);
        }

        const drawNode = (n, x, side) => {
          root.append(svg('rect', { class: `ribbon-node ribbon-cat-${n.key === START || n.key === END ? 'start' : groupOf.get(n.key) || 0}`, x, y: n.y, width: NODE_W, height: n.h, rx: 2 }));
          const name = svg('text', { class: 'row-label', x: side === 'left' ? x - 6 : x + NODE_W + 6, y: n.y + Math.max(n.h / 2, 5) + 4, 'text-anchor': side === 'left' ? 'end' : 'start' });
          const avail = side === 'left' ? leftX - 8 : width - x - NODE_W - 8;
          name.textContent = fit(`${nameOf(n.key)} ${fmt(n.value)}`, avail);
          const title = svg('title', {});
          title.textContent = `${nameOf(n.key)}: ${fmt(n.value)} ${side === 'left' ? 'steps from here' : 'steps to here'}`;
          name.append(title);
          root.append(name);
        };
        for (const n of left) drawNode(n, leftX, 'left');
        for (const n of right) drawNode(n, rightX, 'right');
        chartHost.replaceChildren(root);

        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        const groups = [...new Set(view.tools.map((x) => x.colorGroup))].sort((a, b) => (a || 99) - (b || 99));
        legend.replaceChildren(...groups.map((g) => key(`cat-${g}`, g ? view.categoryGroups[g - 1] : 'Other tools')), key('swatch-ribbon-start', 'start or end of a sequence'));
        note.textContent = `Each agent’s calls in a turn are one sequence, read left to right; width is how many times that step happened. The order is observed, but a call following another doesn’t show it depended on it. ${current ? 'Dimmed ribbons aren’t in the selected turn. ' : ''}Click a ribbon to list its turns.`;
        drawTurns(steps);
      }

      return {
        update(sessions, sel) {
          view = sessions[0] || null;
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
