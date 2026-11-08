// Terminal Board (hero view, design language `split-flap`): a fixed station
// board with one region per actor (you, the agent, its subagents, the tool
// categories) plus the queue, tokens, and status, each a grid of fixed-width
// cells. What an actor last said or did appears only in its region, and a
// change arrives as flaps falling left to right, never a fade. See
// docs/design/visualization-explorer.md, "Terminal Board".
//
// The board shows the session at the shared replay clock's position. While
// it plays, a region holds each message for a minimum dwell before the next
// replaces it; updates that arrive meanwhile queue, and only the newest is
// shown when the dwell ends, the rest counted in the queue region, so
// simultaneous messages behave the same way every time. Paused or scrubbed,
// every region shows its latest at once. A tool region knows only a tool's
// name, category, and status: SessionView carries no arguments, and they
// shouldn't be added for this. It's a compressed view, never the transcript;
// a region's history is one click away. A session-level visualizer: draws the
// first session it's given. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_REGIONS = 12; // the actor regions and the three panels together
  const ROWS = 3; // lines per region
  const CELL_W = 17; // px per cell, the gap included
  const MIN_DWELL_MS = 1200; // wall time a line holds before the next replaces it
  const ACTIVE_MS = 60 * 1000; // session time an actor stays lit after acting
  const STAGGER_MS = 22; // between one cell's flap and the next
  const HISTORY = 30; // lines listed when a region is opened
  const TEXT_MODES = [
    ['raw', 'Raw'],
    ['keywords', 'Keywords'],
    ['summaries', 'Summaries'],
  ];

  window.snagboatViz.register({
    id: 'terminal-board',
    title: 'Terminal Board',
    tags: { category: ['conversational', 'state'], purpose: ['expressive'], level: ['session'], dimension: ['communication', 'actor', 'content'], language: ['split-flap'] },
    mount(host, ctx) {
      const { el, fmt, compact, clip, short, modelShort, formatTime, countUpTo, termsOf, modeButtons, callTokens, showTip, hideTip } = ctx;
      const frame = el('div', { class: 'hero-board' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let view = null;
      let selection = null;
      let model = null;
      let board = null; // { regions: [{ def, cells, lamp, shown: { key, lines, at }, skipped }] }
      let textMode = 'raw';
      let opened = null; // region id whose history is listed
      let skippedTotal = 0;
      const clock = ctx.createReplay({ onFrame: () => paint() });
      const bar = ctx.replayBar(clock, { label: 'the Terminal Board' });
      const clockFace = el('span', { class: 'tb-clock', 'aria-hidden': 'true' });
      const modes = modeButtons('Text', TEXT_MODES, textMode, (m) => {
        if (m === 'summaries') return;
        textMode = m;
        if (board) for (const r of board.regions) r.shown = null;
        paint();
      });
      const summariesBtn = modes.querySelectorAll('button')[2];
      summariesBtn.disabled = true;
      summariesBtn.title = 'Summaries need the advisor; not built';

      function update(sessions, sel) {
        const next = sessions[0] || null;
        if (!view || !next || view.summary.sessionId !== next.summary.sessionId) {
          opened = null;
          skippedTotal = 0;
        }
        view = next;
        selection = sel || null;
        model = view ? analyze(view) : null;
        clock.setSessions(view ? [view] : []);
        draw();
      }

      // ---------- what each region says, over time ----------
      function analyze(v) {
        const ms = (ts) => Date.parse(ts);
        const subs = [...new Set([...v.calls, ...v.tools].map((x) => x.agentId).filter(Boolean))];
        const subWork = new Map(subs.map((id) => [id, v.calls.filter((c) => c.agentId === id).length]));
        const cats = new Map();
        for (const t of v.tools) cats.set(t.category, (cats.get(t.category) || 0) + 1);
        // Room for the actors: three panels, you, the agent; subagents and tools share the rest, tools first.
        const room = MAX_REGIONS - 5;
        const toolRoom = Math.min(cats.size, Math.max(2, room - Math.min(subs.length, Math.floor(room / 2))));
        const subRoom = Math.min(subs.length, room - toolRoom);
        const subKeep = new Set([...subs].sort((a, b) => subWork.get(b) - subWork.get(a) || a.localeCompare(b)).slice(0, subs.length > subRoom ? subRoom - 1 : subRoom));
        const catKeep = new Set([...cats.keys()].sort((a, b) => cats.get(b) - cats.get(a) || a.localeCompare(b)).slice(0, cats.size > toolRoom ? toolRoom - 1 : toolRoom));

        const regions = new Map();
        const region = (id, kind, plate) => regions.get(id) || regions.set(id, { id, kind, plate, lines: [] }).get(id);
        const you = region('you', 'human', 'Human / you');
        const agent = region('agent', 'agent', `Agent / ${v.summary.agent === 'copilot' ? 'Copilot' : 'main'}`);
        const subRegion = (agentId) => (subKeep.has(agentId) ? region(`sub:${agentId}`, 'agent', `Agent / sub ${agentId.replace(/^agent-/, '').slice(0, 6)}`) : region('sub:+', 'agent', `Agent / +${subs.length - subKeep.size} subs`));
        const toolRegion = (cat) => (catKeep.has(cat) ? region(`tool:${cat}`, 'tool', `Tool / ${cat}`) : region('tool:+', 'tool', 'Tool / other'));
        // Every message, in replay order: { t, turnId, text, raw } per region.
        for (const p of v.prompts) you.lines.push({ t: ms(p.ts), turnId: p.turnId, text: p.text ? `> ${p.text}` : `> PROMPT ${p.index}`, raw: !!p.text });
        let callNo = 0;
        for (const c of v.calls) {
          callNo += 1;
          const r = c.agentId ? subRegion(c.agentId) : agent;
          const tokens = callTokens(c);
          r.lines.push({ t: ms(c.ts), turnId: c.turnId, text: c.reply || `${c.model ? modelShort(c.model) : 'model'} call ${callNo} ${compact(tokens)} tok`, raw: !!c.reply });
        }
        const toolCounts = new Map();
        for (const t of v.tools) {
          const r = toolRegion(t.category);
          const n = (toolCounts.get(r.id) || 0) + 1;
          toolCounts.set(r.id, n);
          const status = t.status === 'failure' ? 'FAILED' : t.status === 'success' ? 'OK' : '';
          const failedSoFar = (toolCounts.get(`${r.id}:failed`) || 0) + (t.status === 'failure' ? 1 : 0);
          toolCounts.set(`${r.id}:failed`, failedSoFar);
          r.lines.push({ t: ms(t.ts), turnId: t.turnId, text: `${t.name || t.category} ${status}`.trim(), n, failedSoFar, failed: t.status === 'failure' });
        }
        for (const r of regions.values()) r.lines.sort((a, b) => a.t - b.t);
        const actors = [...regions.values()].filter((r) => r.lines.length);
        // Running totals for the panels, by call.
        const calls = [...v.calls].map((c) => ({ t: ms(c.ts), input: c.input + c.cacheRead + c.cacheCreation, output: c.output })).sort((a, b) => a.t - b.t);
        let inSum = 0;
        let outSum = 0;
        for (const c of calls) {
          inSum += c.input;
          outSum += c.output;
          c.inSum = inSum;
          c.outSum = outSum;
        }
        const failures = v.tools.filter((t) => t.status === 'failure').map((t) => ({ t: ms(t.ts) })).sort((a, b) => a.t - b.t);
        return { actors, calls, failures, events: ctx.replayEvents([v]), start: ms(v.summary.firstTs) };
      }

      // ---------- the board ----------
      function draw() {
        hideTip();
        if (!view || !model) {
          frame.replaceChildren(el('p', { class: 'tb-empty', text: 'No session.' }));
          note.textContent = '';
          board = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800) - 28;
        const cols = width >= 1000 ? 4 : width >= 720 ? 3 : width >= 460 ? 2 : 1;
        const regionW = Math.floor((width - (cols - 1) * 18) / cols);
        const cells = Math.max(8, Math.floor(regionW / CELL_W));
        const defs = [...model.actors.map((r) => ({ ...r })), { id: 'queue', kind: 'panel', plate: 'Event queue' }, { id: 'tokens', kind: 'panel', plate: 'Tokens / running' }, { id: 'status', kind: 'panel', plate: 'Session status' }];
        const grid = el('div', { class: 'tb-grid' });
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        const regions = defs.map((def) => {
          const lamp = el('span', { class: 'tb-lamp', role: 'img', 'aria-label': 'idle' });
          const rows = [];
          const cellEls = [];
          for (let r = 0; r < ROWS; r++) {
            const row = el('div', { class: 'tb-row' });
            for (let c = 0; c < cells; c++) {
              const cell = el('span', { class: 'tb-cell' }, [el('span', { class: 'tb-ch', text: ' ' })]);
              row.append(cell);
              cellEls.push(cell);
            }
            rows.push(row);
          }
          const plate = el('div', { class: 'tb-plate' }, [el('span', { text: def.plate }), lamp]);
          const lines = el('div', { class: 'tb-lines', 'aria-live': 'off' }, rows);
          const box = el('section', { class: `tb-region tb-${def.kind}`, tabindex: def.lines ? 0 : undefined, role: def.lines ? 'button' : undefined, 'aria-label': `${def.plate}${def.lines ? ': open its history' : ''}` }, [plate, lines]);
          if (def.lines) {
            const open = () => {
              opened = opened === def.id ? null : def.id;
              renderHistory();
            };
            box.addEventListener('click', open);
            box.addEventListener('keydown', (e) => e.key === 'Enter' && open());
          }
          box.addEventListener('mousemove', (e) => {
            const r = board && board.regions.find((x) => x.def === def);
            if (r && r.shown) showTip(e, [def.plate, ...(r.shown.full ? [clip(r.shown.full, 160)] : []), ...(r.shown.t ? [['At', formatTime(r.shown.t)]] : []), ...(def.lines ? ['Click for its history'] : [])]);
          });
          box.addEventListener('mouseleave', hideTip);
          grid.append(box);
          return { def, cellEls, lamp, box, shown: null, pending: null };
        });
        const head = el('div', { class: 'tb-head' }, [
          el('div', { class: 'tb-title' }, [el('span', { class: 'tb-num', text: '05' }), el('div', {}, [el('strong', { text: 'Terminal Board' }), el('span', { class: 'tb-subtitle', text: `Live content & status · session ${short(view.summary.sessionId)}` })])]),
          el('div', { class: 'tb-local' }, [el('span', { class: 'tb-subtitle', text: 'Board time' }), clockFace]),
        ]);
        const history = el('div', { class: 'tb-history', 'aria-live': 'polite' });
        frame.replaceChildren(head, grid, el('div', { class: 'tb-foot' }, [bar.element, modes]), history);
        board = { regions, cells, history };
        paint();
        renderHistory();
        note.textContent = [
          'One region per actor, fixed: green is you, cream an agent, amber a tool category; a lit lamp acted in the last minute of the session, amber has been quiet since.',
          'Agents show their reply excerpts when text capture is on, and their model and tokens otherwise; a tool shows only its name and status.',
          `While playing, each line holds at least ${MIN_DWELL_MS / 1000}s; newer lines queue and only the newest is shown, the rest counted in the event queue.`,
          'A compressed view, never the transcript: click a region for its last lines, and a line to select its turn.',
        ].join(' ');
      }

      /** Text into ROWS rows of the board's width, by words, in capitals. */
      function layoutLines(text) {
        const width = board.cells;
        const words = text.replace(/\s+/g, ' ').trim().toUpperCase().split(' ');
        const rows = [''];
        for (const w0 of words) {
          let w = w0;
          while (w.length > width) {
            if (rows[rows.length - 1]) rows.push('');
            rows[rows.length - 1] = w.slice(0, width);
            w = w.slice(width);
            rows.push('');
          }
          const cur = rows[rows.length - 1];
          if (!cur) rows[rows.length - 1] = w;
          else if (cur.length + 1 + w.length <= width) rows[rows.length - 1] = `${cur} ${w}`;
          else rows.push(w);
        }
        const out = rows.filter((r, i) => r || i === 0).slice(0, ROWS);
        if (rows.filter(Boolean).length > ROWS) out[ROWS - 1] = `${out[ROWS - 1].slice(0, width - 3)}...`;
        while (out.length < ROWS) out.push('');
        return out;
      }

      function keywords(text) {
        return [...termsOf(text)].slice(0, 8).join(' ');
      }

      /** What a region should say at time t: its newest line, and how many came before it. */
      function wanted(r, t) {
        const d = r.def;
        if (d.lines) {
          const n = countUpTo(d.lines, t);
          if (!n) return { key: `${d.id}:0`, lines: layoutLines(d.kind === 'human' ? '> waiting' : '--'), n: 0 };
          const line = d.lines[n - 1];
          const body = textMode === 'keywords' && line.raw ? (line.text.startsWith('> ') ? `> ${keywords(line.text)}` : keywords(line.text)) : line.text;
          const lines = d.kind === 'tool' ? [body, `call ${fmt(line.n)} of ${fmt(d.lines.length)}`, line.failedSoFar ? `failed ${fmt(line.failedSoFar)}` : ''].map((s) => s.toUpperCase().slice(0, board.cells)) : layoutLines(body);
          return { key: `${d.id}:${n}:${textMode}`, lines, n, t: line.t, turnId: line.turnId, full: line.text, failed: line.failed };
        }
        const shown = countUpTo(model.events, t);
        if (d.id === 'queue') return { key: `q:${shown}:${skippedTotal}`, lines: [`EVENT ${String(shown).padStart(4, '0')}`, `OF ${model.events.length}`, `QUEUED PAST ${skippedTotal}`].map((s) => s.slice(0, board.cells)) };
        if (d.id === 'tokens') {
          const n = countUpTo(model.calls, t);
          const c = n ? model.calls[n - 1] : { inSum: 0, outSum: 0 };
          const pad = (label, value) => `${label}${' '.repeat(Math.max(1, board.cells - label.length - value.length))}${value}`;
          return { key: `tok:${n}`, lines: [pad('IN', compact(c.inSum)), pad('OUT', compact(c.outSum)), pad('CALLS', fmt(n))].map((s) => s.slice(0, board.cells)) };
        }
        let active = 0;
        let quiet = 0;
        for (const r2 of board.regions) {
          if (!r2.def.lines) continue;
          const n = countUpTo(r2.def.lines, t);
          if (!n) continue;
          if (t - r2.def.lines[n - 1].t <= ACTIVE_MS) active += 1;
          else quiet += 1;
        }
        const failed = countUpTo(model.failures, t);
        const pad = (label, value) => `${label}${' '.repeat(Math.max(1, board.cells - label.length - value.length))}${value}`;
        return { key: `st:${active}:${quiet}:${failed}`, lines: [pad('ACTIVE', String(active).padStart(2, '0')), pad('QUIET', String(quiet).padStart(2, '0')), pad('FAILED', String(failed).padStart(2, '0'))].map((s) => s.slice(0, board.cells)) };
      }

      /** Each frame: every region toward what it should say, flap by flap, holding each line its dwell while playing. */
      function paint() {
        bar.sync();
        if (!board || !model) return;
        const t = clock.time;
        clockFace.textContent = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const sel = selection && selection.turnId && (!selection.sessionId || selection.sessionId === view.summary.sessionId) ? selection.turnId : null;
        // Panels after actors: the status panel reads the actors' lines.
        for (const r of board.regions) {
          const want = wanted(r, t);
          if (!r.shown || r.shown.key !== want.key) {
            const holding = clock.playing && r.shown && r.def.lines && now - r.shown.at < MIN_DWELL_MS;
            if (holding) {
              if (!r.pending || r.pending.key !== want.key) {
                if (r.pending) skippedTotal += 1; // a queued line passed over by a newer one
                r.pending = want;
              }
            } else {
              flip(r, want, now);
              r.pending = null;
            }
          } else r.pending = null;
          // The lamp: lit if this actor acted in the last minute of session time, amber if quiet since, dark before its first.
          if (r.def.lines) {
            const n = countUpTo(r.def.lines, t);
            const state = !n ? 'idle' : t - r.def.lines[n - 1].t <= ACTIVE_MS ? 'active' : 'quiet';
            r.lamp.className = `tb-lamp tb-lamp-${state}`;
            r.lamp.setAttribute('aria-label', state);
            r.box.classList.toggle('tb-in-turn', !!sel && !!r.shown && r.shown.turnId === sel);
          } else r.lamp.className = 'tb-lamp tb-lamp-active';
        }
      }

      /** Replaces a region's cells with new lines; each changed cell falls as a flap, left to right. */
      function flip(r, want, now) {
        const animate = clock.playing && !clock.reduced;
        const chars = want.lines.flatMap((line) => line.padEnd(board.cells, ' ').slice(0, board.cells).split(''));
        let order = 0;
        chars.forEach((ch, i) => {
          const cell = r.cellEls[i];
          const span = cell.firstChild;
          if (span.textContent === ch) return;
          span.textContent = ch;
          if (animate) {
            cell.classList.remove('tb-flap');
            void cell.offsetWidth; // restart the animation
            cell.style.animationDelay = `${(order++ % board.cells) * STAGGER_MS}ms`;
            cell.classList.add('tb-flap');
          }
        });
        r.box.classList.toggle('tb-failed', !!want.failed);
        r.shown = { ...want, at: now };
      }

      function renderHistory() {
        if (!board) return;
        const r = opened && board.regions.find((x) => x.def.id === opened);
        if (!r || !r.def.lines) {
          board.history.replaceChildren();
          return;
        }
        const upTo = countUpTo(r.def.lines, clock.time);
        const lines = r.def.lines.slice(Math.max(0, upTo - HISTORY), upTo).reverse();
        const close = el('button', { text: 'Close' });
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          opened = null;
          renderHistory();
        });
        board.history.replaceChildren(
          el('div', { class: 'tb-history-head' }, [el('strong', { text: `${r.def.plate}: the last ${lines.length} line${lines.length === 1 ? '' : 's'} up to the board's time` }), close]),
          el(
            'ol',
            {},
            lines.map((line) => {
              const li = el('li', { tabindex: line.turnId ? 0 : undefined }, [el('span', { class: 'tb-when', text: formatTime(line.t) }), el('span', { text: clip(line.text, 400) })]);
              if (line.turnId) {
                const pick = () => ctx.select({ sessionId: view.summary.sessionId, turnId: line.turnId });
                li.addEventListener('click', pick);
                li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
              }
              return li;
            })
          )
        );
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
