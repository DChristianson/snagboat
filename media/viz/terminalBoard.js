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
// a region's history is one click away. Session and project level: every loaded session shares one board, a
// region per kind of agent, subagents per session. Sees only its host and
// ctx: no VS Code.
(function () {
  const MAX_REGIONS = 12; // the actor regions and the three panels together
  const MIN_ROWS = 3; // lines per region; a taller slide gives each region more, up to MAX_ROWS
  const MAX_ROWS = 8;
  const CELL_H = 22; // px per cell; cells shrink toward CELL_H_MIN only when three lines don't fit the slide
  const CELL_H_MIN = 15;
  const PLATE_H = 26; // a region's plate and the space under it
  const ROW_GAP = 3;
  const GRID_GAP = 16;
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
    tags: { category: ['conversational', 'state'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['communication', 'actor', 'content'], language: ['split-flap'] },
    mount(host, ctx) {
      const { el, fmt, compact, clip, short, modelShort, formatTime, countUpTo, termsOf, modeButtons, callTokens, showTip, hideTip } = ctx;
      const frame = el('div', { class: 'hero-board' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      const fit = ctx.fitter(host); // the board fills the slide's height
      let rowCap = MAX_ROWS; // lowered when a draw's estimate overflowed
      let views = [];
      let viewKey = '';
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
        const key = sessions.map((v) => v.summary.sessionId).join('\n');
        if (key !== viewKey) {
          opened = null;
          skippedTotal = 0;
        }
        viewKey = key;
        views = sessions;
        selection = sel || null;
        model = views.length ? analyze(views) : null;
        clock.setSessions(views);
        draw();
      }

      // ---------- what each region says, over time ----------
      /** Every session given on one board: one region for you, one per kind of agent, subagents per session, tools shared. */
      function analyze(vs) {
        const ms = (ts) => Date.parse(ts);
        const byTime = (a, b) => ms(a.ts) - ms(b.ts);
        const tag = (v, x) => ({ ...x, sessionId: v.summary.sessionId, agent: v.summary.agent });
        const prompts = vs.flatMap((v) => v.prompts.map((x) => tag(v, x))).sort(byTime);
        const calls = vs.flatMap((v) => v.calls.map((x) => tag(v, x))).sort(byTime);
        const tools = vs.flatMap((v) => v.tools.map((x) => tag(v, x))).sort(byTime);
        const subOf = (x) => `${x.sessionId}/${x.agentId}`;
        const subs = [...new Set([...calls, ...tools].filter((x) => x.agentId).map(subOf))];
        const subWork = new Map(subs.map((id) => [id, calls.filter((c) => c.agentId && subOf(c) === id).length]));
        const cats = new Map();
        for (const t of tools) cats.set(t.category, (cats.get(t.category) || 0) + 1);
        const agentKinds = [...new Set(vs.map((v) => v.summary.agent))];
        // Room for the actors: three panels, you, the agents; subagents and tools share the rest, tools first.
        const room = MAX_REGIONS - 4 - agentKinds.length;
        const toolRoom = Math.min(cats.size, Math.max(2, room - Math.min(subs.length, Math.floor(room / 2))));
        const subRoom = Math.min(subs.length, room - toolRoom);
        const subKeep = new Set([...subs].sort((a, b) => subWork.get(b) - subWork.get(a) || a.localeCompare(b)).slice(0, subs.length > subRoom ? subRoom - 1 : subRoom));
        const catKeep = new Set([...cats.keys()].sort((a, b) => cats.get(b) - cats.get(a) || a.localeCompare(b)).slice(0, cats.size > toolRoom ? toolRoom - 1 : toolRoom));

        const regions = new Map();
        const region = (id, kind, plate) => regions.get(id) || regions.set(id, { id, kind, plate, lines: [] }).get(id);
        const you = region('you', 'human', 'Human / you');
        const agentRegion = (kind) => region(`agent:${kind}`, 'agent', `Agent / ${kind === 'copilot' ? 'Copilot' : agentKinds.length > 1 ? 'Claude Code' : 'main'}`);
        for (const kind of agentKinds) agentRegion(kind);
        const subRegion = (x) => (subKeep.has(subOf(x)) ? region(`sub:${subOf(x)}`, 'agent', `Agent / sub ${x.agentId.replace(/^agent-/, '').slice(0, 6)}`) : region('sub:+', 'agent', `Agent / +${subs.length - subKeep.size} subs`));
        const toolRegion = (cat) => (catKeep.has(cat) ? region(`tool:${cat}`, 'tool', `Tool / ${cat}`) : region('tool:+', 'tool', 'Tool / other'));
        // Every message, in time order: { t, sessionId, turnId, text, raw } per region.
        for (const p of prompts) you.lines.push({ t: ms(p.ts), sessionId: p.sessionId, turnId: p.turnId, text: p.text ? `> ${p.text}` : `> PROMPT ${p.index}`, raw: !!p.text });
        let callNo = 0;
        for (const c of calls) {
          callNo += 1;
          const r = c.agentId ? subRegion(c) : agentRegion(c.agent);
          const tokens = callTokens(c);
          r.lines.push({ t: ms(c.ts), sessionId: c.sessionId, turnId: c.turnId, text: c.reply || `${c.model ? modelShort(c.model) : 'model'} call ${callNo} ${compact(tokens)} tok`, raw: !!c.reply });
        }
        const toolCounts = new Map();
        for (const t of tools) {
          const r = toolRegion(t.category);
          const n = (toolCounts.get(r.id) || 0) + 1;
          toolCounts.set(r.id, n);
          const status = t.status === 'failure' ? 'FAILED' : t.status === 'success' ? 'OK' : '';
          const failedSoFar = (toolCounts.get(`${r.id}:failed`) || 0) + (t.status === 'failure' ? 1 : 0);
          toolCounts.set(`${r.id}:failed`, failedSoFar);
          r.lines.push({ t: ms(t.ts), sessionId: t.sessionId, turnId: t.turnId, text: `${t.name || t.category} ${status}`.trim(), n, failedSoFar, failed: t.status === 'failure' });
        }
        for (const r of regions.values()) r.lines.sort((a, b) => a.t - b.t);
        const actors = [...regions.values()].filter((r) => r.lines.length);
        // Running totals for the panels, by call.
        const totals = calls.map((c) => ({ t: ms(c.ts), input: c.input + c.cacheRead + c.cacheCreation, output: c.output }));
        let inSum = 0;
        let outSum = 0;
        for (const c of totals) {
          inSum += c.input;
          outSum += c.output;
          c.inSum = inSum;
          c.outSum = outSum;
        }
        const failures = tools.filter((t) => t.status === 'failure').map((t) => ({ t: ms(t.ts) }));
        return { actors, calls: totals, failures, events: ctx.replayEvents(vs) };
      }

      // ---------- the board ----------
      function draw() {
        hideTip();
        if (!views.length || !model) {
          frame.replaceChildren(el('p', { class: 'tb-empty', text: 'No session.' }));
          note.textContent = '';
          board = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800) - 28;
        const cols = width >= 1000 ? 4 : width >= 720 ? 3 : width >= 460 ? 2 : 1;
        const regionW = Math.floor((width - (cols - 1) * 18) / cols);
        const defs = [...model.actors.map((r) => ({ ...r })), { id: 'queue', kind: 'panel', plate: 'Event queue' }, { id: 'tokens', kind: 'panel', plate: 'Tokens / running' }, { id: 'status', kind: 'panel', plate: 'Session status' }];
        // The board fills the slide's height: a taller slide gives each region more lines, and only a slide too
        // short for three lines shrinks the cells. Cells keep a readable size, so a line holds as many characters as before.
        const regionRows = Math.ceil(defs.length / cols);
        const gridH = fit.height(null, 0);
        const perRegion = gridH === null ? null : (gridH - (regionRows - 1) * GRID_GAP) / regionRows - PLATE_H; // px for a region's lines
        let rows = MIN_ROWS;
        let cellH = CELL_H;
        if (perRegion !== null) {
          rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(perRegion / (CELL_H + ROW_GAP)), rowCap));
          cellH = Math.round(Math.max(CELL_H_MIN, Math.min(CELL_H, perRegion / rows - ROW_GAP)));
        }
        const cellW = Math.round(cellH * 0.68);
        frame.style.setProperty('--tb-cell-h', `${cellH}px`);
        frame.style.setProperty('--tb-cell-w', `${cellW}px`);
        const cells = Math.max(8, Math.floor(regionW / (cellW + 2)));
        const grid = el('div', { class: 'tb-grid' });
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        const regions = defs.map((def) => {
          const lamp = el('span', { class: 'tb-lamp', role: 'img', 'aria-label': 'idle' });
          const rowEls = [];
          const cellEls = [];
          for (let r = 0; r < rows; r++) {
            const row = el('div', { class: 'tb-row' });
            for (let c = 0; c < cells; c++) {
              const cell = el('span', { class: 'tb-cell' }, [el('span', { class: 'tb-ch', text: ' ' })]);
              row.append(cell);
              cellEls.push(cell);
            }
            rowEls.push(row);
          }
          const plate = el('div', { class: 'tb-plate' }, [el('span', { text: def.plate }), lamp]);
          const lines = el('div', { class: 'tb-lines', 'aria-live': 'off' }, rowEls);
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
          el('div', { class: 'tb-title' }, [el('span', { class: 'tb-num', text: '05' }), el('div', {}, [el('strong', { text: 'Terminal Board' }), el('span', { class: 'tb-subtitle', text: `Live content & status · ${views.length === 1 ? `session ${short(views[0].summary.sessionId)}` : `${views.length} sessions`}` })])]),
          el('div', { class: 'tb-local' }, [el('span', { class: 'tb-subtitle', text: 'Board time' }), clockFace]),
        ]);
        const history = el('div', { class: 'tb-history', 'aria-live': 'polite' });
        frame.replaceChildren(head, grid, el('div', { class: 'tb-foot' }, [bar.element, modes]), history);
        board = { regions, cells, rows, history };
        paint();
        renderHistory();
        note.textContent = [
          'One region per actor, fixed: green is you, cream an agent, amber a tool category; a lit lamp acted in the last minute of the session, amber has been quiet since.',
          'Agents show their reply excerpts when text capture is on, and their model and tokens otherwise; a tool shows only its name and status.',
          `While playing, each line holds at least ${MIN_DWELL_MS / 1000}s; newer lines queue and only the newest is shown, the rest counted in the event queue.`,
          'A compressed view, never the transcript: click a region for its last lines, and a line to select its turn.',
        ].join(' ');
        // The estimate above can be off by a plate's height: if the board still overflows, take a line off each region.
        if (gridH !== null && grid.offsetHeight > gridH + 2 && rows > MIN_ROWS && rowCap > rows - 1) {
          rowCap = rows - 1;
          draw();
          return;
        }
        fit.settle(grid.offsetHeight, draw);
      }

      /** Text into the board's rows, at its width, by words, in capitals. */
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
        const n = board.rows;
        const out = rows.filter((r, i) => r || i === 0).slice(0, n);
        if (rows.filter(Boolean).length > n) out[n - 1] = `${out[n - 1].slice(0, width - 3)}...`;
        while (out.length < n) out.push('');
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
          return { key: `${d.id}:${n}:${textMode}`, lines, n, t: line.t, sessionId: line.sessionId, turnId: line.turnId, full: line.text, failed: line.failed };
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
        const sel = selection && selection.turnId ? selection : null;
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
            r.box.classList.toggle('tb-in-turn', !!sel && !!r.shown && r.shown.turnId === sel.turnId && (!sel.sessionId || sel.sessionId === r.shown.sessionId));
          } else r.lamp.className = 'tb-lamp tb-lamp-active';
        }
      }

      /** Replaces a region's cells with new lines; each changed cell falls as a flap, left to right. */
      function flip(r, want, now) {
        const animate = clock.playing && !clock.reduced;
        const lines = [...want.lines];
        while (lines.length < board.rows) lines.push('');
        const chars = lines.slice(0, board.rows).flatMap((line) => line.padEnd(board.cells, ' ').slice(0, board.cells).split(''));
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
                const pick = () => ctx.select({ sessionId: line.sessionId, turnId: line.turnId });
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
        resize() {
          rowCap = MAX_ROWS;
          draw();
        },
        setActive: (on) => clock.setActive(on),
        destroy() {
          clock.destroy();
          host.replaceChildren();
        },
      };
    },
  });
})();
