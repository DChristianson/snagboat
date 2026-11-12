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
// Session and project level: every loaded session goes into one network,
// with one node per kind of agent and subagents kept per session. Clicking an
// actor isolates its neighborhood and announces the first turn it worked in.
// Sees only its host and ctx: no VS Code.
(function () {
  const MAX_SUBAGENTS = 12; // subagent nodes, the "+N subagents" fold included
  const MAX_TOOLS = 10; // tool-category nodes, an "other tools" node included
  const MAX_PARTICLES = 48; // in flight at once
  const PER_EDGE = 3; // most particles on one link at once; the rest fold into the newest's size
  const SPEED_PX = 360; // every particle travels this many px per second of playback, out or back, so a long link takes longer
  const BLOOM_MS = 1400; // playback time a node's bloom takes to fade
  const TAIL = 4; // dots in a particle's comet tail
  const HEAD = 28; // the letterbox bars
  const FOOT = 0; // the controls under the drawing are the bottom bar
  const KIND = { you: 'You', agent: 'Agent', subagent: 'Subagent', tool: 'Tool category' };
  // The shell tools (toolCategory.ts SHELL_TOOLS and its companions): what they run is classified into categories that route through the shell.
  const SHELL_TOOLS = new Set(['Bash', 'bash', 'run_in_terminal', 'BashOutput', 'KillShell']);
  const SHELL_LABEL = 'Shell command';
  const SHELL_ID = 'tool:Shell command';
  let charts = 0; // gradient and filter ids must be unique across stacked charts

  /** A point at t (0..1) along the quadratic curve from a through control c to b. */
  function onCurve(a, c, b, t) {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  }

  window.factoryClock.register({
    id: 'living-network',
    title: 'Living Network',
    tags: { category: ['actor', 'temporal'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['actor', 'communication', 'time'], language: ['cinematic'] },
    mount(host, ctx) {
      const { el, svg, svgText, compact, fmt, clip, short, modelShort, agentName, formatTime, showTip, hideTip, forceLayout, drift, hashId, countUpTo } = ctx;
      const prefix = `ln${++charts}`;
      const frame = el('div', { class: 'hero-living' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let views = [];
      let viewKey = '';
      let selection = null;
      let graph = null; // { nodes, edges, events, byNode } for the loaded sessions
      const turnKey = (sessionId, turnId) => `${sessionId}\n${turnId}`;
      const subKey = (v, agentId) => `${v.summary.sessionId}/${agentId}`;
      const title = () => (views.length === 1 ? views[0].summary.name || short(views[0].summary.sessionId) : `${views.length} sessions`);
      let positions = null; // Map id -> {x, y}, kept across updates so the layout only nudges
      let scene = null; // the drawn parts the frame loop touches
      let isolated = null; // an actor id whose neighborhood stands out
      const shown = { message: true, delegation: true, tool: true }; // particle types on
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'the Living Network' });
      const fit = ctx.fitter(host); // the drawing fills the slide's height

      function update(sessions, sel) {
        const key = sessions.map((v) => v.summary.sessionId).join('\n');
        if (key !== viewKey) {
          positions = null;
          isolated = null;
        }
        viewKey = key;
        views = sessions;
        selection = sel || null;
        graph = views.length ? buildGraph(views) : null;
        clock.setSessions(views);
        draw();
      }

      /**
       * Actors, links, and each replayed event's part in the picture, over every session given: one You, one
       * node per kind of agent (Claude Code, Copilot), subagents per session, tool categories shared.
       */
      function buildGraph(views) {
        const nodes = new Map();
        const edges = new Map();
        const ms = (ts) => Date.parse(ts);
        const node = (id, kind, label, sub) => {
          let n = nodes.get(id);
          if (!n) {
            n = { id, kind, label, sub, events: 0, calls: 0, tools: 0, routed: 0, failed: 0, tokens: 0, prompts: 0, turns: new Set(), first: null, models: new Map() };
            nodes.set(id, n);
          }
          return n;
        };
        const edge = (from, to, type) => {
          const key = `${type}|${from}|${to}`;
          let e = edges.get(key);
          if (!e) {
            e = { key, from, to, type, count: 0, back: 0, failed: 0, tokens: 0 };
            edges.set(key, e);
          }
          return e;
        };
        const known = new Set(views.flatMap((v) => v.prompts.map((p) => turnKey(v.summary.sessionId, p.turnId))));
        const touch = (n, sessionId, turnId, ts) => {
          n.events += 1;
          if (turnId && known.has(turnKey(sessionId, turnId))) {
            n.turns.add(turnKey(sessionId, turnId));
            if (!n.first || ms(ts) < ms(n.first.ts)) n.first = { sessionId, turnId, ts };
          }
        };

        // Which subagents and tool categories get their own node; the rest fold.
        const subWork = new Map();
        for (const v of views) {
          for (const c of v.calls) if (c.agentId) subWork.set(subKey(v, c.agentId), (subWork.get(subKey(v, c.agentId)) || 0) + c.input + c.cacheRead + c.cacheCreation + c.output);
          for (const t of v.tools) if (t.agentId && !subWork.has(subKey(v, t.agentId))) subWork.set(subKey(v, t.agentId), 0);
        }
        const subsRanked = [...subWork.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
        const subKeep = new Set(subsRanked.length > MAX_SUBAGENTS ? subsRanked.slice(0, MAX_SUBAGENTS - 1) : subsRanked);
        const subFolded = subsRanked.length - subKeep.size;
        // Tools a shell ran (grep, sed, a script, a build) travel through the Shell command node, which always has a node of its own.
        const toolCount = new Map();
        for (const v of views) for (const t of v.tools) if (t.category !== SHELL_LABEL) toolCount.set(t.category, (toolCount.get(t.category) || 0) + 1);
        const toolsRanked = [...toolCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
        const toolKeep = new Set(toolsRanked.length > MAX_TOOLS ? toolsRanked.slice(0, MAX_TOOLS - 1) : toolsRanked);
        const toolFolded = toolsRanked.length - toolKeep.size;

        const you = node('you', 'you', 'You', 'operator');
        const bySession = new Map(views.map((v) => [v.summary.sessionId, v]));
        const mainOf = (sessionId) => {
          const kind = bySession.get(sessionId).summary.agent;
          return node(`agent:${kind}`, 'agent', agentName(kind), 'main agent');
        };
        const actorOf = (sessionId, agentId) => {
          if (!agentId) return mainOf(sessionId);
          const key = subKey(bySession.get(sessionId), agentId);
          const id = subKeep.has(key) ? `sub:${key}` : 'sub:+';
          const n = node(id, 'subagent', id === 'sub:+' ? `+${subFolded} subagents` : `Sub ${agentId.replace(/^agent-/, '').slice(0, 6)}`, 'delegated (inferred)');
          n.parent = mainOf(sessionId).id;
          return n;
        };
        const shellNode = () => node(SHELL_ID, 'tool', SHELL_LABEL, 'routes shell commands');
        const toolOf = (category) =>
          category === SHELL_LABEL ? shellNode() : toolKeep.has(category) ? node(`tool:${category}`, 'tool', category, 'tool category') : node('tool:+', 'tool', `${toolFolded} other categories`, 'tool categories');

        // The replayed events, each with the nodes it lights and the legs its particles travel.
        const events = ctx.replayEvents(views);
        const delegated = new Set(); // session|agentId|turnId already shown as a delegation
        const parts = events.map((ev) => {
          const it = ev.item;
          const sid = ev.sessionId;
          if (ev.kind === 'prompt') {
            const main = mainOf(sid);
            you.prompts += 1;
            touch(you, sid, it.turnId, it.ts);
            touch(main, sid, it.turnId, it.ts);
            const e = edge('you', main.id, 'message');
            e.count += 1;
            return { t: ev.t, nodes: ['you', main.id], legs: [{ edge: e.key, type: 'message', forward: true }] };
          }
          if (ev.kind === 'compaction') {
            const main = mainOf(sid);
            touch(main, sid, undefined, it.ts);
            return { t: ev.t, nodes: [main.id], legs: [] };
          }
          if (ev.kind === 'call') {
            const actor = actorOf(sid, it.agentId);
            const tokens = it.input + it.cacheRead + it.cacheCreation + it.output;
            actor.calls += 1;
            actor.tokens += tokens;
            if (it.model) actor.models.set(modelShort(it.model), (actor.models.get(modelShort(it.model)) || 0) + 1);
            touch(actor, sid, it.turnId, it.ts);
            if (actor.kind === 'subagent') {
              const e = edge(actor.parent, actor.id, 'delegation');
              e.tokens += tokens;
              const key = `${sid}|${it.agentId}|${it.turnId || ''}`;
              if (!delegated.has(key)) {
                delegated.add(key);
                e.count += 1;
                touch(nodes.get(actor.parent), sid, it.turnId, it.ts);
                return { t: ev.t, nodes: [actor.parent, actor.id], legs: [{ edge: e.key, type: 'delegation', forward: true }] };
              }
            }
            return { t: ev.t, nodes: [actor.id], legs: [] };
          }
          // A tool call has one timestamp, its result: out from the actor (through the shell when a shell ran it) and straight back.
          const actor = actorOf(sid, it.agentId);
          const tool = toolOf(it.category);
          const viaShell = SHELL_TOOLS.has(it.name) && tool.id !== SHELL_ID;
          const hops = viaShell ? [actor.id, SHELL_ID, tool.id] : [actor.id, tool.id];
          const failed = it.status === 'failure';
          actor.tools += 1;
          tool.tools += 1;
          touch(actor, sid, it.turnId, it.ts);
          touch(tool, sid, it.turnId, it.ts);
          if (viaShell) {
            const sh = shellNode();
            sh.routed += 1;
            touch(sh, sid, it.turnId, it.ts);
          }
          if (it.name) tool.models.set(it.name, (tool.models.get(it.name) || 0) + 1);
          if (failed) tool.failed += 1;
          const keys = [];
          for (let i = 0; i + 1 < hops.length; i++) {
            const e = edge(hops[i], hops[i + 1], 'tool');
            e.count += 1;
            e.back += 1;
            if (failed) e.failed += 1;
            keys.push(e.key);
          }
          const out = keys.map((key) => ({ edge: key, type: 'tool', forward: true }));
          const back = [...keys].reverse().map((key) => ({ edge: key, type: 'tool', forward: false, failure: failed }));
          return { t: ev.t, nodes: hops, legs: [...out, ...back] };
        });

        // Replies come back when the work ends, not with every call: the agent's at the turn's last main-agent
        // call, a subagent's at its last event in the turn.
        for (const v of views) {
          const sid = v.summary.sessionId;
          const main = mainOf(sid);
          const prompted = new Map(v.prompts.map((p) => [p.turnId, ms(p.ts)]));
          const mainEnd = new Map();
          const subEnd = new Map();
          for (const x of [...v.calls, ...v.tools]) {
            if (!x.turnId || !prompted.has(x.turnId)) continue;
            const t = ms(x.ts);
            if (!x.agentId) {
              if (v.calls.includes(x) && t >= prompted.get(x.turnId)) mainEnd.set(x.turnId, Math.max(mainEnd.get(x.turnId) || 0, t));
            } else subEnd.set(`${x.agentId}|${x.turnId}`, Math.max(subEnd.get(`${x.agentId}|${x.turnId}`) || 0, t));
          }
          for (const [turnId, t] of mainEnd) {
            const e = edge('you', main.id, 'message');
            e.back += 1;
            parts.push({ t, nodes: [main.id, 'you'], legs: [{ edge: e.key, type: 'message', forward: false }], turnEnd: turnId });
          }
          for (const [key, t] of subEnd) {
            const sub = actorOf(sid, key.split('|')[0]);
            const e = edge(sub.parent, sub.id, 'delegation');
            e.back += 1;
            parts.push({ t, nodes: [sub.id, sub.parent], legs: [{ edge: e.key, type: 'delegation', forward: false }] });
          }
        }
        parts.sort((a, b) => a.t - b.t);
        // Each node's event times, for its bloom.
        const byNode = new Map();
        for (const p of parts) for (const id of p.nodes) (byNode.get(id) || byNode.set(id, []).get(id)).push({ t: p.t });
        return { nodes, edges, events: parts, byNode };
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!views.length || !graph) {
          frame.replaceChildren(el('p', { class: 'muted', text: 'No session.' }));
          note.textContent = '';
          scene = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const height = fit.height(Math.round(Math.min(620, Math.max(320, width * 0.5))), 300);
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
          edges.map((e) => ({ source: e.from, target: e.to, weight: Math.sqrt(e.count + 1) * (e.type === 'tool' && e.from.startsWith('sub:') ? 0.35 : 1) })),
          { width, height: fieldH, padding: 34, previous: positions }
        );

        const root = svg('svg', { class: 'ln-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Living Network of ${title()}: ${nodes.length} actors, ${clock.events.length} events` });
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
        grain.append(svg('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.9, numOctaves: 2, seed: hashId(viewKey) % 1000, stitchTiles: 'stitch' }), svg('feColorMatrix', { type: 'saturate', values: 0 }));
        defs.append(grain);
        root.append(defs);

        // The field, its fog and grain, and the letterbox.
        root.append(svg('rect', { class: 'ln-ground', x: 0, y: 0, width, height }));
        root.append(svg('rect', { x: 0, y: HEAD, width, height: fieldH, fill: `url(#${prefix}-fog)` }));
        root.append(svg('rect', { class: 'ln-grain', x: 0, y: HEAD, width, height: fieldH, filter: `url(#${prefix}-grain)` }));
        root.append(svg('rect', { class: 'ln-bar', x: 0, y: 0, width, height: HEAD }));
        root.append(svgText({ class: 'ln-caps', x: 14, y: 18 }, `${views.length === 1 ? `Session ${short(views[0].summary.sessionId)}` : `${views.length} sessions`} · ${nodes.length} actors · ${fmt(clock.events.length)} events`));
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
          // The curve's length, for a travel time at the one particle speed.
          let arc = 0;
          let prev = a;
          for (let k = 1; k <= 12; k++) {
            const q = onCurve(a, c, b, k / 12);
            arc += Math.hypot(q.x - prev.x, q.y - prev.y);
            prev = q;
          }
          curves.set(e.key, { a, b, c, dur: Math.max(120, (arc / SPEED_PX) * 1000) });
          const target = graph.nodes.get(e.to);
          const path = svg('path', { class: `ln-link ln-link-${e.type} ln-to-${target.kind}${e.type === 'tool' && e.from.startsWith('sub:') ? ' ln-link-faint' : ''}`, d: `M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`, 'stroke-width': Math.min(3, 0.6 + Math.log10(e.count + 1)) });
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
            if (isolated && n.first) ctx.select({ sessionId: n.first.sessionId, turnId: n.first.turnId });
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
        const longestTrip = Math.max(0, ...graph.events.map((ev) => ev.legs.reduce((n, l) => n + curves.get(l.edge).dur, 0)));
        scene = { root, nodeParts, pool, curves, fieldH, width, longestTrip };
        paintStatic();
        paintFrame();

        const subs = nodes.filter((n) => n.kind === 'subagent').length;
        note.textContent = [
          'Hue is the kind of actor: amber you, cyan an agent, violet subagents, magenta tool categories. A node blooms when it acts. While the sessions replay, a prompt travels out to the agent when you post it and the reply comes back, hollow, only when the turn ends; a subagent’s work goes out when it starts and comes back at its last event in the turn; a tool call, which has one timestamp, goes out and straight back. Every particle moves at the same speed.',
          'Commands a shell ran (grep, sed, a script, a build) travel through the Shell command node to their category and back.',
          'Positions: a force layout weighted by how often two actors interacted, you pinned at the left; the same session always lands the same way.',
          subs ? 'Delegation is inferred from the events each subagent made, and no parent is recorded, so every subagent hangs off the main agent.' : 'No subagents in this session.',
          'Click an actor to isolate its neighborhood and select the first turn it worked in; click it again to let go.',
        ].join(' ');
        fit.settle(height, draw);
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
        if (selection && selection.turnId) {
          const keys = views.filter((v) => !selection.sessionId || selection.sessionId === v.summary.sessionId).map((v) => turnKey(v.summary.sessionId, selection.turnId));
          const set = new Set([...graph.nodes.values()].filter((n) => keys.some((k) => n.turns.has(k))).map((n) => n.id));
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
        // Particles: each recent event's leg in flight now. Legs run one after another at the one particle speed,
        // so a trip through the shell takes longer than a direct one; newest first, a few per link and direction.
        const from = countUpTo(graph.events, t - scene.longestTrip * speed);
        const perLane = new Map();
        const flying = [];
        for (let i = countUpTo(graph.events, t) - 1; i >= from && flying.length < MAX_PARTICLES; i--) {
          const ev = graph.events[i];
          if (!ev.legs.length) continue;
          const age = (t - ev.t) / speed; // playback ms since the event
          let start = 0;
          let leg = null;
          let progress = 0;
          for (const l of ev.legs) {
            const dur = scene.curves.get(l.edge).dur;
            if (age < start + dur) {
              leg = l;
              progress = (age - start) / dur;
              break;
            }
            start += dur;
          }
          if (!leg || !shown[leg.type]) continue;
          const lane = `${leg.edge}|${leg.forward}`;
          const used = perLane.get(lane) || 0;
          if (used >= PER_EDGE) {
            const newest = flying.find((f) => f.lane === lane);
            if (newest) newest.extra += 1;
            continue;
          }
          perLane.set(lane, used + 1);
          flying.push({ leg, lane, progress, extra: 0 });
        }
        scene.pool.forEach((slot, i) => {
          const f = flying[i];
          if (!f) {
            slot.head.setAttribute('visibility', 'hidden');
            for (const d of slot.tail) d.setAttribute('visibility', 'hidden');
            return;
          }
          const curve = scene.curves.get(f.leg.edge);
          const e = graph.edges.get(f.leg.edge);
          const dim = keep && !(keep.has(e.from) && keep.has(e.to)) ? 0.2 : 1;
          // Along the link from its source, or back toward it for a reply or a result.
          const along = (p) => (f.leg.forward ? p : 1 - p);
          const progress = Math.min(1, Math.max(0, f.progress));
          const cls = `ln-particle ln-head ln-p-${f.leg.type}${f.leg.forward ? '' : ' ln-return'}${f.leg.failure ? ' ln-p-failure' : ''}`;
          const at = onCurve(curve.a, curve.c, curve.b, along(progress));
          slot.head.setAttribute('class', cls);
          slot.head.setAttribute('cx', at.x.toFixed(1));
          slot.head.setAttribute('cy', at.y.toFixed(1));
          slot.head.setAttribute('r', (3 + Math.min(3, Math.sqrt(f.extra))).toFixed(1));
          slot.head.setAttribute('opacity', dim);
          slot.head.setAttribute('visibility', 'visible');
          slot.tail.forEach((d, k) => {
            const behind = progress - (k + 1) * 0.045;
            if (behind <= 0) {
              d.setAttribute('visibility', 'hidden');
              return;
            }
            const q = onCurve(curve.a, curve.c, curve.b, along(behind));
            d.setAttribute('class', `ln-particle ln-p-${f.leg.type}`);
            d.setAttribute('cx', q.x.toFixed(1));
            d.setAttribute('cy', q.y.toFixed(1));
            d.setAttribute('opacity', ((0.55 - k * 0.12) * dim).toFixed(2));
            d.setAttribute('visibility', 'visible');
          });
        });
      }

      function subLine(n) {
        if (n.kind === 'you') return `${fmt(n.prompts)} prompts`;
        if (n.id === SHELL_ID) return `${fmt(n.routed)} routed${n.tools ? ` · ${fmt(n.tools)} own` : ''}${n.failed ? ` · ${fmt(n.failed)} failed` : ''}`;
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
        if (n.routed) rows.push(['Routed to its categories', fmt(n.routed)]);
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
        const rows = [`${a.label} ⇄ ${b.label}`, [what, fmt(e.count)]];
        if (e.back && e.type !== 'tool') rows.push([e.type === 'message' ? 'Replies back' : 'Replies back to the agent', fmt(e.back)]);
        if (e.type === 'tool' && e.from === SHELL_ID) rows.push('Routed through the shell');
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
