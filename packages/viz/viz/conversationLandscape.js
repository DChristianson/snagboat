// Conversation Landscape (hero view, design language `edgeless`): not just
// that actors talked, but what they talked about. Each actor is a dot in one
// saturated hue (you, the agent, each subagent, the tool categories), and
// the words it emitted orbit it in that hue, sized by how much they're its
// own. No edge is drawn: relationships live only in how close the dots are,
// set by the shared force layout under a model the view names on screen.
// See docs/design/visualization-explorer.md, "Conversation Landscape".
//
// The words are counted, not read: your prompts and the agents' reply
// excerpts (when text capture is on), weighted by how often an actor used a
// word and how few other actors did. Tools have no text, so a tool category's
// words are its tool names and its failures. The semantic mode needs derived
// data Snagboat doesn't keep, so it's offered disabled, with the reason.
// Replay shows the field forming: an actor's dot appears when it first acts
// and its words fade in and grow as they're used. A session-level
// visualizer: draws the first session it's given. Clicking a word lists the
// messages it came from; clicking a dot lists the actor's messages; clicking
// a message selects its turn. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_WORDS = 5; // per actor
  const MAX_SUBAGENTS = 6; // subagent dots, then one for the rest
  const MAX_TOOLS = 5; // tool-category dots, then one for the rest
  const CLOUD = 74; // room the layout leaves around a dot for its words
  const MIN_FONT = 11;
  const MAX_FONT = 30;
  const MAX_TOOL_FONT = 19;
  const DECAY_MS = 2500; // playback time an actor's activity takes to fade to a third
  const FADE_FLOOR = 0.3; // how far an idle actor and its words fade
  const HUES = ['red', 'purple', 'blue', 'green', 'amber'];
  const MODES = [
    ['interaction', 'Interaction'],
    ['delegation', 'Delegation'],
    ['semantic', 'Semantic'],
  ];
  const MODE_NOTE = {
    interaction: 'Interaction: dots are pulled together by how many prompts, delegations, and tool calls passed between them.',
    delegation: 'Delegation: only who handed work to whom pulls dots together (you to the agent, the agent to its subagents, each actor to the tools it called, weakly).',
  };

  window.factoryClock.register({
    id: 'conversation-landscape',
    title: 'Conversation Landscape',
    tags: { category: ['semantic', 'conversational', 'actor'], purpose: ['expressive'], level: ['session'], dimension: ['content', 'actor', 'communication'], language: ['edgeless'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, clip, short, formatTime, showTip, hideTip, forceLayout, hashId, countUpTo, termsOf, foldPlural, modeButtons } = ctx;
      const frame = el('div', { class: 'hero-edgeless' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let view = null;
      let selection = null;
      let model = null;
      let mode = 'interaction';
      let positions = { interaction: null, delegation: null };
      let scene = null;
      let reading = null; // { kind: 'word' | 'actor', id, term? } listed under the field
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'the Conversation Landscape' });
      const fit = ctx.fitter(host); // the drawing fills the slide's height

      const modeBar = modeButtons('Proximity', MODES, mode, (m) => {
        if (m === 'semantic') return; // disabled below; never chosen
        mode = m;
        draw();
      });
      // Semantic proximity needs embeddings or model labels, which Snagboat doesn't keep.
      const semanticBtn = modeBar.querySelectorAll('button')[2];
      semanticBtn.disabled = true;
      semanticBtn.title = 'Needs derived data (embeddings or a model’s labels) that Snagboat doesn’t keep';

      function update(sessions, sel) {
        const next = sessions[0] || null;
        if (!view || !next || view.summary.sessionId !== next.summary.sessionId) {
          positions = { interaction: null, delegation: null };
          reading = null;
        }
        view = next;
        selection = sel || null;
        model = view ? analyze(view) : null;
        clock.setSessions(view ? [view] : []);
        draw();
      }

      /** Actors, their messages and words, and the links the two proximity models weigh. */
      function analyze(v) {
        const actors = new Map();
        const actor = (id, kind, label, hue) => {
          let a = actors.get(id);
          if (!a) {
            a = { id, kind, label, hue, messages: [], tools: new Map(), failed: 0, first: Infinity, texted: 0, acts: [] };
            actors.set(id, a);
          }
          return a;
        };
        const subs = [...new Set([...v.calls, ...v.tools].map((x) => x.agentId).filter(Boolean))];
        const subWork = new Map(subs.map((id) => [id, v.calls.filter((c) => c.agentId === id).length + v.tools.filter((t) => t.agentId === id).length]));
        const subKeep = new Set([...subs].sort((a, b) => subWork.get(b) - subWork.get(a) || a.localeCompare(b)).slice(0, subs.length > MAX_SUBAGENTS ? MAX_SUBAGENTS - 1 : MAX_SUBAGENTS));
        const cats = new Map();
        for (const t of v.tools) cats.set(t.category, (cats.get(t.category) || 0) + 1);
        const catKeep = new Set([...cats.keys()].sort((a, b) => cats.get(b) - cats.get(a) || a.localeCompare(b)).slice(0, cats.size > MAX_TOOLS ? MAX_TOOLS - 1 : MAX_TOOLS));

        const you = actor('you', 'you', 'You', 'red');
        const main = actor('agent', 'agent', 'Agent', 'purple');
        let subHue = 0;
        const actorFor = (agentId) => {
          if (!agentId) return main;
          if (!subKeep.has(agentId)) return actor('sub:+', 'subagent', `${subs.length - subKeep.size} more subagents`, 'blue');
          const a = actors.get(`sub:${agentId}`);
          return a || actor(`sub:${agentId}`, 'subagent', `Subagent ${agentId.replace(/^agent-/, '').slice(0, 6)}`, subHue++ % 2 === 0 ? 'blue' : 'green');
        };
        const toolActor = (category) => (catKeep.has(category) ? actor(`tool:${category}`, 'tool', category, 'amber') : actor('tool:+', 'tool', 'Other tools', 'amber'));
        const links = new Map();
        const link = (a, b, type) => {
          const key = [a, b].sort().join('|') + `|${type}`;
          const l = links.get(key) || links.set(key, { a, b, type, count: 0 }).get(key);
          l.count += 1;
        };
        const ms = (ts) => Date.parse(ts);

        for (const p of v.prompts) {
          you.first = Math.min(you.first, ms(p.ts));
          you.acts.push({ t: ms(p.ts) });
          main.first = Math.min(main.first, ms(p.ts));
          link('you', 'agent', 'message');
          if (p.text) you.messages.push({ t: ms(p.ts), turnId: p.turnId, text: p.text, label: `P${p.index}` });
        }
        const delegated = new Set();
        for (const c of v.calls) {
          const a = actorFor(c.agentId);
          a.first = Math.min(a.first, ms(c.ts));
          a.acts.push({ t: ms(c.ts) });
          if (c.agentId && !delegated.has(`${c.agentId}|${c.turnId}`)) {
            delegated.add(`${c.agentId}|${c.turnId}`);
            link('agent', a.id, 'delegation');
          }
          if (c.reply) a.messages.push({ t: ms(c.ts), turnId: c.turnId, text: c.reply, label: 'reply' });
        }
        for (const t of v.tools) {
          const caller = actorFor(t.agentId);
          const tool = toolActor(t.category);
          tool.first = Math.min(tool.first, ms(t.ts));
          tool.acts.push({ t: ms(t.ts) });
          link(caller.id, tool.id, 'tool');
          const name = t.name || t.category;
          const entry = tool.tools.get(name) || tool.tools.set(name, { name, times: [], fails: [] }).get(name);
          entry.times.push({ t: ms(t.ts), turnId: t.turnId });
          if (t.status === 'failure') {
            entry.fails.push({ t: ms(t.ts), turnId: t.turnId });
            tool.failed += 1;
          }
        }

        // Words: an actor's terms by how often it used them, times how few other actors did.
        const texted = [...actors.values()].filter((a) => a.messages.length);
        for (const a of texted) for (const m of a.messages) m.terms = termsOf(m.text);
        const vocab = new Set(texted.flatMap((a) => a.messages.flatMap((m) => [...m.terms])));
        const df = new Map();
        for (const a of texted) {
          const mine = new Set();
          for (const m of a.messages) {
            m.terms = new Set([...m.terms].map((t) => foldPlural(t, vocab)));
            for (const t of m.terms) mine.add(t);
          }
          for (const t of mine) df.set(t, (df.get(t) || 0) + 1);
        }
        for (const a of actors.values()) {
          if (a.kind === 'tool') {
            // A tool category's words: its tools' names, and its failures as their own word. A category
            // with one tool (every shell category is Bash) says how many calls instead of repeating the name.
            const entries = [...a.tools.values()].sort((x, y) => y.times.length - x.times.length || x.name.localeCompare(y.name));
            a.words =
              entries.length === 1
                ? [{ term: entries[0].name, display: `${entries[0].times.length} call${entries[0].times.length === 1 ? '' : 's'}`, times: entries[0].times, weight: entries[0].times.length, tool: true }]
                : entries.slice(0, MAX_WORDS - (a.failed ? 1 : 0)).map((e) => ({ term: e.name, display: `${e.name} ×${e.times.length}`, times: e.times, weight: e.times.length, tool: true }));
            if (a.failed) {
              const fails = [...a.tools.values()].flatMap((e) => e.fails).sort((x, y) => x.t - y.t);
              a.words.push({ term: 'FAIL', display: `FAIL ×${a.failed}`, times: fails, weight: a.failed, tool: true, failure: true });
            }
            continue;
          }
          const counts = new Map();
          for (const m of a.messages)
            for (const t of m.terms) {
              const c = counts.get(t) || counts.set(t, { term: t, times: [], n: 0 }).get(t);
              c.n += 1;
              c.times.push({ t: m.t, turnId: m.turnId });
            }
          const n = Math.max(1, texted.length);
          a.words = [...counts.values()]
            .filter((c) => c.n >= 2 || a.messages.length < 4)
            .map((c) => ({ term: c.term, display: c.term, times: c.times.sort((x, y) => x.t - y.t), weight: c.n * Math.log(1 + n / (df.get(c.term) || 1)) }))
            .sort((x, y) => y.weight - x.weight || x.term.localeCompare(y.term))
            .slice(0, MAX_WORDS);
          a.texted = a.messages.length;
        }
        for (const a of actors.values()) a.acts.sort((x, y) => x.t - y.t);
        const list = [...actors.values()].filter((a) => Number.isFinite(a.first));
        return { actors: list, byId: new Map(list.map((a) => [a.id, a])), links: [...links.values()], anyText: texted.length > 0, maxActs: Math.max(1, ...list.map((a) => a.acts.length)) };
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!view || !model) {
          frame.replaceChildren(el('p', { class: 'ce-empty', text: 'No session.' }));
          note.textContent = '';
          scene = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const height = fit.height(Math.round(Math.min(620, Math.max(360, width * 0.56))), 320);
        const weights = model.links.map((l) => ({ source: l.a, target: l.b, weight: mode === 'interaction' ? Math.sqrt(l.count) : l.type === 'tool' ? 0.3 : l.type === 'delegation' ? 4 : 3 }));
        positions[mode] = forceLayout(
          model.actors.map((a) => ({ id: a.id, r: CLOUD, pin: a.id === 'you' ? { x: Math.max(CLOUD, width * 0.14), y: height * 0.35 } : undefined })),
          weights,
          { width, height, padding: 10, previous: positions[mode], spacing: CLOUD * 2.1 }
        );
        const pos = positions[mode];

        const root = svg('svg', { class: 'ce-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Conversation Landscape of ${view.summary.name || short(view.summary.sessionId)}: ${model.actors.length} actors` });
        root.append(svg('rect', { class: 'ce-ground', x: 0, y: 0, width, height }));
        // What was said leads: text words and tool words have scales of their own, and tool words top out smaller.
        const maxText = Math.max(1e-9, ...model.actors.flatMap((a) => a.words.filter((w) => !w.tool).map((w) => w.weight)));
        const maxTool = Math.max(1e-9, ...model.actors.flatMap((a) => a.words.filter((w) => w.tool).map((w) => w.weight)));
        const fontOf = (w) => Math.round(MIN_FONT + ((w.tool ? MAX_TOOL_FONT : MAX_FONT) - MIN_FONT) * Math.sqrt(w.weight / (w.tool ? maxTool : maxText)));
        const placed = []; // rectangles already taken: dots and words
        const overlaps = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
        for (const a of model.actors) {
          const p = pos.get(a.id);
          const nameW = Math.min(24, a.label.length) * 7 + 8; // the name under the dot, in spaced capitals
          placed.push({ x: p.x - 16, y: p.y - 16, w: 32, h: 32 }, { x: p.x - nameW / 2, y: p.y + 18, w: nameW, h: 14 });
        }

        const dotParts = new Map();
        const wordParts = [];
        for (const a of model.actors) {
          const p = pos.get(a.id);
          const g = svg('g', { class: `ce-actor ce-${a.hue}` });
          const halo = svg('circle', { class: 'ce-halo', cx: p.x, cy: p.y, r: 16 });
          const dot = svg('circle', { class: 'ce-dot', cx: p.x, cy: p.y, r: 7 });
          const name = svgText({ class: 'ce-name', x: p.x, y: p.y + 28, 'text-anchor': 'middle' }, clip(a.label.toUpperCase(), 24));
          const hit = svg('circle', { class: 'ce-hit', cx: p.x, cy: p.y, r: 18, tabindex: 0, role: 'button', 'aria-label': `${a.label}: ${actorSummary(a)}. Show its messages.` });
          ctx.interact(ctx, hit, { tip: () => [a.label, ['Messages with text', fmt(a.messages.length)], ...(a.kind === 'tool' ? [['Tool calls', fmt([...a.tools.values()].reduce((n, e) => n + e.times.length, 0))]] : []), ...(a.failed ? [['Failed', fmt(a.failed)]] : []), 'Click to list what it said'], pick: () => read({ kind: 'actor', id: a.id }) });
          g.append(halo, dot, name, hit);
          root.append(g);
          dotParts.set(a.id, { g, halo, dot, a });

          // Words on a spiral out from the dot, starting at an angle from a hash of the word, never overlapping.
          for (const w of a.words) {
            const size = fontOf(w);
            const tw = w.display.length * size * 0.56;
            const th = size * 1.05;
            let spot = null;
            const a0 = ((hashId(`${a.id}|${w.term}`) % 360) * Math.PI) / 180;
            for (let k = 0; k < 220 && !spot; k++) {
              const ang = a0 + k * 0.55;
              const rad = 26 + k * 2.2;
              const cx = p.x + Math.cos(ang) * rad;
              const cy = p.y + Math.sin(ang) * rad * 0.75;
              const r = { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th };
              if (r.x < 4 || r.y < 4 || r.x + r.w > width - 4 || r.y + r.h > height - 4) continue;
              if (!overlaps(r)) spot = r;
            }
            if (!spot) continue;
            placed.push(spot);
            const t = svgText({ class: `ce-word${w.failure ? ' ce-failure' : ''}${size < 15 ? ' ce-small' : ''}`, x: spot.x + spot.w / 2, y: spot.y + th * 0.8, 'text-anchor': 'middle', 'font-size': size, tabindex: 0, role: 'button', 'aria-label': `${w.display}, from ${a.label}. Show where it came from.` }, w.display);
            ctx.interact(ctx, t, {
              tip: () => [`${w.display} · ${a.label}`, [w.tool ? 'Calls' : 'Messages', fmt(w.times.length)], ...(w.tool ? [] : [['Weight', w.weight.toFixed(1)]]), 'Click to list where it came from'],
              pick: () => read({ kind: 'word', id: a.id, term: w.term }),
            });
            g.append(t);
            wordParts.push({ t, w, a, size });
          }
        }

        const head = el('div', { class: 'ce-head' }, [el('span', { class: 'ce-caps', text: `Communication & meaning · ${short(view.summary.sessionId)}` }), el('span', { class: 'ce-caps', text: `Force model: ${mode}` })]);
        const reader = el('div', { class: 'ce-reader', 'aria-live': 'polite' });
        frame.replaceChildren(head, root, el('div', { class: 'ce-foot' }, [modeBar, bar.element]), reader);
        scene = { dotParts, wordParts, reader };
        paintFrame();
        renderReader();

        note.textContent = [
          MODE_NOTE[mode],
          'Distance means interaction only in that mode; no line is drawn between actors.',
          'Words are counted, not read by a model: each actor’s are the ones it used most that other actors used least, from your prompts and the agents’ reply excerpts. A tool category’s words are its tools’ names and its failures.',
          model.anyText ? '' : 'No text was captured for this session (text capture off, or before it existed), so only tools have words.',
          'Click a word for the messages it came from, a dot for everything that actor said; click a message to select its turn.',
        ]
          .filter(Boolean)
          .join(' ');
        fit.settle(height, draw);
      }

      /** Each frame: dots appear when an actor first acts; words fade in and grow as they're used. */
      function paintFrame() {
        bar.sync();
        if (!scene) return;
        const t = clock.time;
        const sel = selection && selection.turnId && (!selection.sessionId || selection.sessionId === view.summary.sessionId) ? selection.turnId : null;
        const focus = reading ? reading.id : null;
        // Once a replay has finished (or with reduced motion) the picture rests: everything at full strength, dots sized by calls.
        const resting = !clock.playing && clock.atEnd();
        const tau = DECAY_MS * clock.speed;
        for (const [id, part] of scene.dotParts) {
          const a = part.a;
          const on = a.first <= t;
          part.g.classList.toggle('ce-unborn', !on);
          part.g.classList.toggle('ce-faded', !!focus && focus !== id);
          // Activity: each act adds a pulse that decays; a dot swells with it and shrinks back, its words fade with it.
          const n = countUpTo(a.acts, t);
          let activity = 0;
          for (let i = n - 1; i >= 0 && n - i <= 200; i--) {
            const age = t - a.acts[i].t;
            if (age > tau * 5) break;
            activity += Math.exp(-age / tau);
          }
          const strength = resting ? 1 : Math.min(1, activity);
          const base = 4 + 5 * Math.sqrt(n / model.maxActs); // grows with the calls made so far
          const pulse = resting ? 0 : 7 * Math.min(1, activity / 3);
          const r = base + pulse;
          part.dot.setAttribute('r', r.toFixed(1));
          part.halo.setAttribute('r', (r * 2 + 4 * strength).toFixed(1));
          part.g.setAttribute('opacity', (FADE_FLOOR + (1 - FADE_FLOOR) * strength).toFixed(2));
        }
        for (const wp of scene.wordParts) {
          const n = countUpTo(wp.w.times, t);
          const share = n / wp.w.times.length;
          wp.t.setAttribute('opacity', n === 0 ? 0 : (0.35 + 0.65 * share).toFixed(2));
          wp.t.setAttribute('font-size', Math.max(MIN_FONT - 2, Math.round(wp.size * (0.6 + 0.4 * share))));
          wp.t.classList.toggle('ce-in-turn', !!sel && wp.w.times.some((x) => x.turnId === sel));
          wp.t.classList.toggle('ce-reading', !!reading && reading.kind === 'word' && reading.id === wp.a.id && reading.term === wp.w.term);
        }
      }

      function read(next) {
        reading = reading && reading.kind === next.kind && reading.id === next.id && reading.term === next.term ? null : next;
        renderReader();
        paintFrame();
      }

      /** The messages behind a word or an actor, original text one click from the picture. */
      function renderReader() {
        if (!scene) return;
        const a = reading && model.byId.get(reading.id);
        if (!a) {
          scene.reader.replaceChildren();
          return;
        }
        let items;
        let title;
        if (a.kind === 'tool') {
          const word = reading.kind === 'word' ? a.words.find((w) => w.term === reading.term) : null;
          const times = word ? word.times : [...a.tools.values()].flatMap((e) => e.times).sort((x, y) => x.t - y.t);
          title = word ? `${word.display} · ${a.label}` : `${a.label}: tool calls`;
          items = times.slice(0, 40).map((x) => ({ t: x.t, turnId: x.turnId, text: word ? word.display.replace(/ ×\d+$/, '') : a.label }));
        } else {
          const msgs = reading.kind === 'word' ? a.messages.filter((m) => m.terms.has(reading.term)) : a.messages;
          title = reading.kind === 'word' ? `“${reading.term}” in ${fmt(msgs.length)} of ${a.label}’s messages` : `${a.label}: ${fmt(msgs.length)} messages`;
          items = msgs.slice(0, 40).map((m) => ({ t: m.t, turnId: m.turnId, text: m.text, label: m.label }));
        }
        const close = el('button', { class: 'ce-close', text: 'Close' });
        close.addEventListener('click', () => read(reading));
        scene.reader.replaceChildren(
          el('div', { class: 'ce-reader-head' }, [el('strong', { class: `ce-${a.hue}-ink`, text: title }), close]),
          el(
            'ol',
            { class: 'ce-messages' },
            items.map((m) => {
              const li = el('li', { tabindex: m.turnId ? 0 : undefined }, [el('span', { class: 'ce-when', text: `${formatTime(m.t)}${m.label ? ` · ${m.label}` : ''}` }), el('span', { class: 'ce-text', text: clip(m.text, 600) })]);
              if (m.turnId) {
                const pick = () => ctx.select({ sessionId: view.summary.sessionId, turnId: m.turnId });
                li.addEventListener('click', pick);
                li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
              }
              return li;
            })
          ),
          ...(items.length >= 40 ? [el('p', { class: 'ce-when', text: 'The first 40; the rest are in the session’s other views.' })] : [])
        );
      }

      function actorSummary(a) {
        return a.kind === 'tool' ? `${fmt([...a.tools.values()].reduce((n, e) => n + e.times.length, 0))} tool calls` : `${fmt(a.messages.length)} messages with text`;
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
