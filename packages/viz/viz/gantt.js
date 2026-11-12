// Gantt and waterfall: where one session's time went, with time across and
// work down. Gantt has a row each for you, the main agent, each subagent, and
// each tool category. Waterfall has a row per turn, and the selected turn opens
// below it as those same rows on the turn's own time axis, so a two-minute turn
// in a four-hour session can still be read. Model and tool calls are recorded
// as moments, not spans, so they're ticks, and ticks too close to tell apart
// fold into one that counts them. See docs/design/visualization-explorer.md
// for the contract. Clicking a turn's bar announces { sessionId, turnId }. The
// mode lives in the instance. Sees only its host and ctx: no VS Code.
(function () {
  const ROW = 24;
  const LABEL = 132;
  const AXIS = 22;
  const MIN_BAR = 3; // px; a turn with a single event still shows
  const FOLD = 3; // px; ticks closer than this fold into one

  window.factoryClock.register({
    id: 'gantt',
    title: 'Gantt and waterfall',
    tags: { category: ['temporal'], purpose: ['informative'], level: ['session'], dimension: ['time', 'actor', 'hierarchy'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, fit, ms, duration, showTip, hideTip } = ctx;
      let mode = 'gantt'; // 'gantt' | 'waterfall'
      let view = null;
      let selection = null;

      const ganttBtn = el('button', { text: 'Gantt', 'aria-pressed': 'true' });
      const waterfallBtn = el('button', { text: 'Waterfall', 'aria-pressed': 'false' });
      const setMode = (next) => {
        mode = next;
        ganttBtn.setAttribute('aria-pressed', String(mode === 'gantt'));
        waterfallBtn.setAttribute('aria-pressed', String(mode === 'waterfall'));
        draw();
      };
      ganttBtn.addEventListener('click', () => setMode('gantt'));
      waterfallBtn.addEventListener('click', () => setMode('waterfall'));
      const controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Arrange by' }, [el('span', { class: 'muted small', text: 'Arrange' }), ganttBtn, waterfallBtn]);
      const chartHost = el('div');
      const legend = el('div', { class: 'legend small gantt-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(controls, chartHost, legend, note);

      const selectedTurn = () => {
        const s = selection;
        return s && s.turnId && (!s.sessionId || s.sessionId === view.summary.sessionId) && view.prompts.some((p) => p.turnId === s.turnId) ? s.turnId : null;
      };
      const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;

      /** One entry per turn in prompt order: its span runs from its first prompt to its last recorded event. */
      function turnsOf(v) {
        const turns = new Map();
        for (const p of v.prompts) {
          const t = turns.get(p.turnId);
          if (t) {
            t.from = Math.min(t.from, ms(p.ts));
            t.to = Math.max(t.to, ms(p.ts));
            if (!t.text && p.text) t.text = p.text;
          } else {
            turns.set(p.turnId, { turnId: p.turnId, index: p.index, from: ms(p.ts), to: ms(p.ts), text: p.text, tokens: 0, calls: 0, tools: 0 });
          }
        }
        for (const c of v.calls) {
          const t = c.turnId && turns.get(c.turnId);
          if (!t) continue;
          t.to = Math.max(t.to, ms(c.ts));
          t.tokens += callTokens(c);
          t.calls++;
        }
        for (const x of v.tools) {
          const t = x.turnId && turns.get(x.turnId);
          if (!t) continue;
          t.to = Math.max(t.to, ms(x.ts));
          t.tools++;
        }
        return [...turns.values()].sort((a, b) => a.from - b.from);
      }

      /**
       * The rows of the Gantt, for the whole session or one turn: you, the main
       * agent, each subagent, then each tool category in the color groups' order.
       */
      function rowsOf(v, turns, turnId) {
        const inScope = (e) => !turnId || e.turnId === turnId;
        const calls = v.calls.filter(inScope);
        const tools = v.tools.filter(inScope);
        const shadeOf = new Map(turns.map((t, i) => [t.turnId, i % 2]));
        const rows = [];

        const prompts = v.prompts.filter(inScope);
        rows.push({ label: 'You', ticks: prompts.map((p) => ({ t: ms(p.ts), cls: 'gantt-tick-prompt', tip: [`P${p.index} prompt`, ...(p.text ? [clip(p.text, 240)] : [])] })), bars: [] });

        /** Bars for one agent: a span per turn it worked in, with its model calls as ticks. */
        const agentRow = (label, agentId) => {
          const mine = (e) => (e.agentId || null) === agentId;
          const myCalls = calls.filter(mine);
          const myTools = tools.filter(mine);
          const byTurn = new Map();
          for (const e of [...myCalls, ...myTools]) {
            const key = e.turnId || '';
            const span = byTurn.get(key) || { turnId: e.turnId, from: Infinity, to: -Infinity, calls: 0, tools: 0, tokens: 0 };
            span.from = Math.min(span.from, ms(e.ts));
            span.to = Math.max(span.to, ms(e.ts));
            byTurn.set(key, span);
          }
          for (const c of myCalls) {
            const span = byTurn.get(c.turnId || '');
            span.calls++;
            span.tokens += callTokens(c);
          }
          for (const x of myTools) byTurn.get(x.turnId || '').tools++;
          // The main agent's bar starts at the prompt: what it's working on began there.
          if (!agentId) for (const t of turns) if (byTurn.has(t.turnId)) byTurn.get(t.turnId).from = t.from;
          const bars = [...byTurn.values()].map((span) => {
            const t = turns.find((x) => x.turnId === span.turnId);
            return {
              from: span.from,
              to: span.to,
              turnId: span.turnId,
              cls: span.turnId ? `turn-${shadeOf.get(span.turnId)}` : 'gantt-unlinked',
              tip: [
                `${label}${t ? ` · P${t.index}` : ' · unlinked'}`,
                ...(t && t.text && !agentId ? [clip(t.text, 200)] : []),
                ['Span', duration(new Date(span.from).toISOString(), new Date(span.to).toISOString())],
                ['Model calls', fmt(span.calls)],
                ['Tool calls', fmt(span.tools)],
                ['Tokens', fmt(span.tokens)],
              ],
            };
          });
          const ticks = myCalls.map((c) => ({ t: ms(c.ts), cls: 'gantt-tick-call', tip: ['Model call', ...(c.model ? [c.model] : []), ['Tokens', fmt(callTokens(c))]] }));
          return { label, bars, ticks };
        };
        rows.push(agentRow('Main agent', null));
        const agents = [...new Set([...calls, ...tools].map((e) => e.agentId).filter(Boolean))];
        const firstOf = (id) => Math.min(...[...calls, ...tools].filter((e) => e.agentId === id).map((e) => ms(e.ts)));
        agents.sort((a, b) => firstOf(a) - firstOf(b));
        for (const id of agents) rows.push(agentRow(`subagent ${id.replace(/^agent-/, '').slice(0, 7)}`, id));

        // Fixed color-group order, neutral last; the names as the tree shows them.
        const cats = new Map();
        for (const x of tools) {
          const c = cats.get(x.category) || { label: x.category, group: x.colorGroup, ticks: [] };
          c.ticks.push({ t: ms(x.ts), cls: `gantt-cat-${x.colorGroup}`, fail: x.status === 'failure', tip: [`${x.name || x.category}`, x.category, ...(x.status === 'failure' ? ['Failed'] : [])] });
          cats.set(x.category, c);
        }
        const rank = (g) => g || 99;
        for (const c of [...cats.values()].sort((a, b) => rank(a.group) - rank(b.group) || a.label.localeCompare(b.label))) rows.push({ label: c.label, bars: [], ticks: c.ticks });
        return rows;
      }

      /** Ticks falling within FOLD px of each other, as one tick with a count. */
      function foldTicks(ticks, x) {
        const groups = new Map();
        for (const k of [...ticks].sort((a, b) => a.t - b.t)) {
          const key = `${k.cls}|${Math.round(x(k.t) / FOLD)}`;
          const g = groups.get(key);
          if (g) {
            g.n++;
            g.fail = g.fail || k.fail;
          } else {
            groups.set(key, { ...k, n: 1 });
          }
        }
        return [...groups.values()];
      }

      /** Clock ticks every "nice" step across the domain: minutes, hours, or days. */
      function clockTicks(from, to, width) {
        const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);
        const want = Math.max(2, Math.floor(width / 90));
        const step = steps.find((s) => (to - from) / s <= want) || steps[steps.length - 1];
        const out = [];
        // Offset by the time zone, so an hour tick lands on the local hour.
        const tz = new Date(from).getTimezoneOffset() * 60000;
        for (let t = Math.ceil((from - tz) / step) * step + tz; t <= to; t += step) out.push(t);
        return { ticks: out, step };
      }
      function clockLabel(t, step) {
        const d = new Date(t);
        if (step >= 86400000) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(step < 60000 ? { second: '2-digit' } : {}) });
      }

      /** One chart: rows over a time domain, with compactions as lines through them. */
      function chart(rows, from, to, width, ariaLabel, compactions) {
        const span = Math.max(1000, to - from);
        const pad = Math.max(span * 0.01, 500);
        const d0 = from - pad;
        const d1 = to + pad;
        const pw = width - LABEL - 12;
        const x = (t) => LABEL + ((t - d0) / (d1 - d0)) * pw;
        const height = AXIS + rows.length * ROW + 4;
        const root = svg('svg', { class: 'viz-chart gantt-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel });

        const { ticks, step } = clockTicks(d0, d1, pw);
        for (const t of ticks) {
          root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: AXIS - 4, y2: height - 4 }));
          const lab = svg('text', { class: 'axis-label', x: x(t), y: AXIS - 8, 'text-anchor': 'middle' });
          lab.textContent = clockLabel(t, step);
          root.append(lab);
        }

        const current = selectedTurn();
        rows.forEach((row, i) => {
          const y = AXIS + i * ROW;
          const lab = svg('text', { class: 'row-label', x: 0, y: y + ROW / 2 + 4 });
          lab.textContent = fit(row.label, LABEL - 2);
          const labTitle = svg('title', {});
          labTitle.textContent = row.label;
          lab.append(labTitle);
          root.append(lab);
          if (i > 0) root.append(svg('line', { class: 'gantt-rule', x1: 0, x2: width - 12, y1: y, y2: y }));

          for (const bar of row.bars) {
            const bx = x(bar.from);
            const bw = Math.max(MIN_BAR, x(bar.to) - bx);
            const clickable = !!bar.turnId;
            const on = clickable && bar.turnId === current;
            const g = svg('g', { class: `gantt-bar${clickable ? ' clickable' : ''}`, ...(clickable ? { tabindex: 0, role: 'button', 'aria-label': `${bar.tip[0]}; select this turn` } : {}) });
            g.append(svg('rect', { class: `gantt-span ${bar.cls}${on ? ' gantt-selected' : ''}`, x: bx, y: y + 4, width: bw, height: ROW - 8, rx: 2 }));
            g.addEventListener('mousemove', (e) => showTip(e, bar.tip));
            g.addEventListener('mouseleave', hideTip);
            if (clickable) {
              const pick = () => ctx.select({ sessionId: view.summary.sessionId, turnId: bar.turnId });
              g.addEventListener('click', pick);
              g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
            }
            root.append(g);
          }
          for (const k of foldTicks(row.ticks, x)) {
            const t = svg('rect', { class: `gantt-tick ${k.cls}${k.fail ? ' gantt-fail' : ''}`, x: x(k.t) - 1, y: y + (row.bars.length ? 7 : 5), width: 2, height: row.bars.length ? ROW - 14 : ROW - 10 });
            const hit = svg('rect', { class: 'hit', x: x(k.t) - 2, y: y + 2, width: 4, height: ROW - 4 });
            const tip = [...k.tip];
            if (k.n > 1) tip[0] = `${tip[0]} and ${k.n - 1} more nearby`;
            hit.addEventListener('mousemove', (e) => showTip(e, tip));
            hit.addEventListener('mouseleave', hideTip);
            // A tick on a bar passes clicks through to the bar under it.
            if (row.bars.length) hit.setAttribute('pointer-events', 'none');
            root.append(t, hit);
          }
        });

        for (const c of compactions) {
          const t = ms(c.ts);
          if (t < d0 || t > d1) continue;
          const line = svg('line', { class: 'gantt-compaction', x1: x(t), x2: x(t), y1: AXIS - 2, y2: height - 4 });
          const hit = svg('rect', { class: 'hit', x: x(t) - 3, y: AXIS - 2, width: 6, height: height - AXIS - 2 });
          hit.addEventListener('mousemove', (e) => showTip(e, [`Compaction (${c.trigger})`, ...(c.preTokens ? [['Before', compact(c.preTokens)]] : []), ...(c.postTokens ? [['After', compact(c.postTokens)]] : [])]));
          hit.addEventListener('mouseleave', hideTip);
          root.append(line, hit);
        }
        return root;
      }

      function draw() {
        if (!view) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const v = view;
        const stamps = [...v.prompts, ...v.calls, ...v.tools, ...v.compactions].map((e) => ms(e.ts));
        if (!stamps.length) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'Nothing with a time in this session.' }));
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const from = Math.min(...stamps);
        const to = Math.max(...stamps);
        const turns = turnsOf(v);
        const parts = [];
        const current = selectedTurn();
        if (mode === 'gantt') {
          const rows = rowsOf(v, turns, null);
          parts.push(chart(rows, from, to, width, `Gantt chart: ${rows.length} rows over the session's clock time`, v.compactions));
        } else {
          const rows = turns.map((t, i) => {
            const on = t.turnId === current;
            return {
              label: `${on ? '▾ ' : ''}P${t.index}${t.text ? ` ${t.text}` : ''}`,
              ticks: [],
              bars: [
                {
                  from: t.from,
                  to: t.to,
                  turnId: t.turnId,
                  cls: `turn-${i % 2}`,
                  tip: [`P${t.index}`, ...(t.text ? [clip(t.text, 240)] : []), ['Span', duration(new Date(t.from).toISOString(), new Date(t.to).toISOString())], ['Model calls', fmt(t.calls)], ['Tool calls', fmt(t.tools)], ['Tokens', fmt(t.tokens)]],
                },
              ],
            };
          });
          const unlinked = v.calls.filter((c) => !c.turnId);
          if (unlinked.length) {
            rows.push({
              label: 'Unlinked calls',
              bars: [],
              ticks: unlinked.map((c) => ({ t: ms(c.ts), cls: 'gantt-tick-call', tip: ['Model call no prompt claims', ['Tokens', fmt(callTokens(c))]] })),
            });
          }
          if (rows.length) parts.push(chart(rows, from, to, width, `Waterfall: one row per turn, ${turns.length} turns`, v.compactions));
          if (current) {
            const t = turns.find((x) => x.turnId === current);
            const detail = rowsOf(v, turns, current);
            parts.push(
              el('p', { class: 'gantt-detail-head small' }, [el('strong', { text: `P${t.index}` }), el('span', { class: 'muted', text: ` on its own time axis, ${duration(new Date(t.from).toISOString(), new Date(t.to).toISOString())}` })]),
              chart(detail, t.from, t.to, width, `Turn P${t.index}: ${detail.length} rows over the turn's clock time`, v.compactions)
            );
          }
        }
        chartHost.replaceChildren(...parts);

        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        const shown = current || mode === 'gantt' ? v.tools : [];
        const groups = [...new Set(shown.map((x) => x.colorGroup))].sort((a, b) => (a || 99) - (b || 99));
        const groupLabel = (g) => (g ? v.categoryGroups[g - 1] : 'Other tools');
        legend.replaceChildren(
          key('swatch-turn-0', 'turn'),
          key('swatch-turn-1', 'next turn'),
          ...(mode === 'gantt' || current ? [key('swatch-gantt-call', 'model call')] : []),
          ...(mode === 'gantt' || current ? [key('swatch-gantt-prompt', 'prompt')] : []),
          ...groups.map((g) => key(`cat-${g}`, groupLabel(g))),
          ...(shown.some((x) => x.status === 'failure') ? [key('swatch-gantt-fail', 'failed tool call')] : []),
          ...(v.compactions.length ? [key('swatch-compaction', 'compaction')] : [])
        );
        const idle = 'Model and tool calls are recorded as moments, so they’re ticks; a bar runs from a turn’s first event to its last, and gaps between bars are idle time. Time waiting on a tool isn’t told apart from time working, and token size isn’t time.';
        note.textContent = mode === 'gantt' ? `${idle} Click a bar to select its turn.` : `${idle} ${current ? 'Click another turn to open it.' : 'Click a turn to open it on its own time axis.'}`;
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
