// Session Fingerprint (hero view, design language `risograph`): each loaded
// session compressed to a signature (a trunk of turns, branches for
// subagents, loops for inferred retries, dotted spans for quiet gaps), with up
// to three printed on top of each other as spot-color passes on uncoated
// stock, so where runs agree the inks overprint and where they diverge one
// color stands alone. Every loaded run also gets a small signature in the
// library row, where clicking one lifts it onto the plate or off it. See
// docs/design/visualization-explorer.md, "Session Fingerprint".
//
// Honest about what it has: a turn is a node at its prompt, sized by its
// tokens; a branch is a subagent's span from its first event to its last; a
// loop is a failed tool call followed by the same tool in the same turn, which
// is a guess, so it's dashed; and a dotted span is a quiet gap, not proof that
// anyone was waiting (that needs phase 8). The time mode is always labeled.
// A session- and project-level visualizer: draws every session it's given.
// Clicking a turn announces { sessionId, turnId }. Sees only its host and
// ctx: no VS Code.
(function () {
  const MAX_PASSES = 3; // runs overprinted at once; the rest wait in the library row
  const PASSES = ['blue', 'pink', 'yellow'];
  const QUIET_MS = 10 * 60 * 1000; // a gap longer than this is a quiet gap
  const QUIET_DRAWN_MS = 2 * 60 * 1000; // ...and in active time it's drawn this long
  const LANE = 26; // px between a branch lane and the next
  const MAX_LANES = 6; // branch lanes before branches share the outermost
  const PAD_X = 28;
  const TRUNK_STEP = 6; // px between passes' trunks
  const LIB_W = 150; // a library signature
  const LIB_H = 46;
  const MODES = [
    ['active', 'Active time'],
    ['elapsed', 'Elapsed'],
    ['absolute', 'Absolute'],
    ['normalized', 'Normalized'],
  ];
  const MODE_NOTE = {
    active: 'start-aligned, quiet gaps over 10 minutes shortened to 2',
    elapsed: 'start-aligned, clock time',
    absolute: 'clock time: runs overlap only if they ran at the same time',
    normalized: 'each run stretched to the same width, so structure lines up rather than time',
  };
  let charts = 0;

  window.snagboatViz.register({
    id: 'session-fingerprint',
    title: 'Session Fingerprint',
    tags: { category: ['dependency', 'temporal'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['time', 'hierarchy', 'dependency', 'quantity'], language: ['risograph'] },
    mount(host, ctx) {
      const { el, svg, svgText, compact, fmt, clip, short, secondsText, formatTime, showTip, hideTip, hashId, callTokens, replayEvents, modeButtons } = ctx;
      const prefix = `sf${++charts}`;
      let mode = 'active';
      let views = [];
      let selection = null;
      let onPlate = []; // session ids overprinted, in pass order
      const lifted = new Set(); // on the plate but hidden for a moment
      const frame = el('div', { class: 'hero-riso' });
      const controls = modeButtons('Time', MODES, mode, (m) => {
        mode = m;
        draw();
      });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);

      function update(sessions, sel) {
        views = sessions;
        selection = sel || null;
        const ids = new Set(views.map((v) => v.summary.sessionId));
        onPlate = onPlate.filter((id) => ids.has(id));
        for (const v of views) if (onPlate.length < MAX_PASSES && !onPlate.includes(v.summary.sessionId)) onPlate.push(v.summary.sessionId);
        draw();
      }

      // ---------- one run's structure ----------
      const cache = new Map(); // session id -> { view, run }
      function runOf(v) {
        const hit = cache.get(v.summary.sessionId);
        if (hit && hit.view === v) return hit.run;
        const run = buildRun(v);
        cache.set(v.summary.sessionId, { view: v, run });
        return run;
      }

      function buildRun(v) {
        const events = replayEvents([v]);
        const times = events.map((e) => e.t);
        const start = times.length ? times[0] : Date.parse(v.summary.firstTs);
        const end = times.length ? times[times.length - 1] : Date.parse(v.summary.lastTs);
        // Active time: breakpoints where a quiet gap is shortened.
        const breaks = [{ t: start, a: 0 }];
        const gaps = [];
        for (let i = 1; i < times.length; i++) {
          const g = times[i] - times[i - 1];
          if (g > QUIET_MS) {
            const prev = breaks[breaks.length - 1];
            const a0 = prev.a + (times[i - 1] - prev.t);
            breaks.push({ t: times[i - 1], a: a0 }, { t: times[i], a: a0 + QUIET_DRAWN_MS });
            gaps.push({ from: times[i - 1], to: times[i] });
          }
        }
        const last = breaks[breaks.length - 1];
        const activeEnd = last.a + (end - last.t);
        const active = (t) => {
          let lo = 0;
          let hi = breaks.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (breaks[mid].t <= t) lo = mid;
            else hi = mid - 1;
          }
          const b = breaks[lo];
          const next = breaks[lo + 1];
          // Inside a shortened gap, scale; elsewhere, one to one.
          if (next && next.a - b.a !== next.t - b.t) return b.a + ((t - b.t) / (next.t - b.t)) * (next.a - b.a);
          return b.a + (t - b.t);
        };

        // Turns: a node at the prompt, sized by every token spent in the turn.
        const turns = new Map();
        for (const p of v.prompts) turns.set(p.turnId, { turnId: p.turnId, index: p.index, t: Date.parse(p.ts), text: p.text, tokens: 0, calls: 0, tools: 0, failed: 0 });
        for (const c of v.calls) {
          const tr = c.turnId && turns.get(c.turnId);
          if (tr) {
            tr.tokens += callTokens(c);
            tr.calls += 1;
          }
        }
        // Retries, inferred: a failed tool call, then the same tool again in the same turn by the same agent.
        const loops = [];
        const lastFail = new Map();
        for (const x of [...v.tools].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
          const tr = x.turnId && turns.get(x.turnId);
          if (tr) {
            tr.tools += 1;
            if (x.status === 'failure') tr.failed += 1;
          }
          const key = `${x.turnId || ''}|${x.agentId || ''}|${x.name || x.category}`;
          const failed = lastFail.get(key);
          if (failed !== undefined) {
            const prior = loops.find((l) => l.key === key && l.open);
            if (prior) prior.count += 1;
            else loops.push({ key, t: failed, count: 1, turnId: x.turnId, tool: x.name || x.category, agentId: x.agentId, open: true });
            lastFail.delete(key);
          }
          if (x.status === 'failure') lastFail.set(key, Date.parse(x.ts));
          else for (const l of loops) if (l.key === key) l.open = false;
        }
        // Branches: each subagent's span, given a lane so overlapping ones run side by side.
        const subTokens = new Map();
        for (const c of v.calls) if (c.agentId) subTokens.set(c.agentId, (subTokens.get(c.agentId) || 0) + callTokens(c));
        const branches = [...v.subagents]
          .map((s) => ({ agentId: s.agentId, from: Date.parse(s.firstTs), to: Date.parse(s.lastTs), calls: s.calls, tokens: subTokens.get(s.agentId) || 0, turnId: (v.calls.find((c) => c.agentId === s.agentId && c.turnId) || {}).turnId }))
          .sort((a, b) => a.from - b.from || a.agentId.localeCompare(b.agentId));
        const laneEnds = [];
        for (const b of branches) {
          let lane = laneEnds.findIndex((e) => e < b.from);
          if (lane < 0) lane = laneEnds.length < MAX_LANES ? laneEnds.length : MAX_LANES - 1;
          laneEnds[lane] = Math.max(laneEnds[lane] || 0, b.to);
          b.lane = lane;
        }
        return {
          sessionId: v.summary.sessionId,
          name: v.summary.name,
          start,
          end,
          activeEnd,
          active,
          gaps,
          turns: [...turns.values()].sort((a, b) => a.t - b.t),
          loops,
          branches,
          compactions: v.compactions.map((c) => ({ t: Date.parse(c.ts), trigger: c.trigger })),
          tokens: v.summary.tokens,
          failed: v.tools.filter((x) => x.status === 'failure').length,
        };
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!views.length) {
          frame.replaceChildren(el('p', { class: 'muted', text: 'No sessions.' }));
          note.textContent = '';
          return;
        }
        const runs = views.map(runOf);
        const plate = onPlate.map((id) => runs.find((r) => r.sessionId === id)).filter(Boolean);
        const width = Math.max(320, host.clientWidth || 800);
        const lanesUsed = Math.max(1, ...plate.map((r) => Math.max(0, ...r.branches.map((b) => b.lane + 1))));
        const half = Math.max(70, Math.ceil(lanesUsed / 2) * LANE + 36);
        const plateH = half * 2 + 40;
        const axisY = plateH + 4;
        const height = axisY + 34;
        const trunkY = half + 20;
        const maxTokens = Math.max(1, ...plate.flatMap((r) => r.turns.map((t) => t.tokens)));
        const nodeR = (tokens) => 2.5 + 9 * Math.sqrt(tokens / maxTokens);

        // x for a time in a run, by mode; spans are shared across the plate so runs compare.
        const minStart = Math.min(...plate.map((r) => r.start));
        const maxEnd = Math.max(...plate.map((r) => r.end));
        const span = {
          active: Math.max(1, ...plate.map((r) => r.activeEnd)),
          elapsed: Math.max(1, ...plate.map((r) => r.end - r.start)),
          absolute: Math.max(1, maxEnd - minStart),
          normalized: 1,
        }[mode];
        const inner = width - PAD_X * 2;
        const xOf = (r, t) => {
          const v = mode === 'active' ? r.active(t) : mode === 'elapsed' ? t - r.start : mode === 'absolute' ? t - minStart : r.active(t) / Math.max(1, r.activeEnd);
          return PAD_X + (v / span) * inner;
        };

        const root = svg('svg', { class: 'sf-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Session fingerprints of ${plate.length} run${plate.length === 1 ? '' : 's'}, ${MODES.find((m) => m[0] === mode)[1].toLowerCase()}` });
        const defs = svg('defs');
        for (const pass of PASSES) {
          const pat = svg('pattern', { id: `${prefix}-tone-${pass}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
          pat.append(svg('circle', { cx: 2, cy: 2, r: 1.25, class: `sf-ink-${pass}` }));
          defs.append(pat);
        }
        const grain = svg('filter', { id: `${prefix}-grain`, x: 0, y: 0, width: '100%', height: '100%' });
        grain.append(svg('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.75, numOctaves: 2, seed: 7 }), svg('feColorMatrix', { type: 'saturate', values: 0 }));
        defs.append(grain);
        root.append(defs, svg('rect', { class: 'sf-stock', x: 0, y: 0, width, height }));

        // Each pass in its own group, blended by multiply, nudged off register by a hash of the run.
        plate.forEach((r, i) => {
          const pass = PASSES[i];
          const h = hashId(r.sessionId);
          const g = svg('g', { class: `sf-pass sf-pass-${pass}${lifted.has(r.sessionId) ? ' sf-lifted' : ''}`, transform: `translate(${((h & 3) - 1.5) * 0.6} ${(((h >> 2) & 3) - 1.5) * 0.6})` });
          // Each pass's trunk sits a few px off the others', as the plates do, so agreement overprints along the edges rather than piling into black.
          drawRun(g, r, pass, { xOf, trunkY: trunkY + (i - (plate.length - 1) / 2) * TRUNK_STEP, nodeR });
          root.append(g);
        });
        root.append(svg('rect', { class: 'sf-grain', x: 0, y: 0, width, height, filter: `url(#${prefix}-grain)` }));

        // The time axis, labeled with its mode.
        const axis = svg('g', { class: 'sf-axis' });
        axis.append(svg('line', { x1: PAD_X, x2: width - PAD_X, y1: axisY, y2: axisY }));
        for (let k = 0; k <= 4; k++) {
          const x = PAD_X + (inner * k) / 4;
          axis.append(svg('line', { x1: x, x2: x, y1: axisY - 4, y2: axisY + 4 }));
          const label = k === 0 ? 'Start' : mode === 'normalized' ? `${k * 25}%` : mode === 'absolute' ? formatTime(minStart + (span * k) / 4) : `+${secondsText((span * k) / 4 / 1000)}`;
          axis.append(svgText({ x, y: axisY + 18, 'text-anchor': k === 0 ? 'start' : k === 4 ? 'end' : 'middle', class: 'sf-mono' }, k === 4 && mode !== 'absolute' ? `${label} · end` : label));
        }
        root.append(axis);

        // The legend: one key per pass, a button that lifts it off the plate.
        const legend = el(
          'div',
          { class: 'sf-legend', role: 'group', 'aria-label': 'Runs on the plate' },
          plate.map((r, i) => {
            const b = el('button', { class: `sf-key sf-key-${PASSES[i]}`, 'aria-pressed': String(!lifted.has(r.sessionId)), title: 'Lift this pass off the plate, or put it back' }, [
              el('span', { class: 'sf-swatch' }),
              el('span', { text: `run ${short(r.sessionId)} · ${secondsText((r.end - r.start) / 1000)} · ${compact(r.tokens)} tok · ${r.branches.length} branch${r.branches.length === 1 ? '' : 'es'} · ${r.loops.length} retr${r.loops.length === 1 ? 'y' : 'ies'}` }),
            ]);
            b.addEventListener('click', () => {
              if (lifted.has(r.sessionId)) lifted.delete(r.sessionId);
              else lifted.add(r.sessionId);
              draw();
            });
            return b;
          })
        );

        const head = el('div', { class: 'sf-head' }, [el('span', { class: 'sf-mono', text: 'Plate — session fingerprint / turn graph' }), el('span', { class: 'sf-mono', text: MODES.find((m) => m[0] === mode)[1] })]);
        frame.replaceChildren(head, el('div', { class: 'sf-controls' }, [controls]), legend, root, library(runs));
        note.textContent = [
          `Time: ${MODE_NOTE[mode]}.`,
          'A circle is a turn at its prompt, sized by its tokens; the square is the start and the diamond the end; a triangle is a compaction.',
          'A branch is a subagent’s span, first event to last. A dashed loop is a failed tool call followed by the same tool in the same turn: a retry, inferred.',
          'Dotted trunk is a quiet gap over 10 minutes: nothing recorded, which may be waiting on you or not.',
          'Where passes agree the inks overprint. Sessions carry no task or outcome, so compare runs you know are comparable.',
          'Click a turn to select it; click a run in the library to put it on the plate or take it off.',
        ].join(' ');
      }

      function drawRun(g, r, pass, { xOf, trunkY, nodeR }) {
        const sel = selection && selection.turnId && (!selection.sessionId || selection.sessionId === r.sessionId) ? selection.turnId : null;
        const x0 = xOf(r, r.start);
        const x1 = xOf(r, r.end);
        // The trunk: solid where work was recorded, dotted across quiet gaps.
        let from = r.start;
        for (const gap of r.gaps) {
          g.append(svg('line', { class: 'sf-trunk', x1: xOf(r, from), x2: xOf(r, gap.from), y1: trunkY, y2: trunkY }));
          const q = svg('line', { class: 'sf-quiet', x1: xOf(r, gap.from), x2: xOf(r, gap.to), y1: trunkY, y2: trunkY });
          ctx.interact(ctx, q, { tip: () => ['Quiet gap: nothing recorded', ['From', formatTime(gap.from)], ['For', secondsText((gap.to - gap.from) / 1000)]] });
          g.append(q);
          from = gap.to;
        }
        g.append(svg('line', { class: 'sf-trunk', x1: xOf(r, from), x2: x1, y1: trunkY, y2: trunkY }));

        // Branches: out of the trunk, along a lane, back in.
        for (const b of r.branches) {
          const k = Math.floor(b.lane / 2) + 1;
          const y = trunkY + (b.lane % 2 === 0 ? -1 : 1) * k * LANE;
          const bx0 = xOf(r, b.from);
          const bx1 = Math.max(bx0 + 24, xOf(r, b.to));
          const bend = Math.min(18, (bx1 - bx0) / 3);
          const path = svg('path', { class: 'sf-branch', d: `M${bx0 - bend} ${trunkY} C${bx0} ${trunkY} ${bx0 - bend / 2} ${y} ${bx0 + bend / 2} ${y} L${bx1 - bend / 2} ${y} C${bx1 + bend / 2} ${y} ${bx1} ${trunkY} ${bx1 + bend} ${trunkY}` });
          g.append(path);
          const mid = svg('circle', { class: `sf-node sf-tone`, cx: (bx0 + bx1) / 2, cy: y, r: Math.max(3, nodeR(b.tokens) * 0.8), fill: `url(#${prefix}-tone-${pass})` });
          ctx.interact(ctx, mid, {
            label: `Subagent ${b.agentId.slice(0, 12)}`,
            tip: () => [`Subagent ${b.agentId.replace(/^agent-/, '').slice(0, 8)} (run ${short(r.sessionId)})`, ['From', formatTime(b.from)], ['For', secondsText((b.to - b.from) / 1000)], ['Model calls', fmt(b.calls)], ['Tokens', fmt(b.tokens)]],
            pick: b.turnId ? () => ctx.select({ sessionId: r.sessionId, turnId: b.turnId }) : null,
          });
          g.append(mid);
        }

        // Retry loops, dashed because they're inferred.
        for (const l of r.loops) {
          const lr = 6 + 2 * Math.min(4, l.count);
          const c = svg('circle', { class: 'sf-loop', cx: xOf(r, l.t), cy: trunkY - lr, r: lr });
          ctx.interact(ctx, c, { tip: () => [`Retry, inferred (run ${short(r.sessionId)})`, ['Tool', l.tool], ['Retries', fmt(l.count)], ['At', formatTime(l.t)]], pick: l.turnId ? () => ctx.select({ sessionId: r.sessionId, turnId: l.turnId }) : null });
          g.append(c);
        }

        // Compactions as triangles on the trunk.
        for (const c of r.compactions) {
          const x = xOf(r, c.t);
          const tri = svg('path', { class: 'sf-mark', d: `M${x} ${trunkY - 7} L${x + 6} ${trunkY + 4} L${x - 6} ${trunkY + 4} Z` });
          ctx.interact(ctx, tri, { tip: () => [`Compaction (${c.trigger})`, ['At', formatTime(c.t)]] });
          g.append(tri);
        }

        // Turns: circles at their prompts, the big ones in halftone.
        for (const t of r.turns) {
          const rad = nodeR(t.tokens);
          const x = xOf(r, t.t);
          const node = svg('circle', { class: `sf-node${rad > 6 ? ' sf-tone' : ''}${sel === t.turnId ? ' sf-selected' : ''}`, cx: x, cy: trunkY, r: rad });
          if (rad > 6) node.setAttribute('fill', `url(#${prefix}-tone-${pass})`);
          ctx.interact(ctx, node, {
            label: `Turn P${t.index} of run ${short(r.sessionId)}`,
            tip: () => [`P${t.index} · run ${short(r.sessionId)}`, ...(t.text ? [clip(t.text.replace(/\s+/g, ' '), 90)] : []), ['At', formatTime(t.t)], ['Tokens', fmt(t.tokens)], ['Model calls', fmt(t.calls)], ['Tool calls', fmt(t.tools)], ...(t.failed ? [['Failed', fmt(t.failed)]] : [])],
            pick: () => ctx.select({ sessionId: r.sessionId, turnId: t.turnId }),
          });
          g.append(node);
          if (sel === t.turnId) g.append(svg('circle', { class: 'sf-ring', cx: x, cy: trunkY, r: rad + 5 }));
        }

        // Start square, end diamond.
        g.append(svg('rect', { class: 'sf-mark', x: x0 - 6, y: trunkY - 6, width: 12, height: 12 }));
        g.append(svg('path', { class: 'sf-mark', d: `M${x1} ${trunkY - 8} L${x1 + 8} ${trunkY} L${x1} ${trunkY + 8} L${x1 - 8} ${trunkY} Z` }));
      }

      /** The library row: every loaded run, normalized, small; a click puts it on the plate or takes it off. */
      function library(runs) {
        const items = runs.map((r) => {
          const slot = onPlate.indexOf(r.sessionId);
          const pass = slot >= 0 ? PASSES[slot] : null;
          const s = svg('svg', { class: 'sf-lib-svg', width: LIB_W, height: LIB_H, viewBox: `0 0 ${LIB_W} ${LIB_H}`, 'aria-hidden': 'true' });
          const g = svg('g', { class: pass ? `sf-pass sf-pass-${pass}` : 'sf-pass sf-pass-none' });
          const y = LIB_H / 2;
          const xOf = (t) => 6 + (r.active(t) / Math.max(1, r.activeEnd)) * (LIB_W - 12);
          g.append(svg('line', { class: 'sf-trunk sf-thin', x1: 6, x2: LIB_W - 6, y1: y, y2: y }));
          for (const b of r.branches) {
            const k = Math.floor(b.lane / 2) + 1;
            const by = y + (b.lane % 2 === 0 ? -1 : 1) * Math.min(3, k) * 6;
            const bx0 = xOf(b.from);
            const bx1 = Math.max(bx0 + 8, xOf(b.to));
            g.append(svg('path', { class: 'sf-branch sf-thin', d: `M${bx0 - 4} ${y} L${bx0} ${by} L${bx1} ${by} L${bx1 + 4} ${y}` }));
          }
          for (const l of r.loops) g.append(svg('circle', { class: 'sf-loop sf-thin', cx: xOf(l.t), cy: y - 5, r: 4 }));
          s.append(g);
          const label = `${short(r.sessionId)}${r.name ? ` · ${clip(r.name, 18)}` : ''}`;
          const b = el('button', { class: `sf-lib${pass ? ' on' : ''}`, 'aria-pressed': String(!!pass), title: `${r.name || r.sessionId}: ${pass ? 'on the plate; click to take it off' : onPlate.length >= MAX_PASSES ? 'click to put it on the plate in place of the oldest pass' : 'click to put it on the plate'}` }, [s, el('span', { class: 'sf-mono', text: label })]);
          b.addEventListener('click', () => {
            if (pass) onPlate = onPlate.filter((id) => id !== r.sessionId);
            else onPlate = [...(onPlate.length >= MAX_PASSES ? onPlate.slice(1) : onPlate), r.sessionId];
            lifted.delete(r.sessionId);
            draw();
          });
          return b;
        });
        return el('div', { class: 'sf-library' }, [el('div', { class: 'sf-mono sf-lib-head', text: `Library — ${runs.length} run${runs.length === 1 ? '' : 's'} · normalized` }), el('div', { class: 'sf-lib-row' }, items)]);
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
