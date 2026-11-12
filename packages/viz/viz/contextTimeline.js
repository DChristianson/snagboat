// Context timeline: the context each main-agent model call sent, as steps
// over clock time, with prompt rules, compactions, findings, and each model's
// largest-seen and limit lines. See docs/design/conversation-view.md for the
// view and docs/design/visualization-explorer.md for the contract. Draws the
// first session it's given (a session-level visualizer; the explorer stacks
// one per session). Keeps its own zoom: 'all', a range, or by default the
// selected turn with padding (or the latest turn). Clicking a prompt rule
// announces { sessionId, turnId }. Expanded (an option from the Sessions tab)
// adds the output strip, subagent lanes, finding labels, and drag-to-zoom.
// zoomAll() and zoomTo(range | null) on the instance drive the zoom from
// outside. Sees only its host and ctx: no VS Code.
(function () {
  window.factoryClock.register({
    id: 'context-timeline',
    title: 'Context timeline',
    tags: { category: ['temporal', 'quantitative', 'state'], purpose: ['informative'], level: ['session'], dimension: ['time', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, formatTime, ms, modelShort, showTip, hideTip } = ctx;
      const chartHost = el('div');
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(chartHost, note);
      let v = null; // the SessionView drawn
      let selection = null;
      let expanded = false;
      let zoom = null; // [fromMs, toMs], 'all', or null for the default domain
      let draws = 0;

      function update(sessions, sel, options) {
        const next = sessions[0] || null;
        if (!v || !next || v.summary.sessionId !== next.summary.sessionId) zoom = null;
        v = next;
        selection = sel || null;
        expanded = !!(options && options.expanded);
        draw();
      }

      function zoomAll() {
        zoom = 'all';
        draw();
      }
      function zoomTo(range) {
        zoom = Array.isArray(range) ? range : null;
        draw();
      }

      /** The selected turn, when the selection is for this session. */
      function selectedTurn() {
        if (!selection || !selection.turnId) return null;
        return !selection.sessionId || selection.sessionId === v.summary.sessionId ? selection.turnId : null;
      }

      function turnSpan(turnId) {
        const starts = v.prompts.filter((p) => p.turnId === turnId).map((p) => ms(p.ts));
        const calls = v.calls.filter((c) => c.turnId === turnId).map((c) => ms(c.ts));
        const all = [...starts, ...calls];
        return all.length ? [Math.min(...all), Math.max(...all)] : null;
      }

      function domain() {
        const times = [...v.calls.map((c) => ms(c.ts)), ...v.prompts.map((p) => ms(p.ts))];
        const full = [Math.min(...times), Math.max(...times)];
        if (Array.isArray(zoom)) return zoom;
        if (zoom === 'all') return full;
        // A shared range (another visualizer's selection), clamped to the session.
        if (selection && Array.isArray(selection.range)) return [Math.max(full[0], selection.range[0]), Math.min(full[1], selection.range[1])];
        // Default: the selected turn, or the most recent turn, with padding.
        const turn = selectedTurn() || (v.prompts.length ? v.prompts[v.prompts.length - 1].turnId : null);
        const span = turn && turnSpan(turn);
        if (!span) return full;
        const pad = Math.max(60_000, (span[1] - span[0]) * 0.15);
        return [Math.max(full[0], span[0] - pad), Math.min(full[1], span[1] + pad)];
      }

      const findingState = (f) => (f.active ? 'Active now' : 'Earlier');
      function findingTip(f) {
        return [
          `▲ ${f.heuristicId} (${f.severity === 'warn' ? 'warning' : 'info'})`,
          f.summary,
          ['State', findingState(f)],
          ['Started', formatTime(f.startedTs || f.fromTs)],
        ];
      }

      function draw() {
        draws++;
        if (!v) {
          chartHost.replaceChildren();
          note.textContent = '';
          return;
        }
        if (v.calls.length === 0) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'No model calls with token usage in this session.' }));
          note.textContent = '';
          return;
        }
        const [t0, t1raw] = domain();
        const t1 = t1raw > t0 ? t1raw : t0 + 60_000;
        const width = Math.max(320, host.clientWidth || 800);
        const mainCalls = v.calls.filter((c) => !c.agentId);
        const ctxOf = (c) => c.input + c.cacheRead + c.cacheCreation;
        const markValues = Object.values(v.marks).flatMap((m) => [m.largestSeen, m.limit]).filter((x) => typeof x === 'number');
        const maxCtx = Math.max(1, ...mainCalls.map(ctxOf), ...markValues);
        const top = Math.pow(10, Math.floor(Math.log10(maxCtx))) * Math.ceil(maxCtx / Math.pow(10, Math.floor(Math.log10(maxCtx))));
        const m = { l: 52, r: 12, t: 22 };
        const ph = expanded ? 260 : 150;
        const outH = expanded ? 46 : 0;
        const lanes = expanded ? v.subagents.length : 0;
        const axisY = m.t + ph + (outH ? outH + 14 : 0);
        const height = axisY + 22 + lanes * 18 + (lanes ? 8 : 0);
        const pw = width - m.l - m.r;
        const x = (t) => m.l + ((t - t0) / (t1 - t0)) * pw;
        const y = (val) => m.t + ph - (val / top) * ph;
        const root = svg('svg', { class: 'context-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Context sent by each model call over time' });

        for (const val of [0, top / 2, top]) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: m.l + pw, y1: y(val), y2: y(val) }));
          const lab = svg('text', { class: 'axis-label', x: m.l - 6, y: y(val) + 4, 'text-anchor': 'end' });
          lab.textContent = compact(val);
          root.append(lab);
        }

        // Selected turn band.
        const turn = selectedTurn();
        const sel = turn && turnSpan(turn);
        if (sel) root.append(svg('rect', { class: 'turn-band', x: Math.max(m.l, x(sel[0])), y: m.t, width: Math.max(2, Math.min(m.l + pw, x(sel[1])) - Math.max(m.l, x(sel[0]))), height: ph }));

        // Steps: each call holds its height until the next call, capped so idle gaps read as gaps.
        const CAP = 3 * 60_000;
        mainCalls.forEach((c, i) => {
          const ts = ms(c.ts);
          if (ts < t0 || ts > t1) return;
          const next = i + 1 < mainCalls.length ? ms(mainCalls[i + 1].ts) : ts + CAP;
          const x0 = x(ts);
          const x1 = Math.max(x0 + 1.5, Math.min(x(Math.min(next, ts + CAP)), m.l + pw) - 0.5);
          let base = 0;
          for (const [cls, val] of [['s1', c.cacheRead], ['s2', c.cacheCreation], ['s3', c.input]]) {
            if (val <= 0) continue;
            root.append(svg('rect', { class: cls, x: x0, y: y(base + val), width: x1 - x0, height: Math.max(0.5, y(base) - y(base + val)) }));
            base += val;
          }
          const hit = svg('rect', { class: 'hit', x: x0, y: m.t, width: x1 - x0, height: ph });
          hit.addEventListener('mousemove', (e) =>
            showTip(e, [
              `${new Date(ts).toLocaleString()}${c.model ? ` · ${modelShort(c.model)}` : ''}`,
              ['Prompt', c.turnId ? `P${(v.prompts.find((p) => p.turnId === c.turnId) || {}).index ?? '?'}` : '—'],
              ['Context', fmt(ctxOf(c))],
              ['  cache read', fmt(c.cacheRead)],
              ['  cache creation', fmt(c.cacheCreation)],
              ['  fresh input', fmt(c.input)],
              ['Output', fmt(c.output)],
            ])
          );
          hit.addEventListener('mouseleave', hideTip);
          root.append(hit);
        });

        // Largest seen / limit, per model in this session. Labels move below their
        // line when they'd collide with the previous label, so they never overlap.
        const markLines = [];
        for (const [model, marks] of Object.entries(v.marks)) {
          for (const [val, label] of [[marks.largestSeen, 'largest seen'], [marks.limit, marks.limitSource === 'reported' ? 'limit' : 'limit (auto-compaction)']]) {
            if (typeof val === 'number' && val <= top) markLines.push({ val, text: `${label} ${compact(val)} · ${modelShort(model)}` });
          }
        }
        markLines.sort((a, b) => b.val - a.val);
        let lastLabelY = -Infinity;
        for (const mk of markLines) {
          root.append(svg('line', { class: 'mark-line', x1: m.l, x2: m.l + pw, y1: y(mk.val), y2: y(mk.val) }));
          const above = y(mk.val) - 4;
          const ly = above - lastLabelY < 13 ? y(mk.val) + 12 : above;
          lastLabelY = ly;
          const t = svg('text', { class: 'axis-label mark-label', x: m.l + pw - 4, y: ly, 'text-anchor': 'end' });
          t.textContent = mk.text;
          root.append(t);
        }

        // Prompt rules (click selects the turn), labeled once per turn, skipping
        // labels that would collide with the previous one (zoom in to see them).
        const labeled = new Set();
        let lastLabelX = -Infinity;
        for (const p of v.prompts) {
          const ts = ms(p.ts);
          if (ts < t0 || ts > t1) continue;
          const g = svg('g', { class: 'prompt-rule', tabindex: 0, role: 'button' });
          g.append(svg('line', { x1: x(ts), x2: x(ts), y1: m.t - 6, y2: m.t + ph }));
          if (!labeled.has(p.turnId) && x(ts) - lastLabelX >= 26) {
            labeled.add(p.turnId);
            lastLabelX = x(ts);
            const t = svg('text', { class: 'prompt-label', x: x(ts) + 3, y: m.t - 8 });
            t.textContent = `P${p.index}`;
            g.append(t);
          }
          const pick = () => {
            const before = draws;
            ctx.select({ sessionId: v.summary.sessionId, turnId: p.turnId });
            if (draws === before) {
              // The host didn't update in response; band the turn ourselves.
              selection = { sessionId: v.summary.sessionId, turnId: p.turnId };
              draw();
            }
          };
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
          g.addEventListener('mousemove', (e) => showTip(e, [`P${p.index} · ${formatTime(p.ts)}`, ...(p.text ? [clip(p.text, 240)] : [])]));
          g.addEventListener('mouseleave', hideTip);
          root.append(g);
        }

        // Compactions.
        for (const c of v.compactions) {
          const ts = ms(c.ts);
          if (ts < t0 || ts > t1) continue;
          root.append(svg('line', { class: 'compaction-line', x1: x(ts), x2: x(ts), y1: m.t, y2: m.t + ph }));
          const t = svg('text', { class: 'axis-label', x: x(ts) + 4, y: m.t + ph - 6 });
          t.textContent = `⤓ compacted${c.trigger === 'manual' ? ' (manual)' : ''}`;
          root.append(t);
        }

        // Findings: badge where it starts, bracket over its span. Active ones are filled, earlier ones outlined.
        v.findings.forEach((f, i) => {
          if (!f.fromTs) return;
          const a = ms(f.fromTs);
          const b = ms(f.toTs || f.fromTs);
          if (b < t0 || a > t1) return;
          const yy = m.t + 10 + (i % 3) * 14;
          const xa = Math.max(m.l, x(a));
          const xb = Math.min(m.l + pw, x(b));
          const g = svg('g', { class: `finding-mark${f.active ? '' : ' past'}` });
          if (xb - xa > 4) g.append(svg('line', { class: `finding-bracket ${f.severity}`, x1: xa, x2: xb, y1: yy + 3, y2: yy + 3 }));
          g.append(svg('path', { class: f.severity === 'warn' ? 'warn-mark' : 'info-mark', d: `M${xa},${yy} l5,-9 l5,9 z` }));
          if (expanded) {
            const t = svg('text', { class: 'axis-label', x: xa + 13, y: yy });
            t.textContent = f.heuristicId;
            g.append(t);
          }
          g.append(svg('rect', { class: 'hit', x: xa - 4, y: yy - 12, width: Math.max(xb - xa, 10) + 8, height: 18 }));
          g.addEventListener('mousemove', (e) => showTip(e, findingTip(f)));
          g.addEventListener('mouseleave', hideTip);
          root.append(g);
        });

        // Output strip (expanded): own scale.
        if (outH) {
          const oy0 = m.t + ph + 12;
          const omax = Math.max(1, ...mainCalls.map((c) => c.output));
          const lab = svg('text', { class: 'axis-label', x: m.l - 6, y: oy0 + 10, 'text-anchor': 'end' });
          lab.textContent = 'output';
          root.append(lab, svg('line', { class: 'grid', x1: m.l, x2: m.l + pw, y1: oy0 + outH, y2: oy0 + outH }));
          const omaxLab = svg('text', { class: 'axis-label', x: m.l + pw, y: oy0 + 8, 'text-anchor': 'end' });
          omaxLab.textContent = `max ${compact(omax)} (own scale)`;
          root.append(omaxLab);
          for (const c of mainCalls) {
            const ts = ms(c.ts);
            if (ts < t0 || ts > t1 || c.output <= 0) continue;
            const h = (c.output / omax) * outH;
            root.append(svg('rect', { class: 's1 output-bar', x: x(ts), y: oy0 + outH - h, width: 2, height: h }));
          }
        }

        // Time axis.
        const spanMs = t1 - t0;
        const multiDay = new Date(t0).toDateString() !== new Date(t1).toDateString();
        for (let k = 0; k <= 5; k++) {
          const t = t0 + (spanMs * k) / 5;
          const lab = svg('text', { class: 'axis-label', x: x(t), y: axisY + 14, 'text-anchor': k === 0 ? 'start' : k === 5 ? 'end' : 'middle' });
          const d = new Date(t);
          lab.textContent = (multiDay ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          root.append(lab);
        }

        // Subagent lanes (expanded).
        v.subagents.slice(0, lanes).forEach((s, k) => {
          const yy = axisY + 26 + k * 18;
          const a = Math.max(t0, ms(s.firstTs));
          const b = Math.min(t1, ms(s.lastTs));
          if (b >= a) root.append(svg('rect', { class: 'lane', x: x(a), y: yy, width: Math.max(3, x(b) - x(a)), height: 12, rx: 3 }));
          const t = svg('text', { class: 'axis-label', x: m.l - 6, y: yy + 10, 'text-anchor': 'end' });
          t.textContent = `sub ${s.agentId.replace(/^agent-/, '').slice(0, 7)}`;
          root.append(t);
        });

        // Expanded: drag across the chart to zoom into a time range.
        if (expanded) {
          const brush = svg('rect', { class: 'brush', x: 0, y: m.t, width: 0, height: ph, hidden: true });
          root.append(brush);
          let startX = null;
          const toTime = (px) => t0 + ((px - m.l) / pw) * (t1 - t0);
          const local = (e) => {
            const r = root.getBoundingClientRect();
            return ((e.clientX - r.left) / r.width) * width;
          };
          root.addEventListener('mousedown', (e) => {
            startX = local(e);
            brush.removeAttribute('hidden');
          });
          root.addEventListener('mousemove', (e) => {
            if (startX === null) return;
            const cur = local(e);
            brush.setAttribute('x', String(Math.min(startX, cur)));
            brush.setAttribute('width', String(Math.abs(cur - startX)));
          });
          root.addEventListener('mouseup', (e) => {
            if (startX === null) return;
            const a = startX;
            const b = local(e);
            startX = null;
            if (Math.abs(b - a) > 8) zoomTo([toTime(Math.min(a, b)), toTime(Math.max(a, b))]);
            else brush.setAttribute('hidden', '');
          });
        }

        chartHost.replaceChildren(root);
        const subNote = v.subagents.length && !expanded ? ` · ${v.subagents.length} subagent lane${v.subagents.length > 1 ? 's' : ''} when expanded` : '';
        note.textContent = `Showing ${new Date(t0).toLocaleString()} – ${new Date(t1).toLocaleTimeString()}${zoom === 'all' ? ' (whole session)' : ''}. Main agent's context only; subagents run in their own context.${subNote}`;
      }

      return {
        update,
        resize: draw,
        destroy() {
          host.replaceChildren();
        },
        zoomAll,
        zoomTo,
      };
    },
  });
})();
