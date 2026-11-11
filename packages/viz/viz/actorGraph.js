// Actor graph: who worked with whom across the loaded sessions, in fixed
// columns read left to right (you, agents, subagents, then models and tool
// categories), so the layout stays put between draws. Edges are typed and not
// interchangeable: message (you to an agent), delegation (an agent to a
// subagent, inferred from events carrying an agentId, so dashed), model call,
// and tool call. See docs/design/visualization-explorer.md for the contract.
// A project-level visualizer: draws every session it's given, one session
// without complaint. With a turn selected, the actors and edges active in it
// stand out; clicking an actor announces the first turn it appears in. Sees
// only its host and ctx: no VS Code.
(function () {
  const MAX_SUBAGENTS = 12; // nodes in the column, the "+N subagents" fold included
  const KIND_LABEL = { you: 'You', agent: 'Agent', subagent: 'Subagent', model: 'Model', tool: 'Tool category' };
  const EDGE_LABEL = { message: 'Messages', delegation: 'Delegation (inferred)', model: 'Model calls', tool: 'Tool calls' };

  /** A node's outline, centered on 0,0: its shape names its kind, so color isn't the only cue. */
  function shapePath(kind, r) {
    if (kind === 'you') return `M${-r},0 a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 z`;
    if (kind === 'agent') return `M${-r},${-r} h${2 * r} v${2 * r} h${-2 * r} z`;
    if (kind === 'subagent') return `M0,${-r} L${r},0 L0,${r} L${-r},0 z`;
    if (kind === 'model') {
      const h = r * 0.87;
      return `M${-r},0 L${-r / 2},${-h} L${r / 2},${-h} L${r},0 L${r / 2},${h} L${-r / 2},${h} z`;
    }
    return `M${-r * 0.8},${-r} L${r},0 L${-r * 0.8},${r} z`; // tool: a triangle pointing right
  }

  window.snagboatViz.register({
    id: 'actor-graph',
    title: 'Actor graph',
    tags: { category: ['actor'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, short, ms, agentName, modelShort, showTip, hideTip } = ctx;
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small actor-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(chartHost, legend, note);
      let views = [];
      let selection = null;
      let draws = 0;

      const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;
      const turnKey = (sessionId, turnId) => `${sessionId}\n${turnId}`;

      function update(sessions, sel) {
        views = sessions;
        selection = sel || null;
        draw();
      }

      /** Nodes and edges over every session, before subagents are folded. */
      function buildGraph() {
        const nodes = new Map();
        const edges = new Map();
        const node = (id, kind, label, extra) => {
          let n = nodes.get(id);
          if (!n) {
            n = { id, kind, label, tokens: 0, prompts: 0, calls: 0, tools: 0, failed: 0, turns: new Set(), sessions: new Set(), first: null, ...extra };
            nodes.set(id, n);
          }
          return n;
        };
        const edge = (from, to, type, extra) => {
          const key = `${type}|${from}|${to}`;
          let e = edges.get(key);
          if (!e) {
            e = { key, from, to, type, count: 0, tokens: 0, turns: new Set(), ...extra };
            edges.set(key, e);
          }
          return e;
        };
        // Records that an actor or edge took part in a turn; a node also keeps its earliest turn, for the click.
        const touch = (item, sessionId, turnId, ts) => {
          if (!turnId) return;
          item.turns.add(turnKey(sessionId, turnId));
          if (item.kind && (!item.first || ms(ts) < ms(item.first.ts))) item.first = { sessionId, turnId, ts };
        };

        for (const v of views) {
          const sessionId = v.summary.sessionId;
          const known = new Set(v.prompts.map((p) => p.turnId));
          const agentId = `agent:${v.summary.agent}`;
          const you = node('you', 'you', 'You');
          const agent = node(agentId, 'agent', agentName(v.summary.agent));
          agent.sessions.add(sessionId);
          you.sessions.add(sessionId);
          for (const p of v.prompts) {
            you.prompts += 1;
            agent.prompts += 1;
            touch(you, sessionId, p.turnId, p.ts);
            touch(agent, sessionId, p.turnId, p.ts);
            const e = edge('you', agentId, 'message');
            e.count += 1;
            touch(e, sessionId, p.turnId, p.ts);
          }
          // A turn id with no prompt in this session can't be selected anywhere: it stays out of the turn sets.
          const linked = (t) => (t && known.has(t) ? t : undefined);
          const actorFor = (subId) => {
            if (!subId) return agent;
            const id = `subagent:${sessionId}/${subId}`;
            const sub = node(id, 'subagent', `subagent ${subId.replace(/^agent-/, '').slice(0, 7)}`, { parent: agentId, sessionLabel: v.summary.name ? clip(v.summary.name, 60) : short(sessionId) });
            sub.sessions.add(sessionId);
            return sub;
          };
          const delegate = (sub, turnId, ts) => {
            if (sub.kind !== 'subagent') return;
            const e = edge(sub.parent, sub.id, 'delegation', { seen: new Set() });
            const key = turnId || '';
            if (!e.seen.has(key)) {
              e.seen.add(key);
              e.count += 1; // the turns this subagent worked in
            }
            touch(e, sessionId, turnId, ts);
            const parent = nodes.get(sub.parent);
            touch(parent, sessionId, turnId, ts);
          };
          for (const c of v.calls) {
            const turnId = linked(c.turnId);
            const actor = actorFor(c.agentId);
            const tokens = callTokens(c);
            actor.calls += 1;
            actor.tokens += tokens;
            touch(actor, sessionId, turnId, c.ts);
            delegate(actor, turnId, c.ts);
            const modelNode = node(`model:${c.model || ''}`, 'model', c.model ? modelShort(c.model) : 'unknown model');
            modelNode.calls += 1;
            modelNode.tokens += tokens;
            modelNode.sessions.add(sessionId);
            touch(modelNode, sessionId, turnId, c.ts);
            const e = edge(actor.id, modelNode.id, 'model');
            e.count += 1;
            e.tokens += tokens;
            touch(e, sessionId, turnId, c.ts);
            const parentEdge = c.agentId ? edges.get(`delegation|${actor.parent}|${actor.id}`) : null;
            if (parentEdge) parentEdge.tokens += tokens; // the work the delegation led to
          }
          for (const t of v.tools) {
            const turnId = linked(t.turnId);
            const actor = actorFor(t.agentId);
            actor.tools += 1;
            touch(actor, sessionId, turnId, t.ts);
            delegate(actor, turnId, t.ts);
            const toolNode = node(`tool:${t.category}`, 'tool', t.category, { colorGroup: t.colorGroup, names: new Map() });
            toolNode.tools += 1;
            if (t.status === 'failure') toolNode.failed += 1;
            if (t.name) toolNode.names.set(t.name, (toolNode.names.get(t.name) || 0) + 1);
            toolNode.sessions.add(sessionId);
            touch(toolNode, sessionId, turnId, t.ts);
            const e = edge(actor.id, toolNode.id, 'tool', { colorGroup: t.colorGroup, failed: 0 });
            e.count += 1;
            if (t.status === 'failure') e.failed += 1;
            touch(e, sessionId, turnId, t.ts);
          }
        }
        return foldSubagents(nodes, edges);
      }

      /** Past the column's limit, the smallest subagents become one node with their edges merged. */
      function foldSubagents(nodes, edges) {
        const subs = [...nodes.values()].filter((n) => n.kind === 'subagent').sort((a, b) => b.tokens - a.tokens || b.calls + b.tools - (a.calls + a.tools) || a.id.localeCompare(b.id));
        if (subs.length <= MAX_SUBAGENTS) return { nodes, edges };
        const folded = subs.slice(MAX_SUBAGENTS - 1);
        const ids = new Set(folded.map((n) => n.id));
        const foldId = 'subagent:+';
        const fold = { id: foldId, kind: 'subagent', label: `+${folded.length} subagents`, folded: folded.length, tokens: 0, prompts: 0, calls: 0, tools: 0, failed: 0, turns: new Set(), sessions: new Set(), first: null, parent: null };
        for (const n of folded) {
          fold.tokens += n.tokens;
          fold.calls += n.calls;
          fold.tools += n.tools;
          for (const t of n.turns) fold.turns.add(t);
          for (const s of n.sessions) fold.sessions.add(s);
          if (n.first && (!fold.first || ms(n.first.ts) < ms(fold.first.ts))) fold.first = n.first;
          nodes.delete(n.id);
        }
        const merged = new Map();
        for (const e of edges.values()) {
          const from = ids.has(e.from) ? foldId : e.from;
          const to = ids.has(e.to) ? foldId : e.to;
          const key = `${e.type}|${from}|${to}`;
          const m = merged.get(key);
          if (!m) {
            merged.set(key, { ...e, key, from, to, turns: new Set(e.turns) });
          } else {
            m.count += e.count;
            m.tokens += e.tokens;
            if (e.failed) m.failed = (m.failed || 0) + e.failed;
            for (const t of e.turns) m.turns.add(t);
          }
        }
        nodes.set(foldId, fold);
        return { nodes, edges: merged };
      }

      function nodeTip(n) {
        const rows = [`${KIND_LABEL[n.kind]}: ${n.label}`];
        if (n.prompts) rows.push(['Prompts', fmt(n.prompts)]);
        if (n.calls) rows.push(['Model calls', fmt(n.calls)]);
        if (n.tools) rows.push(['Tool calls', fmt(n.tools)]);
        if (n.failed) rows.push(['Failed', fmt(n.failed)]);
        if (n.tokens) rows.push(['Tokens', fmt(n.tokens)]);
        if (n.sessionLabel) rows.push(['Session', n.sessionLabel]);
        else if (n.sessions.size > 1) rows.push(['Sessions', fmt(n.sessions.size)]);
        if (n.names && n.names.size) {
          const top = [...n.names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4);
          rows.push(clip(top.map(([name, count]) => `${name} ${fmt(count)}`).join(', '), 120));
        }
        return rows;
      }
      function edgeTip(e, nodes) {
        const rows = [`${nodes.get(e.from).label} → ${nodes.get(e.to).label}`];
        rows.push([EDGE_LABEL[e.type], e.type === 'delegation' ? `${fmt(e.count)} turn${e.count === 1 ? '' : 's'}` : fmt(e.count)]);
        if (e.failed) rows.push(['Failed', fmt(e.failed)]);
        if (e.tokens) rows.push(['Tokens', fmt(e.tokens)]);
        if (e.type === 'delegation') rows.push('Inferred from events that carry the subagent’s id.');
        return rows;
      }

      /** The selected turn as keys into the turn sets; several when the selection names no session. */
      function selectedKeys() {
        if (!selection || !selection.turnId) return [];
        return views
          .filter((v) => (!selection.sessionId || selection.sessionId === v.summary.sessionId) && v.prompts.some((p) => p.turnId === selection.turnId))
          .map((v) => turnKey(v.summary.sessionId, selection.turnId));
      }
      function selectedPrompt() {
        if (!selection || !selection.turnId) return null;
        for (const v of views) {
          if (selection.sessionId && selection.sessionId !== v.summary.sessionId) continue;
          const p = v.prompts.find((x) => x.turnId === selection.turnId);
          if (p) return p;
        }
        return null;
      }

      function draw() {
        draws++;
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        if (views.every((v) => v.calls.length === 0 && v.tools.length === 0)) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: `No model calls or tool calls in ${views.length === 1 ? 'this session' : 'these sessions'}.` }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const { nodes, edges } = buildGraph();
        const all = [...nodes.values()];
        const byTokens = (a, b) => b.tokens - a.tokens || b.calls - a.calls || a.label.localeCompare(b.label);
        const agents = all.filter((n) => n.kind === 'agent').sort(byTokens);
        const agentRank = new Map(agents.map((a, i) => [a.id, i]));
        const parentRank = (n) => (agentRank.has(n.parent) ? agentRank.get(n.parent) : agents.length);
        const subagents = all.filter((n) => n.kind === 'subagent').sort((a, b) => parentRank(a) - parentRank(b) || byTokens(a, b));
        const models = all.filter((n) => n.kind === 'model').sort(byTokens);
        const groupRank = (n) => n.colorGroup || 6;
        const tools = all.filter((n) => n.kind === 'tool').sort((a, b) => groupRank(a) - groupRank(b) || b.tools - a.tools || a.label.localeCompare(b.label));

        // Layout: fixed columns; the left ones centered on the plot, the right one stacked under its two headings.
        const width = Math.max(320, host.clientWidth || 800);
        const labelRoom = Math.min(190, Math.max(104, width * 0.2));
        const m = { l: 40, r: labelRoom, t: 26, b: 14 };
        // Left-column rows hold a node with its label under it; agents' nodes are the largest.
        const agentRow = 60;
        const subagentRow = 46;
        const rightRow = 30;
        const groupHead = 22;
        const rightHeight = (models.length ? groupHead + models.length * rightRow : 0) + (tools.length ? groupHead + tools.length * rightRow : 0) + (models.length && tools.length ? 10 : 0);
        const plotH = Math.max(rightHeight, agents.length * agentRow, subagents.length * subagentRow, agentRow * 2);
        const height = m.t + plotH + m.b;
        const columns = subagents.length ? 4 : 3;
        const xRight = width - m.r;
        const colX = (i) => m.l + ((xRight - m.l) * i) / (columns - 1);
        const colGap = (xRight - m.l) / (columns - 1);

        const maxTokens = Math.max(1, ...all.map((n) => n.tokens));
        const maxTools = Math.max(1, ...tools.map((n) => n.tools));
        const scale = (v, max) => 7 + 11 * Math.sqrt(v / max);
        const radius = (n) => (n.kind === 'you' ? 13 : n.kind === 'tool' ? scale(n.tools, maxTools) : scale(n.tokens, maxTokens));

        const place = (list, x, row) => {
          const top = m.t + (plotH - list.length * row) / 2;
          list.forEach((n, i) => {
            n.x = x;
            n.y = top + i * row + (row - 16) / 2;
            n.r = radius(n);
          });
        };
        place(all.filter((n) => n.kind === 'you'), colX(0), agentRow);
        place(agents, colX(1), agentRow);
        place(subagents, colX(2), subagentRow);
        let ry = m.t;
        const heads = [];
        const stackRight = (list, title) => {
          if (!list.length) return;
          heads.push({ title, y: ry + 14 });
          ry += groupHead;
          for (const n of list) {
            n.x = xRight;
            n.y = ry + rightRow / 2;
            n.r = Math.min(radius(n), rightRow / 2 - 1);
            ry += rightRow;
          }
          ry += 10;
        };
        stackRight(models, 'Models');
        stackRight(tools, 'Tool categories');

        const root = svg('svg', { class: 'viz-chart actor-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Actor graph: ${agents.length} agent${agents.length === 1 ? '' : 's'}, ${subagents.length} subagent${subagents.length === 1 ? '' : 's'}, ${models.length} model${models.length === 1 ? '' : 's'}, ${tools.length} tool categor${tools.length === 1 ? 'y' : 'ies'}` });
        const heading = (text, x, y, anchor) => {
          const t = svg('text', { class: 'axis-label', x, y, 'text-anchor': anchor });
          t.textContent = text;
          root.append(t);
        };
        heading('You', colX(0), 14, 'middle');
        heading('Agents', colX(1), 14, 'middle');
        if (subagents.length) heading('Subagents', colX(2), 14, 'middle');
        for (const h of heads) heading(h.title, xRight - 10, h.y, 'start');

        // Edges first, so nodes sit on top. One thickness scale across the types: it's a count of events.
        const edgeList = [...edges.values()];
        const maxCount = Math.max(1, ...edgeList.map((e) => e.count));
        const thickness = (count) => 1.25 + 6.75 * Math.sqrt(count / maxCount);
        const edgeEls = new Map(); // key -> { edge, g }
        const nodeEls = new Map(); // id -> { node, g }
        // Tool calls last, so their colors stay readable over the neutral model calls.
        const order = { message: 0, delegation: 1, model: 2, tool: 3 };
        edgeList.sort((a, b) => order[a.type] - order[b.type] || b.count - a.count || a.key.localeCompare(b.key));
        for (const e of edgeList) {
          const a = nodes.get(e.from);
          const b = nodes.get(e.to);
          const midX = (a.x + b.x) / 2;
          const d = `M${a.x},${a.y} C${midX},${a.y} ${midX},${b.y} ${b.x},${b.y}`;
          const w = thickness(e.count);
          const g = svg('g', { class: 'actor-edge-group' });
          const line = svg('path', { class: `actor-edge edge-${e.type}${e.type === 'tool' ? ` cat-${e.colorGroup || 0}` : ''}`, d, 'stroke-width': w });
          g.append(line);
          g.append(svg('path', { class: 'actor-edge-hit', d, 'stroke-width': Math.max(w, 10) }));
          g.addEventListener('mousemove', (evt) => showTip(evt, edgeTip(e, nodes)));
          g.addEventListener('mouseenter', () => hover(new Set([e.from, e.to]), new Set([e.key])));
          g.addEventListener('mouseleave', () => {
            hideTip();
            rest();
          });
          root.append(g);
          edgeEls.set(e.key, { edge: e, g });
        }

        const neighbors = (n) => {
          const ids = new Set([n.id]);
          const keys = new Set();
          for (const e of edgeList) {
            if (e.from === n.id || e.to === n.id) {
              keys.add(e.key);
              ids.add(e.from);
              ids.add(e.to);
            }
          }
          return { ids, keys };
        };

        for (const n of all) {
          const clickable = !!n.first;
          const g = svg('g', { class: `actor-node kind-${n.kind}${clickable ? ' clickable' : ''}`, transform: `translate(${n.x},${n.y})` });
          if (clickable) {
            g.setAttribute('tabindex', '0');
            g.setAttribute('role', 'button');
            g.setAttribute('aria-label', `${KIND_LABEL[n.kind]} ${n.label}: select the first turn it appears in`);
          }
          g.append(svg('path', { class: `actor-shape${n.kind === 'tool' ? ` cat-${n.colorGroup || 0}` : ''}`, d: shapePath(n.kind, n.r) }));
          g.append(svg('circle', { class: 'hit', r: Math.max(n.r, 12) }));
          const label = n.x === xRight
            ? svg('text', { class: 'node-label actor-label', x: n.r + 6, y: 4, 'text-anchor': 'start' })
            : svg('text', { class: 'node-label actor-label', x: 0, y: n.r + 13, 'text-anchor': 'middle' });
          label.textContent = n.x === xRight ? fit(n.label, labelRoom - n.r - 6) : fit(n.label, colGap - 4);
          g.append(label);
          const pick = () => {
            const before = draws;
            const next = { sessionId: n.first.sessionId, turnId: n.first.turnId };
            ctx.select(next);
            if (draws === before) {
              selection = next;
              draw();
            }
          };
          if (clickable) {
            g.addEventListener('click', pick);
            g.addEventListener('keydown', (evt) => evt.key === 'Enter' && pick());
          }
          const light = () => {
            const { ids, keys } = neighbors(n);
            hover(ids, keys);
          };
          g.addEventListener('mousemove', (evt) => showTip(evt, nodeTip(n)));
          g.addEventListener('mouseenter', light);
          g.addEventListener('mouseleave', () => {
            hideTip();
            rest();
          });
          g.addEventListener('focus', light);
          g.addEventListener('blur', rest);
          root.append(g);
          nodeEls.set(n.id, { node: n, g });
        }

        // Emphasis: a hover wins over the selected turn; with neither, everything is plain.
        const keysOfTurn = selectedKeys();
        const activeIn = (item) => keysOfTurn.some((k) => item.turns.has(k));
        function paint(isNodeOn, isEdgeOn, markActive) {
          for (const { node, g } of nodeEls.values()) {
            g.classList.toggle('dim', !isNodeOn(node));
            g.classList.toggle('active', markActive && isNodeOn(node));
          }
          for (const { edge, g } of edgeEls.values()) g.classList.toggle('dim', !isEdgeOn(edge));
        }
        function hover(ids, keys) {
          paint((n) => ids.has(n.id), (e) => keys.has(e.key), false);
        }
        function rest() {
          if (keysOfTurn.length) paint(activeIn, activeIn, true);
          else paint(() => true, () => true, false);
        }
        rest();

        chartHost.replaceChildren(root);

        const lineKey = (cls, text) => {
          const s = svg('svg', { class: 'actor-key', width: 26, height: 12, viewBox: '0 0 26 12', 'aria-hidden': 'true' });
          s.append(svg('line', { class: `actor-edge ${cls}`, x1: 1, x2: 25, y1: 6, y2: 6, 'stroke-width': 2.5 }));
          return el('span', { class: 'key' }, [s, text]);
        };
        const shapeKey = (kind, text) => {
          const s = svg('svg', { class: 'actor-key', width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true' });
          s.append(svg('path', { class: `actor-shape actor-key-shape kind-${kind}`, d: shapePath(kind, 6) }));
          return el('span', { class: 'key' }, [s, text]);
        };
        legend.replaceChildren(
          ...[
            lineKey('edge-message', 'message'),
            subagents.length && lineKey('edge-delegation', 'delegation (inferred)'),
            lineKey('edge-model', 'model call'),
            lineKey('edge-tool cat-1', 'tool call, in its category’s color'),
            shapeKey('you', 'you'),
            shapeKey('agent', 'agent'),
            subagents.length && shapeKey('subagent', 'subagent'),
            shapeKey('model', 'model'),
            shapeKey('tool', 'tool category'),
          ].filter(Boolean)
        );
        const prompt = keysOfTurn.length ? selectedPrompt() : null;
        const showing = prompt ? `Highlighting the actors in P${prompt.index}. ` : '';
        note.textContent = `${showing}Agents, subagents, and models are sized by tokens, tool categories by calls; edge thickness is the count of events. Hover for exact counts; click an actor to select the first turn it appears in.`;
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
