// Sequence diagram: who sent what to whom, in order. Lifelines left to right
// are you, the main agent, each subagent, and each tool category used; rows
// top to bottom are one session's events, grouped under a band per turn. A run
// of tool calls from one agent to one category folds into one arrow with ×N.
// Delegation arrows are inferred: the log has no link from a subagent to the
// call that started it, so they're drawn dashed at its first event. See
// docs/design/visualization-explorer.md for the contract. A session-level
// visualizer: the explorer gives it one session at a time. Clicking a turn's
// band announces { sessionId, turnId }. Sees only its host and ctx: no VS Code.
(function () {
  // Rows drawn per turn, and in all; the selected turn gets its own, larger allowance.
  const TURN_ROWS = 60;
  const TOTAL_ROWS = 600;
  const SELECTED_ROWS = 500;

  const BAND_H = 24;
  const ARROW_H = 26;
  const SELF_H = 16;
  const NOTE_H = 26;
  const MORE_H = 20;
  const MIN_LANE = 88;
  const SIDE = 8;
  const HEAD_H = 38;

  const RANK = { prompt: 0, compaction: 1, delegate: 2, call: 3, tool: 4 };

  window.factoryClock.register({
    id: 'sequence-diagram',
    title: 'Sequence diagram',
    tags: { category: ['conversational', 'actor'], purpose: ['informative'], level: ['session'], dimension: ['communication', 'actor', 'time'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, formatTime, ms, modelShort, showTip, hideTip } = ctx;
      const legend = el('div', { class: 'legend small seq-legend' });
      const chartHost = el('div', { class: 'seq-wrap' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(legend, chartHost, note);
      let view = null;
      let selection = null;
      let draws = 0;
      let scrolledTo = null; // the selected turn already brought into view
      let refocus = null; // the turn whose band had keyboard focus when it was picked

      const agentLabel = (id) => `subagent ${id.replace(/^agent-/, '').slice(0, 7)}`;
      const agentKey = (id) => (id ? `sub:${id}` : 'main');
      const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;

      function update(sessions, sel) {
        view = sessions[0] || null;
        selection = sel || null;
        draw();
      }

      /** The lifelines used by this session, as { key, label, colorGroup? }, with a lookup by key. */
      function lanesOf(v) {
        const lanes = [
          { key: 'you', label: 'You' },
          { key: 'main', label: 'Main agent' },
        ];
        const agents = new Set(v.subagents.map((s) => s.agentId));
        for (const c of v.calls) if (c.agentId) agents.add(c.agentId);
        for (const t of v.tools) if (t.agentId) agents.add(t.agentId);
        for (const id of agents) lanes.push({ key: agentKey(id), label: agentLabel(id), title: id });
        // Categories in the tree's color order, the neutral rest last.
        const cats = new Map();
        for (const t of v.tools) if (!cats.has(t.category)) cats.set(t.category, t.colorGroup);
        const rank = (g) => g || 99;
        for (const [label, colorGroup] of [...cats].sort((a, b) => rank(a[1]) - rank(b[1]))) lanes.push({ key: `cat:${label}`, label, colorGroup });
        return lanes;
      }

      /**
       * Every event as { type, tms, turnId, ... }, grouped by turn in prompt
       * order. Events whose turn has no prompt go in an Unlinked group first;
       * compactions and delegations with no turn go in the turn under way.
       */
      function groupsOf(v) {
        const groups = new Map();
        for (const p of v.prompts) {
          if (!groups.has(p.turnId)) groups.set(p.turnId, { turnId: p.turnId, index: p.index, firstMs: ms(p.ts), text: undefined, events: [] });
          const g = groups.get(p.turnId);
          g.firstMs = Math.min(g.firstMs, ms(p.ts));
          if (!g.text && p.text) g.text = p.text;
          g.events.push({ type: 'prompt', tms: ms(p.ts), ts: p.ts, text: p.text });
        }
        const ordered = [...groups.values()].sort((a, b) => a.index - b.index);
        const unlinked = { turnId: null, index: 0, firstMs: -Infinity, events: [] };
        const linked = (turnId) => (turnId && groups.get(turnId)) || unlinked;
        const underWay = (tms) => {
          let at = null;
          for (const g of ordered) if (g.firstMs <= tms) at = g;
          return at || ordered[0] || unlinked;
        };
        for (const c of v.calls) linked(c.turnId).events.push({ type: 'call', tms: ms(c.ts), ts: c.ts, agent: c.agentId, call: c });
        for (const t of v.tools) linked(t.turnId).events.push({ type: 'tool', tms: ms(t.ts), ts: t.ts, agent: t.agentId, tool: t });
        for (const c of v.compactions) underWay(ms(c.ts)).events.push({ type: 'compaction', tms: ms(c.ts), ts: c.ts, compaction: c });
        const started = new Set();
        const firsts = [...v.calls, ...v.tools].filter((e) => e.agentId).sort((a, b) => ms(a.ts) - ms(b.ts));
        for (const e of firsts) {
          if (started.has(e.agentId)) continue;
          started.add(e.agentId);
          linked(e.turnId).events.push({ type: 'delegate', tms: ms(e.ts), ts: e.ts, agent: e.agentId });
        }
        for (const s of v.subagents) {
          if (!started.has(s.agentId)) underWay(ms(s.firstTs)).events.push({ type: 'delegate', tms: ms(s.firstTs), ts: s.firstTs, agent: s.agentId });
        }
        const all = unlinked.events.length ? [unlinked, ...ordered] : ordered;
        for (const g of all) g.events.sort((a, b) => a.tms - b.tms || RANK[a.type] - RANK[b.type]);
        return all;
      }

      /**
       * Rows for one turn's events. Tool calls from one agent to one category
       * fold into one row, along with that agent's reply-less model calls in
       * between; other reply-less model calls fold into a self-mark.
       */
      function rowsOf(events) {
        const rows = [];
        let pending = []; // reply-less calls waiting to see whether the run goes on
        let seenPrompt = false;
        const flush = () => {
          for (const c of pending) {
            const last = rows[rows.length - 1];
            if (last && last.type === 'self' && last.agent === c.agent) {
              last.calls.push(c.call);
              last.lastTs = c.ts;
            } else rows.push({ type: 'self', agent: c.agent, ts: c.ts, lastTs: c.ts, calls: [c.call] });
          }
          pending = [];
        };
        for (const e of events) {
          if (e.type === 'call' && !e.call.reply) {
            pending.push(e);
            continue;
          }
          if (e.type === 'tool') {
            const last = rows[rows.length - 1];
            if (last && last.type === 'tool' && last.agent === e.agent && last.category === e.tool.category && pending.every((c) => c.agent === e.agent)) {
              last.names.add(e.tool.name || 'tool');
              last.count += 1;
              last.failed += e.tool.status === 'failure' ? 1 : 0;
              last.lastTs = e.ts;
              last.calls.push(...pending.map((c) => c.call));
              pending = [];
              continue;
            }
            flush();
            rows.push({ type: 'tool', agent: e.agent, category: e.tool.category, colorGroup: e.tool.colorGroup, names: new Set([e.tool.name || 'tool']), count: 1, failed: e.tool.status === 'failure' ? 1 : 0, ts: e.ts, lastTs: e.ts, calls: [] });
            continue;
          }
          flush();
          if (e.type === 'call') rows.push({ type: 'reply', agent: e.agent, ts: e.ts, call: e.call });
          else if (e.type === 'prompt') {
            rows.push({ type: 'prompt', ts: e.ts, text: e.text, first: !seenPrompt });
            seenPrompt = true;
          }
          else if (e.type === 'compaction') rows.push({ type: 'compaction', ts: e.ts, compaction: e.compaction });
          else rows.push({ type: 'delegate', agent: e.agent, ts: e.ts });
        }
        flush();
        return rows;
      }

      /** A lifeline's label on up to two lines, breaking at spaces, each fitted to the lane. */
      function twoLines(text, widthPx) {
        const words = text.split(' ');
        if (words.length === 1 || fit(text, widthPx) === text) return [fit(text, widthPx)];
        let first = words[0];
        let i = 1;
        while (i < words.length - 1 && fit(`${first} ${words[i]}`, widthPx) === `${first} ${words[i]}`) first += ` ${words[i++]}`;
        return [fit(first, widthPx), fit(words.slice(i).join(' '), widthPx)];
      }

      /** Scrolls the nearest scrolling ancestor, never the page, so this element shows under the sticky header. */
      function bringIntoView(node) {
        let box = host;
        while (box && box !== document.body && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
        if (!box || box === document.body || box.clientHeight === 0) return false;
        const at = node.getBoundingClientRect();
        const pane = box.getBoundingClientRect();
        if (at.top < pane.top + HEAD_H + 4 || at.bottom > pane.bottom - 8) box.scrollTop += at.top - pane.top - HEAD_H - 8;
        return true;
      }

      function draw() {
        draws++;
        hideTip();
        if (!view) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const v = view;
        if (!v.prompts.length && !v.calls.length && !v.tools.length && !v.compactions.length) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'No prompts, model calls, or tool calls in this session.' }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const sessionId = v.summary.sessionId;
        const selectedTurn = selection && selection.turnId && (!selection.sessionId || selection.sessionId === sessionId) ? selection.turnId : null;

        const lanes = lanesOf(v);
        const laneIndex = new Map(lanes.map((l, i) => [l.key, i]));
        const hostWidth = Math.max(320, host.clientWidth || 800);
        const laneW = Math.max(MIN_LANE, (hostWidth - SIDE * 2) / lanes.length);
        const width = Math.max(hostWidth, Math.ceil(laneW * lanes.length + SIDE * 2));
        const x = (key) => SIDE + laneW * (laneIndex.get(key) + 0.5);

        // The lifeline header, sticky inside the slide's scrolling pane.
        const head = svg('svg', { class: 'seq-head-svg', width, height: HEAD_H, viewBox: `0 0 ${width} ${HEAD_H}`, role: 'img', 'aria-label': `Lifelines: ${lanes.map((l) => l.label).join(', ')}` });
        for (const l of lanes) {
          const cx = x(l.key);
          const g = svg('g', {});
          const lines = twoLines(l.label, laneW - 2);
          lines.forEach((line, i) => {
            const label = svg('text', { class: 'seq-life-label', x: cx, y: (lines.length === 1 ? 23 : 16) + i * 14, 'text-anchor': 'middle' });
            label.textContent = line;
            g.append(label);
          });
          if (l.colorGroup !== undefined) {
            // A dot just before the first line ties the lifeline to its arrows' color.
            const halfWidth = lines[0].length * 3.3;
            g.append(svg('circle', { class: `seq-cat-${l.colorGroup}`, cx: Math.max(cx - laneW / 2 + 5, cx - halfWidth - 8), cy: lines.length === 1 ? 19 : 12, r: 4 }));
          }
          g.append(svg('rect', { class: 'hit', x: cx - laneW / 2, y: 0, width: laneW, height: HEAD_H }));
          g.addEventListener('mousemove', (e) => showTip(e, [l.title ? `${l.label} (${l.title})` : l.label]));
          g.addEventListener('mouseleave', hideTip);
          head.append(g);
        }

        const root = svg('svg', { class: 'seq-chart', width, role: 'group', 'aria-label': `Sequence diagram: ${v.prompts.length} prompts, ${v.tools.length} tool calls, ${v.calls.length} model calls` });
        const backLayer = svg('g', {});
        const lifeLayer = svg('g', {});
        const rowLayer = svg('g', {});
        root.append(backLayer, lifeLayer, rowLayer);

        const arrowhead = (cls, x2, y, dir, open) =>
          svg(open ? 'polyline' : 'path', open ? { class: `seq-tip-open ${cls}`, points: `${x2 - dir * 7},${y - 4} ${x2},${y} ${x2 - dir * 7},${y + 4}` } : { class: `seq-tip ${cls}`, d: `M${x2},${y} l${-dir * 8},-4 v8 z` });

        /** One arrow row: line, head, label above it, a hover target, and the tooltip. */
        function arrow(y, from, to, cls, label, tip, opts = {}) {
          const x1 = x(from);
          const x2 = x(to);
          const dir = x2 >= x1 ? 1 : -1;
          const ly = y + ARROW_H - 7;
          const g = svg('g', { class: 'seq-row' });
          g.append(svg('rect', { class: 'hit', x: Math.min(x1, x2) - 4, y, width: Math.abs(x2 - x1) + 8, height: ARROW_H }));
          g.append(svg('line', { class: `seq-line ${cls}`, x1, x2, y1: ly, y2: ly }));
          g.append(arrowhead(cls, x2, ly, dir, opts.open));
          if (opts.failed) {
            // Failures are marked by a cross on the line as well as by the label's ✕.
            const fx = x2 - dir * 16;
            g.append(svg('path', { class: 'seq-fail', d: `M${fx - 4},${ly - 4} l8,8 m0,-8 l-8,8` }));
          }
          const text = svg('text', { class: 'seq-label', x: (x1 + x2) / 2, y: ly - 5, 'text-anchor': 'middle' });
          text.textContent = fit(label, Math.max(MIN_LANE, Math.abs(x2 - x1) + (opts.wide ? 40 : 0)));
          g.append(text);
          g.addEventListener('mousemove', (e) => showTip(e, tip));
          g.addEventListener('mouseleave', hideTip);
          rowLayer.append(g);
          return ARROW_H;
        }

        const agentName = (id) => (id ? agentLabel(id) : 'Main agent');
        const usage = (calls) => calls.reduce((sum, c) => sum + callTokens(c), 0);

        function drawRow(r, y) {
          if (r.type === 'prompt') {
            const tip = [`Prompt · ${formatTime(r.ts)}`, r.text ? clip(r.text, 240) : 'Prompt text wasn’t captured.'];
            return arrow(y, 'you', 'main', 'seq-prompt', r.text && !r.first ? clip(r.text, 80) : 'prompt', tip); // the band above already carries a turn's first prompt
          }
          if (r.type === 'reply') {
            // A subagent answers the main agent; the main agent answers you.
            const to = r.agent ? 'main' : 'you';
            const c = r.call;
            const tip = [`Reply from ${agentName(r.agent)} · ${formatTime(r.ts)}`, clip(c.reply, 240), ...(c.model ? [['Model', modelShort(c.model)]] : []), ['Tokens', fmt(callTokens(c))]];
            return arrow(y, agentKey(r.agent), to, 'seq-reply', clip(c.reply, 80), tip, { open: true });
          }
          if (r.type === 'tool') {
            const names = [...r.names];
            const failMark = r.failed ? `✕${r.failed > 1 ? r.failed : ''} ` : '';
            const label = `${failMark}${names.join(', ')}${r.count > 1 ? ` ×${r.count}` : ''}`;
            const tip = [
              `${names.join(', ')} · ${formatTime(r.ts)}`,
              ['From', agentName(r.agent)],
              ['Category', r.category],
              ['Tool calls', fmt(r.count)],
              ...(r.failed ? [['Failed', fmt(r.failed)]] : []),
              ...(r.count > 1 ? [['Last', formatTime(r.lastTs)]] : []),
              ...(r.calls.length ? [['Model calls folded in', fmt(r.calls.length)], ['Their tokens', fmt(usage(r.calls))]] : []),
            ];
            return arrow(y, agentKey(r.agent), `cat:${r.category}`, `seq-cat-${r.colorGroup}`, label, tip, { failed: r.failed > 0 });
          }
          if (r.type === 'delegate') {
            const tip = [`Delegated to ${agentLabel(r.agent)} · ${formatTime(r.ts)}`, 'Inferred: the log has no link to the call that started it, so this is drawn at the subagent’s first event.'];
            return arrow(y, 'main', agentKey(r.agent), 'seq-delegate', 'delegated (inferred)', tip, { wide: true });
          }
          if (r.type === 'self') {
            const cx = x(agentKey(r.agent));
            const g = svg('g', { class: 'seq-row' });
            g.append(svg('rect', { class: 'hit', x: cx - laneW / 2, y, width: laneW, height: SELF_H }));
            g.append(svg('rect', { class: 'seq-self', x: cx - 4, y: y + 3, width: 8, height: SELF_H - 6, rx: 1 }));
            if (r.calls.length > 1) {
              const count = svg('text', { class: 'seq-label', x: cx + 8, y: y + SELF_H - 4 });
              count.textContent = `×${r.calls.length}`;
              g.append(count);
            }
            const models = [...new Set(r.calls.map((c) => c.model).filter(Boolean))];
            const tip = [`${r.calls.length === 1 ? 'Model call' : `${r.calls.length} model calls`} · ${formatTime(r.ts)}`, ['Agent', agentName(r.agent)], ...(models.length ? [['Model', models.map(modelShort).join(', ')]] : []), ['Tokens', fmt(usage(r.calls))]];
            g.addEventListener('mousemove', (e) => showTip(e, tip));
            g.addEventListener('mouseleave', hideTip);
            rowLayer.append(g);
            return SELF_H;
          }
          // A compaction: a note across every lifeline.
          const c = r.compaction;
          const sizes = c.preTokens && c.postTokens ? ` ${compact(c.preTokens)} → ${compact(c.postTokens)}` : '';
          const g = svg('g', { class: 'seq-row' });
          g.append(svg('rect', { class: 'seq-note', x: SIDE, y: y + 3, width: width - SIDE * 2, height: NOTE_H - 6, rx: 2 }));
          const text = svg('text', { class: 'seq-label seq-note-text', x: width / 2, y: y + 17, 'text-anchor': 'middle' });
          text.textContent = `⤓ context compacted${c.trigger === 'manual' ? ' (manual)' : ''}${sizes}`;
          g.append(text);
          g.addEventListener('mousemove', (e) => showTip(e, [`⤓ compacted${c.trigger === 'manual' ? ' (manual)' : ''} · ${formatTime(r.ts)}`, ...(c.preTokens ? [['Before', fmt(c.preTokens)]] : []), ...(c.postTokens ? [['After', fmt(c.postTokens)]] : [])]));
          g.addEventListener('mouseleave', hideTip);
          rowLayer.append(g);
          return NOTE_H;
        }

        function pick(turnId) {
          const before = draws;
          ctx.select({ sessionId, turnId });
          if (draws === before) {
            selection = { sessionId, turnId };
            draw();
          }
        }

        function drawBand(g, y) {
          const selected = g.turnId && g.turnId === selectedTurn;
          const band = svg('g', g.turnId ? { class: 'seq-band-hit', tabindex: 0, role: 'button', 'aria-pressed': String(!!selected), 'data-turn': g.turnId } : {});
          band.append(svg('rect', { class: g.turnId ? `seq-band turn-${g.index % 2}${selected ? ' seq-band-selected' : ''}` : 'seq-band seq-band-unlinked', x: 0, y, width, height: BAND_H - 2 }));
          const text = svg('text', { class: 'seq-band-text', x: SIDE, y: y + 15 });
          const started = Number.isFinite(g.firstMs) ? new Date(g.firstMs).toISOString() : null;
          const lead = g.turnId ? `P${g.index}${started ? ` · ${new Date(started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Unlinked: calls with no prompt';
          text.textContent = fit(g.text ? `${lead} · ${g.text.replace(/\s+/g, ' ')}` : lead, hostWidth - SIDE * 2);
          band.append(text);
          if (g.turnId) {
            band.addEventListener('click', () => pick(g.turnId));
            band.addEventListener('keydown', (e) => {
              if (e.key !== 'Enter') return;
              refocus = g.turnId;
              pick(g.turnId);
            });
            band.addEventListener('mousemove', (e) => showTip(e, [`P${g.index}${started ? ` · ${formatTime(started)}` : ''}`, g.text ? clip(g.text, 240) : 'Prompt text wasn’t captured.', 'Click to select this turn.']));
            band.addEventListener('mouseleave', hideTip);
          }
          rowLayer.append(band);
          return band;
        }

        // Rows, turn by turn, keeping every band so a turn can always be selected.
        let y = 0;
        let drawn = 0;
        let hiddenRows = 0;
        let hiddenTurns = 0;
        let folded = 0;
        const groups = groupsOf(v);
        const bands = new Map();
        for (const g of groups) {
          const top = y;
          bands.set(g.turnId, drawBand(g, y));
          y += BAND_H;
          const rows = rowsOf(g.events);
          for (const r of rows) if (r.type === 'tool') folded += r.count - 1;
          const selected = g.turnId && g.turnId === selectedTurn;
          const allowed = selected ? SELECTED_ROWS : Math.min(TURN_ROWS, Math.max(0, TOTAL_ROWS - drawn));
          for (const r of rows.slice(0, allowed)) y += drawRow(r, y);
          if (!selected) drawn += Math.min(rows.length, allowed);
          if (rows.length > allowed) {
            const left = rows.length - allowed;
            hiddenRows += left;
            hiddenTurns += 1;
            const more = svg('text', { class: 'seq-label seq-more', x: SIDE + 4, y: y + 14 });
            more.textContent = `… ${fmt(left)} more row${left === 1 ? '' : 's'} in this turn${selected || !g.turnId ? '' : '; select the turn to draw them'}`;
            rowLayer.append(more);
            y += MORE_H;
          }
          if (selected) backLayer.append(svg('rect', { class: 'seq-turn-selected', x: 0, y: top, width, height: y - top }));
        }

        const height = y + 4;
        for (const l of lanes) {
          const cx = x(l.key);
          lifeLayer.append(svg('line', { class: 'seq-life', x1: cx, x2: cx, y1: 0, y2: height }));
        }
        root.setAttribute('height', height);
        root.setAttribute('viewBox', `0 0 ${width} ${height}`);

        const headWrap = el('div', { class: 'seq-head' }, [head]);
        headWrap.style.width = `${width}px`;
        chartHost.replaceChildren(headWrap, root);

        const line = (cls, open) => {
          const s = svg('svg', { class: 'seq-key', width: 30, height: 10, viewBox: '0 0 30 10', 'aria-hidden': 'true' });
          s.append(svg('line', { class: `seq-line ${cls}`, x1: 1, x2: 29, y1: 5, y2: 5 }), arrowhead(cls, 29, 5, 1, open));
          return s;
        };
        const key = (mark, text) => el('span', { class: 'key' }, [mark, text]);
        const selfKey = svg('svg', { class: 'seq-key', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' });
        selfKey.append(svg('rect', { class: 'seq-self', x: 1, y: 0, width: 8, height: 10, rx: 1 }));
        const failKey = svg('svg', { class: 'seq-key', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' });
        failKey.append(svg('path', { class: 'seq-fail', d: 'M1,1 l8,8 m0,-8 l-8,8' }));
        legend.replaceChildren(
          key(line('seq-prompt'), 'prompt'),
          key(line('seq-reply', true), 'reply'),
          key(line('seq-cat-0'), 'tool call, in its category’s color'),
          key(failKey, 'failed'),
          key(line('seq-delegate'), 'delegation (inferred)'),
          key(selfKey, 'model call with no reply text')
        );

        const parts = ['Rows are in event order within each turn.'];
        if (folded) parts.push(`${fmt(folded)} repeated tool call${folded === 1 ? ' is' : 's are'} folded into ×N arrows.`);
        if (hiddenRows) parts.push(`${fmt(hiddenRows)} row${hiddenRows === 1 ? '' : 's'} in ${fmt(hiddenTurns)} turn${hiddenTurns === 1 ? '' : 's'} not drawn, to keep the view usable; select a turn to draw it.`);
        parts.push('Click a turn’s band to select it in every visualizer.');
        note.textContent = parts.join(' ');

        if (refocus) {
          const band = bands.get(refocus);
          refocus = null;
          if (band) band.focus({ preventScroll: true });
        }
        if (!selectedTurn) scrolledTo = null;
        else if (scrolledTo !== selectedTurn && bands.has(selectedTurn) && bringIntoView(bands.get(selectedTurn))) scrolledTo = selectedTurn;
      }

      return {
        update,
        resize: draw,
        destroy() {
          hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
