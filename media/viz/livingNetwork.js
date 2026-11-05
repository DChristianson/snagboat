// Living Network (hero view, design language `cinematic`): a spatial map of
// you, the agent, its subagents, and the tool categories it used, lit only by
// the work moving through it. A dark field; nodes bloom when they act; prompts,
// delegations, and tool calls travel between them as comet-tailed particles
// during replay. See docs/design/visualization-explorer.md, "Living Network".
//
// Positions come from the shared force layout, weighted by how often two
// actors interacted, with you pinned at the left; the note says so. Playback
// comes from the shared replay clock, and the particles in flight are derived
// from the clock's position alone (every event within the last moment of
// playback), so pausing, scrubbing, and reduced motion need no state of their
// own. Delegation is inferred from events carrying an agentId, and SessionView
// records no parent for a subagent, so every subagent hangs off the main agent.
// A session-level visualizer: draws the first session it's given. Clicking an
// actor isolates its neighborhood and announces the first turn it worked in.
// Sees only its host and ctx: no VS Code.
(function () {
  const MAX_SUBAGENTS = 12; // subagent nodes, the "+N subagents" fold included
  const MAX_TOOLS = 10; // tool-category nodes, an "other tools" node included
  const MAX_PARTICLES = 48; // in flight at once
  const PER_EDGE = 3; // most particles on one link at once; the rest fold into the newest's size
  const FLIGHT_MS = 900; // playback time a particle takes to cross its link
  const BLOOM_MS = 1400; // playback time a node's bloom takes to fade
  const TAIL = 4; // dots in a particle's comet tail
  const HEAD = 28; // the letterbox bars
  const FOOT = 0; // the controls under the drawing are the bottom bar
  const KIND = { you: 'You', agent: 'Agent', subagent: 'Subagent', tool: 'Tool category' };
  let charts = 0; // gradient and filter ids must be unique across stacked charts

  /** A point at t (0..1) along the quadratic curve from a through control c to b. */
  function onCurve(a, c, b, t) {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  }

  window.snagboatViz.register({
    id: 'living-network',
    title: 'Living Network',
    tags: { category: ['actor', 'temporal'], purpose: ['expressive'], level: ['session'], dimension: ['actor', 'communication', 'time'], language: ['cinematic'] },
    mount(host, ctx) {
      const { el, svg, svgText, compact, fmt, clip, short, modelShort, agentName, formatTime, showTip, hideTip, forceLayout, drift, hashId, countUpTo } = ctx;
      const prefix = `ln${++charts}`;
      const frame = el('div', { class: 'hero-living' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let view = null;
      let selection = null;
      let graph = null; // { nodes, edges, events, byNode } for the current view
      let positions = null; // Map id -> {x, y}, kept across updates so the layout only nudges
      let scene = null; // the drawn parts the frame loop touches
      let isolated = null; // an actor id whose neighborhood stands out
      const shown = { message: true, delegation: true, tool: true }; // particle types on
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'the Living Network' });

      function update(sessions, sel) {
        const next = sessions[0] || null;
        const same = view && next && view.summary.sessionId === next.summary.sessionId;
        if (!same) {
          positions = null;
          isolated = null;
        }
        view = next;
        selection = sel || null;
        graph = view ? buildGraph(view) : null;
        clock.setSessions(view ? [view] : []);
        draw();
      }

      /** Actors, links, and each replayed event's part in the picture. */
      function buildGraph(v) {
        const nodes = new Map();
        const edges = new Map();
        const node = (id, kind, label, sub) => {
          let n = nodes.get(id);
          if (!n) {
            n = { id, kind, label, sub, events: 0, calls: 0, tools: 0, failed: 0, tokens: 0, prompts: 0, turns: new Set(), first: null, models: new Map() };
            nodes.set(id, n);
          }
          return n;
        };
        const edge = (from, to, type) => {
          const key = `${type}|${from}|${to}`;
          let e = edges.get(key);
          if (!e) {
            e = { key, from, to, type, count: 0, failed: 0, tokens: 0 };
            edges.set(key, e);
          }
          return e;
        };
        const ms = (ts) => Date.parse(ts);
        const known = new Set(v.prompts.map((p) => p.turnId));
        const touch = (n, turnId, ts) => {
          n.events += 1;
          if (turnId && known.has(turnId)) {
            n.turns.add(turnId);
            if (!n.first || ms(ts) < ms(n.first.ts)) n.first = { turnId, ts };
          }
        };

        // Which subagents and tool categories get their own node; the rest fold.
        const subWork = new Map();
        for (const c of v.calls) if (c.agentId) subWork.set(c.agentId, (subWork.get(c.agentId) || 0) + c.input + c.cacheRead + c.cacheCreation + c.output);
        for (const t of v.tools) if (t.agentId && !subWork.has(t.agentId)) subWork.set(t.agentId, 0);
        const subsRanked = [...subWork.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
        const subKeep = new Set(subsRanked.length > MAX_SUBAGENTS ? subsRanked.slice(0, MAX_SUBAGENTS - 1) : subsRanked);
        const subFolded = subsRanked.length - subKeep.size;
        const toolCount = new Map();
        for (const t of v.tools) toolCount.set(t.category, (toolCount.get(t.category) || 0) + 1);
        const toolsRanked = [...toolCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
        const toolKeep = new Set(toolsRanked.length > MAX_TOOLS ? toolsRanked.slice(0, MAX_TOOLS - 1) : toolsRanked);
        const toolFolded = toolsRanked.length - toolKeep.size;

        const you = node('you', 'you', 'You', 'operator');
        const main = node('agent', 'agent', agentName(v.summary.agent), 'main agent');
        const subId = (agentId) => (subKeep.has(agentId) ? `sub:${agentId}` : 'sub:+');
        const actorOf = (agentId) => {
          if (!agentId) return main;
          const id = subId(agentId);
          return node(id, 'subagent', id === 'sub:+' ? `+${subFolded} subagents` : `Sub ${agentId.replace(/^agent-/, '').slice(0, 6)}`, 'delegated (inferred)');
        };
        const toolOf = (category) => (toolKeep.has(category) ? node(`tool:${category}`, 'tool', category, 'tool category') : node('tool:+', 'tool', `${toolFolded} other categories`, 'tool categories'));

        // The replayed events, each with the node it lights and the particle it sends.
        const events = ctx.replayEvents([v]);
        const delegated = new Set(); // agentId|turnId already shown as a delegation
        const parts = events.map((ev) => {
          const it = ev.item;
          if (ev.kind === 'prompt') {
            you.prompts += 1;
            touch(you, it.turnId, it.ts);
            touch(main, it.turnId, it.ts);
            const e = edge('you', 'agent', 'message');
            e.count += 1;
            return { t: ev.t, nodes: ['you', 'agent'], edge: e.key, type: 'message', forward: true };
          }
          if (ev.kind === 'compaction') {
            touch(main, undefined, it.ts);
            return { t: ev.t, nodes: ['agent'], compaction: true };
          }
          if (ev.kind === 'call') {
            const actor = actorOf(it.agentId);
            const tokens = it.input + it.cacheRead + it.cacheCreation + it.output;
            actor.calls += 1;
            actor.tokens += tokens;
            if (it.model) actor.models.set(modelShort(it.model), (actor.models.get(modelShort(it.model)) || 0) + 1);
            touch(actor, it.turnId, it.ts);
            if (actor.kind === 'subagent') {
              const e = edge('agent', actor.id, 'delegation');
              e.tokens += tokens;
              const key = `${it.agentId}|${it.turnId || ''}`;
              if (!delegated.has(key)) {
                delegated.add(key);
                e.count += 1;
                touch(main, it.turnId, it.ts);
                return { t: ev.t, nodes: ['agent', actor.id], edge: e.key, type: 'delegation', forward: true };
              }
            }
            return { t: ev.t, nodes: [actor.id] };
          }
          // A tool call: the actor sends it, the tool lights; a failure flares.
          const actor = actorOf(it.agentId);
          const tool = toolOf(it.category);
          actor.tools += 1;
          tool.tools += 1;
          touch(actor, it.turnId, it.ts);
          touch(tool, it.turnId, it.ts);
          if (it.name) tool.models.set(it.name, (tool.models.get(it.name) || 0) + 1);
          const e = edge(actor.id, tool.id, 'tool');
          e.count += 1;
          if (it.status === 'failure') {
            e.failed += 1;
            tool.failed += 1;
          }
          return { t: ev.t, nodes: [actor.id, tool.id], edge: e.key, type: 'tool', forward: true, failure: it.status === 'failure' };
        });
        // Each node's event times, for its bloom.
        const byNode = new Map();
        for (const p of parts) for (const id of p.nodes) (byNode.get(id) || byNode.set(id, []).get(id)).push({ t: p.t });
        return { nodes, edges, events: parts, byNode };
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!view || !graph) {
          frame.replaceChildren(el('p', { class: 'muted', text: 'No session.' }));
          note.textContent = '';
          scene = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const height = Math.round(Math.min(620, Math.max(320, width * 0.5)));
        const fieldH = height - HEAD - FOOT;
        const nodes = [...graph.nodes.values()];
        const edges = [...graph.edges.values()];
        const maxEvents = Math.max(1, ...nodes.map((n) => n.events));
        const radius = (n) => (n.kind === 'you' ? 9 : n.kind === 'agent' ? 12 : 5 + 5 * Math.sqrt(n.events / maxEvents));
        for (const n of nodes) n.r = radius(n);

        // Interaction weights: how often two actors exchanged anything, on a square-root scale so one busy link doesn't crush the rest.
        positions = forceLayout(
          // Room for the two label lines; agents' labels are the widest.
          nodes.map((n) => ({ id: n.id, r: n.r + (n.kind === 'tool' ? 22 : 28), pin: n.id === 'you' ? { x: Math.max(60, width * 0.1), y: fieldH / 2 } : undefined })),
          // A subagent's tool calls pull more gently than the main agent's, so subagents spread around it rather than knot in the middle.
          edges.map((e) => ({ source: e.from, target: e.to, weight: Math.sqrt(e.count + 1) * (e.type === 'tool' && e.from !== 'agent' ? 0.35 : 1) })),
          { width, height: fieldH, padding: 34, previous: positions }
        );

        const root = svg('svg', { class: 'ln-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Living Network of ${view.summary.name || short(view.summary.sessionId)}: ${nodes.length} actors, ${graph.events.length} events` });
        const defs = svg('defs');
        for (const kind of ['you', 'agent', 'subagent', 'tool']) {
          const g = svg('radialGradient', { id: `${prefix}-glow-${kind}` });
          g.append(svg('stop', { offset: '0%', class: `ln-stop ln-${kind}`, 'stop-opacity': 0.55 }), svg('stop', { offset: '45%', class: `ln-stop ln-${kind}`, 'stop-opacity': 0.14 }), svg('stop', { offset: '100%', class: `ln-stop ln-${kind}`, 'stop-opacity': 0 }));
          defs.append(g);
        }
        const fog = svg('radialGradient', { id: `${prefix}-fog`, cx: '35%', cy: '50%', r: '70%' });
        fog.append(svg('stop', { offset: '0%', class: 'ln-fog', 'stop-opacity': 0.5 }), svg('stop', { offset: '100%', class: 'ln-fog', 'stop-opacity': 0 }));
        defs.append(fog);
        const grain = svg('filter', { id: `${prefix}-grain`, x: 0, y: 0, width: '100%', height: '100%' });
        grain.append(svg('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.9, numOctaves: 2, seed: hashId(view.summary.sessionId) % 1000, stitchTiles: 'stitch' }), svg('feColorMatrix', { type: 'saturate', values: 0 }));
        defs.append(grain);
        root.append(defs);

        // The field, its fog and grain, and the letterbox.
        root.append(svg('rect', { class: 'ln-ground', x: 0, y: 0, width, height }));
        root.append(svg('rect', { x: 0, y: HEAD, width, height: fieldH, fill: `url(#${prefix}-fog)` }));
        root.append(svg('rect', { class: 'ln-grain', x: 0, y: HEAD, width, height: fieldH, filter: `url(#${prefix}-grain)` }));
        root.append(svg('rect', { class: 'ln-bar', x: 0, y: 0, width, height: HEAD }));
        root.append(svgText({ class: 'ln-caps', x: 14, y: 18 }, `Session ${short(view.summary.sessionId)} · ${nodes.length} actors · ${fmt(graph.events.length)} events`));
        root.append(svgText({ class: 'ln-caps', x: width - 14, y: 18, 'text-anchor': 'end' }, '2D'));

        const field = svg('g', { transform: `translate(0 ${HEAD})` });
        root.append(field);
        const linkLayer = svg('g');
        const glowLayer = svg('g');
        const particleLayer = svg('g', { 'aria-hidden': 'true' });
        const nodeLayer = svg('g');
        field.append(linkLayer, glowLayer, particleLayer, nodeLayer);

        // Links: a gentle curve, bowed by a hash of the link so the bow is the same every time.
        const curves = new Map();
        for (const e of edges) {
          const a = positions.get(e.from);
          const b = positions.get(e.to);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const bow = ((hashId(e.key) % 2 ? 1 : -1) * 0.18 + (e.type === 'tool' ? 0.06 : 0)) * Math.hypot(dx, dy);
          const len = Math.hypot(dx, dy) || 1;
          const c = { x: (a.x + b.x) / 2 - (dy / len) * bow, y: (a.y + b.y) / 2 + (dx / len) * bow };
          curves.set(e.key, { a, b, c });
          const target = graph.nodes.get(e.to);
          const path = svg('path', { class: `ln-link ln-link-${e.type} ln-to-${target.kind}${e.type === 'tool' && e.from !== 'agent' ? ' ln-link-faint' : ''}`, d: `M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`, 'stroke-width': Math.min(3, 0.6 + Math.log10(e.count + 1)) });
          const hit = svg('path', { class: 'ln-link-hit', d: `M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}` });
          hit.addEventListener('mousemove', (evt) => showTip(evt, linkTip(e)));
          hit.addEventListener('mouseleave', hideTip);
          linkLayer.append(path, hit);
          e.path = path;
        }

        // Nodes: a halo that blooms, a core, a label in capitals and a muted second line.
        const nodeParts = new Map();
        for (const n of nodes) {
          const p = positions.get(n.id);
          const halo = svg('circle', { cx: p.x, cy: p.y, r: n.r * 4, fill: `url(#${prefix}-glow-${n.kind})`, opacity: 0.35 });
          glowLayer.append(halo);
          const g = svg('g', { class: `ln-node ln-${n.kind}`, transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: 'button', 'aria-label': `${KIND[n.kind]}: ${n.label}. ${nodeSummary(n)}` });
          const ring = svg('circle', { class: 'ln-ring', r: n.r + 4 });
          const core = svg('circle', { class: 'ln-core', r: n.r });
          const pip = svg('circle', { class: 'ln-pip', r: Math.max(2, n.r * 0.35) });
          const below = p.y + n.r + 16 > fieldH - 18;
          const ly = below ? -(n.r + 22) : n.r + 15;
          g.append(ring, core, pip, svgText({ class: 'ln-label', y: ly, 'text-anchor': 'middle' }, clip(n.label.toUpperCase(), 22)), svgText({ class: 'ln-sub', y: ly + 12, 'text-anchor': 'middle' }, subLine(n)));
          g.addEventListener('mousemove', (evt) => showTip(evt, nodeTip(n)));
          g.addEventListener('mouseleave', hideTip);
          const pick = () => {
            isolated = isolated === n.id ? null : n.id;
            if (isolated && n.first) ctx.select({ sessionId: view.summary.sessionId, turnId: n.first.turnId });
            else paintStatic();
          };
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (evt) => evt.key === 'Enter' && pick());
          nodeLayer.append(g);
          nodeParts.set(n.id, { g, halo, ring, core, p, n });
        }

        // Particles: a fixed pool of comet heads and tails, moved each frame.
        const pool = [];
        for (let i = 0; i < MAX_PARTICLES; i++) {
          const tail = [];
          for (let k = TAIL; k >= 1; k--) {
            const d = svg('circle', { class: 'ln-particle', r: 1.6, opacity: 0, visibility: 'hidden' });
            particleLayer.append(d);
            tail.push(d);
          }
          const head = svg('circle', { class: 'ln-particle ln-head', r: 3, visibility: 'hidden' });
          particleLayer.append(head);
          pool.push({ head, tail });
        }

        // The filters, as the concept page asks: which kinds of traffic travel.
        const filters = el('div', { class: 'ln-filters', role: 'group', 'aria-label': 'Particles shown' }, [
          ...[
            ['message', 'Prompts'],
            ['delegation', 'Delegation'],
            ['tool', 'Tool calls'],
          ].map(([type, text]) => {
            const b = el('button', { class: `ln-filter ln-filter-${type}`, text, 'aria-pressed': String(shown[type]) });
            b.addEventListener('click', () => {
              shown[type] = !shown[type];
              b.setAttribute('aria-pressed', String(shown[type]));
              paintStatic();
              paintFrame();
            });
            return b;
          }),
        ]);

        frame.replaceChildren(root, el('div', { class: 'ln-foot' }, [bar.element, filters]));
        scene = { root, nodeParts, pool, curves, fieldH, width };
        paintStatic();
        paintFrame();

        const subs = nodes.filter((n) => n.kind === 'subagent').length;
        note.textContent = [
          'Hue is the kind of actor: amber you, cyan the agent, violet subagents, magenta tool categories. A node blooms when it acts; particles run from sender to recipient while the session replays.',
          'Positions: a force layout weighted by how often two actors interacted, you pinned at the left; the same session always lands the same way.',
          subs ? 'Delegation is inferred from the events each subagent made, and no parent is recorded, so every subagent hangs off the main agent.' : 'No subagents in this session.',
          'Click an actor to isolate its neighborhood and select the first turn it worked in; click it again to let go.',
        ].join(' ');
      }

      /** The actors that stand out: an isolated actor and its neighbors, or the actors in the selected turn; null means all. */
      function standing() {
        if (isolated && graph.nodes.has(isolated)) {
          const set = new Set([isolated]);
          for (const e of graph.edges.values()) {
            if (e.from === isolated) set.add(e.to);
            if (e.to === isolated) set.add(e.from);
          }
          return set;
        }
        if (selection && selection.turnId && (!selection.sessionId || selection.sessionId === view.summary.sessionId)) {
          const set = new Set([...graph.nodes.values()].filter((n) => n.turns.has(selection.turnId)).map((n) => n.id));
          return set.size ? set : null;
        }
        return null;
      }

      /** What changes on a click or filter, not every frame: dimming. */
      function paintStatic() {
        if (!scene) return;
        const keep = standing();
        for (const [id, part] of scene.nodeParts) {
          part.g.classList.toggle('ln-dim', !!keep && !keep.has(id));
          part.g.classList.toggle('ln-isolated', isolated === id);
        }
        for (const e of graph.edges.values()) {
          const off = (keep && !(keep.has(e.from) && keep.has(e.to))) || !shown[e.type];
          e.path.classList.toggle('ln-dim', off);
        }
      }

      /** Every frame: blooms from each node's latest event, and the particles in flight. */
      function paintFrame() {
        bar.sync();
        if (!scene || !graph) return;
        const t = clock.time;
        const speed = clock.speed;
        const keep = standing();
        const moving = clock.playing;
        for (const [id, part] of scene.nodeParts) {
          const times = graph.byNode.get(id) || [];
          const n = countUpTo(times, t);
          const last = n ? times[n - 1].t : null;
          const age = last === null ? Infinity : (t - last) / speed;
          const bloom = clock.shown === 0 ? 0 : Math.exp(-age / BLOOM_MS);
          const base = n ? 0.22 + 0.18 * Math.min(1, n / 40) : 0.08;
          const dim = keep && !keep.has(id) ? 0.25 : 1;
          part.halo.setAttribute('opacity', ((base + 0.65 * bloom) * dim).toFixed(3));
          part.halo.setAttribute('r', (part.n.r * (3.2 + 2.2 * bloom)).toFixed(1));
          part.ring.setAttribute('opacity', (0.2 + 0.7 * bloom).toFixed(3));
          part.core.classList.toggle('ln-unlit', n === 0);
          // Drift is decoration: it moves while playing and never touches the layout.
          if (moving && !clock.reduced) {
            const d = drift(id, t / speed, 2.5);
            part.g.setAttribute('transform', `translate(${(part.p.x + d.dx).toFixed(1)} ${(part.p.y + d.dy).toFixed(1)})`);
            part.halo.setAttribute('cx', (part.p.x + d.dx).toFixed(1));
            part.halo.setAttribute('cy', (part.p.y + d.dy).toFixed(1));
          }
        }
        // Particles: events within the last FLIGHT_MS of playback, newest first, a few per link.
        const span = FLIGHT_MS * speed;
        const from = countUpTo(graph.events, t - span);
        const perEdge = new Map();
        const flying = [];
        for (let i = Math.min(clock.shown, graph.events.length) - 1; i >= from && flying.length < MAX_PARTICLES; i--) {
          const ev = graph.events[i];
          if (!ev.edge || !shown[ev.type]) continue;
          const used = perEdge.get(ev.edge) || 0;
          if (used >= PER_EDGE) {
            const newest = flying.find((f) => f.ev.edge === ev.edge);
            if (newest) newest.extra += 1;
            continue;
          }
          perEdge.set(ev.edge, used + 1);
          flying.push({ ev, extra: 0 });
        }
        scene.pool.forEach((slot, i) => {
          const f = flying[i];
          if (!f) {
            slot.head.setAttribute('visibility', 'hidden');
            for (const d of slot.tail) d.setAttribute('visibility', 'hidden');
            return;
          }
          const curve = scene.curves.get(f.ev.edge);
          const e = graph.edges.get(f.ev.edge);
          const dim = keep && !(keep.has(e.from) && keep.has(e.to)) ? 0.2 : 1;
          const progress = Math.min(1, Math.max(0, (t - f.ev.t) / span));
          const cls = `ln-particle ln-head ln-p-${f.ev.type}${f.ev.failure ? ' ln-p-failure' : ''}`;
          const at = onCurve(curve.a, curve.c, curve.b, progress);
          slot.head.setAttribute('class', cls);
          slot.head.setAttribute('cx', at.x.toFixed(1));
          slot.head.setAttribute('cy', at.y.toFixed(1));
          slot.head.setAttribute('r', (3 + Math.min(3, Math.sqrt(f.extra))).toFixed(1));
          slot.head.setAttribute('opacity', dim);
          slot.head.setAttribute('visibility', 'visible');
          slot.tail.forEach((d, k) => {
            const back = progress - (k + 1) * 0.045;
            if (back <= 0) {
              d.setAttribute('visibility', 'hidden');
              return;
            }
            const q = onCurve(curve.a, curve.c, curve.b, back);
            d.setAttribute('class', `ln-particle ln-p-${f.ev.type}`);
            d.setAttribute('cx', q.x.toFixed(1));
            d.setAttribute('cy', q.y.toFixed(1));
            d.setAttribute('opacity', ((0.55 - k * 0.12) * dim).toFixed(2));
            d.setAttribute('visibility', 'visible');
          });
        });
      }

      function subLine(n) {
        if (n.kind === 'you') return `${fmt(n.prompts)} prompts`;
        if (n.kind === 'tool') return `${fmt(n.tools)} calls${n.failed ? ` · ${fmt(n.failed)} failed` : ''}`;
        const model = [...n.models.entries()].sort((a, b) => b[1] - a[1])[0];
        return `${model ? model[0] + ' · ' : ''}${compact(n.tokens)} tokens`;
      }
      function nodeSummary(n) {
        return n.kind === 'tool' ? `${fmt(n.tools)} calls` : n.kind === 'you' ? `${fmt(n.prompts)} prompts` : `${fmt(n.calls)} model calls, ${fmt(n.tools)} tool calls`;
      }
      function nodeTip(n) {
        const rows = [`${KIND[n.kind]}: ${n.label}`];
        if (n.prompts) rows.push(['Prompts', fmt(n.prompts)]);
        if (n.calls) rows.push(['Model calls', fmt(n.calls)]);
        if (n.tools) rows.push([n.kind === 'tool' ? 'Calls' : 'Tool calls', fmt(n.tools)]);
        if (n.failed) rows.push(['Failed', fmt(n.failed)]);
        if (n.tokens) rows.push(['Tokens', fmt(n.tokens)]);
        if (n.kind === 'tool' && n.models.size) rows.push(['Tools', [...n.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${k} ×${c}`).join(', ')]);
        if (n.first) rows.push(['First turn', formatTime(n.first.ts)]);
        rows.push(n.first ? 'Click to isolate and select its first turn' : 'Click to isolate');
        return rows;
      }
      function linkTip(e) {
        const a = graph.nodes.get(e.from);
        const b = graph.nodes.get(e.to);
        const what = { message: 'Prompts', delegation: 'Delegation (inferred), turns', tool: 'Tool calls' }[e.type];
        const rows = [`${a.label} → ${b.label}`, [what, fmt(e.count)]];
        if (e.failed) rows.push(['Failed', fmt(e.failed)]);
        if (e.tokens) rows.push(['Tokens of delegated work', fmt(e.tokens)]);
        return rows;
      }

      return {
        update,
        resize: draw,
        setActive: (on) => clock.setActive(on),
        destroy() {
          clock.destroy();
          host.replaceChildren();
        },
      };
    },
  });
})();
