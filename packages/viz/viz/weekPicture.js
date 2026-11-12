// Week in one picture: seven days as rings around a 24-hour clock, oldest in the
// middle, midnight at the top. A wedge is an hour of a day, darker for more
// tokens, with a dot where a finding started. Rings grow outward, so a wedge's
// area exaggerates later days; color carries the value, and the table beside it
// has the numbers. It draws the loaded sessions, not everything that happened
// that week. Times are local. See docs/design/visualization-explorer.md for the
// contract. Clicking a wedge announces that hour's busiest session and turn. The
// week shown lives in the instance. Sees only its host and ctx: no VS Code.
(function () {
  const DAYS = 7;
  const STEPS = 5;
  const MAX_SIZE = 520;
  const MIN_SIZE = 280;
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  window.factoryClock.register({
    id: 'week-picture',
    title: 'Week in one picture',
    tags: { category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, compact, fmt, clip, short, ms, showTip, hideTip } = ctx;
      let views = [];
      let selection = null;
      let endDay = null; // the week's last day; follows the data until someone moves it
      let moved = false;

      const label = el('strong', { class: 'small' });
      const prevBtn = el('button', { text: '‹ Earlier', 'aria-label': 'An earlier week' });
      const nextBtn = el('button', { text: 'Later ›', 'aria-label': 'A later week' });
      const move = (days) => {
        endDay = addDays(endDay, days);
        moved = true;
        draw();
      };
      prevBtn.addEventListener('click', () => move(-DAYS));
      nextBtn.addEventListener('click', () => move(DAYS));
      const controls = el('div', { class: 'controls' }, [prevBtn, nextBtn, label]);
      const chartHost = el('div', { class: 'week-layout' });
      const legend = el('div', { class: 'legend small week-legend' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(controls, chartHost, legend, note);

      const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));
      const callTokens = (c) => c.input + c.cacheRead + c.cacheCreation + c.output;
      const dayShort = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });

      /** Everything loaded, per local day and hour: Map(dayKey -> Map(hour -> cell)). */
      function collect() {
        const days = new Map();
        const cellAt = (ts) => {
          const d = new Date(ts);
          const key = dayKey(d);
          const day = days.get(key) || new Map();
          days.set(key, day);
          const h = d.getHours();
          const cell = day.get(h) || { hour: h, tokens: 0, calls: 0, sessions: new Map(), turns: new Map(), findings: [] };
          day.set(h, cell);
          return cell;
        };
        let undated = 0;
        for (const v of views) {
          const id = v.summary.sessionId;
          for (const c of v.calls) {
            const cell = cellAt(c.ts);
            const t = callTokens(c);
            cell.tokens += t;
            cell.calls++;
            cell.sessions.set(id, (cell.sessions.get(id) || 0) + t);
            if (c.turnId) {
              const k = `${id}\n${c.turnId}`;
              cell.turns.set(k, (cell.turns.get(k) || 0) + t);
            }
          }
          for (const f of v.findings) {
            const ts = f.startedTs || f.fromTs;
            if (ts) cellAt(ts).findings.push({ severity: f.severity, heuristicId: f.heuristicId, summary: f.summary, sessionId: id, turnId: f.turnIds[0] });
            else undated++;
          }
        }
        return { days, undated };
      }

      /** An annular wedge from angle a0 to a1 (radians, clockwise from the top), between radii r0 and r1. */
      function wedge(cx, cy, r0, r1, a0, a1) {
        const pt = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
        return `M${pt(r0, a0)} L${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z`;
      }

      function draw() {
        if (!views.length) {
          chartHost.replaceChildren();
          legend.replaceChildren();
          note.textContent = '';
          return;
        }
        const { days, undated } = collect();
        const known = [...days.keys()].sort();
        if (!known.length) {
          chartHost.replaceChildren(el('p', { class: 'muted', text: 'No model calls with a time in these sessions.' }));
          legend.replaceChildren();
          note.textContent = '';
          label.textContent = '';
          prevBtn.disabled = nextBtn.disabled = true;
          return;
        }
        const [ly, lm, ld] = known[known.length - 1].split('-').map(Number);
        const latest = new Date(ly, lm - 1, ld);
        const [fy, fm, fd] = known[0].split('-').map(Number);
        const earliest = new Date(fy, fm - 1, fd);
        // A week someone moved to stays, unless the loaded sessions no longer reach it.
        if (moved && (endDay > latest || addDays(endDay, DAYS - 1) < earliest)) moved = false;
        if (!moved) endDay = startOfDay(latest);
        const week = Array.from({ length: DAYS }, (_, i) => addDays(endDay, i - DAYS + 1));
        prevBtn.disabled = week[0] <= earliest;
        nextBtn.disabled = endDay >= latest;
        label.textContent = `${dayShort(week[0])} to ${dayShort(week[DAYS - 1])}`;

        const rows = week.map((d) => ({ date: d, key: dayKey(d), hours: days.get(dayKey(d)) || new Map() }));
        const cells = rows.flatMap((r) => [...r.hours.values()]);
        const max = Math.max(1, ...cells.map((c) => c.tokens));
        const bound = (i) => (max * (i * i)) / (STEPS * STEPS);
        const stepOf = (v) => {
          for (let i = 1; i <= STEPS; i++) if (v <= bound(i)) return i;
          return STEPS;
        };

        const avail = Math.max(320, host.clientWidth || 800);
        const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, avail > 700 ? avail - 240 : avail));
        const cx = size / 2;
        const cy = size / 2;
        const outer = size / 2 - 26;
        const inner = outer * 0.3;
        const ring = (outer - inner) / DAYS;
        const root = svg('svg', { class: 'viz-chart week-chart', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `One week of the loaded sessions, ${label.textContent}, as rings of hours` });

        // Selected turn: the wedges its calls fall in.
        const picked = new Set();
        const s = selection;
        if (s && s.turnId) {
          for (const v of views) {
            if (s.sessionId && s.sessionId !== v.summary.sessionId) continue;
            for (const c of v.calls) {
              if (c.turnId !== s.turnId) continue;
              const d = new Date(c.ts);
              picked.add(`${dayKey(d)}|${d.getHours()}`);
            }
          }
        }

        rows.forEach((r, i) => {
          const r0 = inner + i * ring;
          const r1 = r0 + ring;
          for (let h = 0; h < 24; h++) {
            const a0 = (h / 24) * 2 * Math.PI;
            const a1 = ((h + 1) / 24) * 2 * Math.PI;
            const cell = r.hours.get(h);
            if (!cell) {
              root.append(svg('path', { class: 'week-empty', d: wedge(cx, cy, r0, r1, a0, a1) }));
              continue;
            }
            const best = [...cell.turns].sort((x, y) => y[1] - x[1])[0];
            const bestSession = [...cell.sessions].sort((x, y) => y[1] - x[1])[0];
            const finding = cell.findings[0];
            const [sessionId, turnId] = best ? best[0].split('\n') : [bestSession ? bestSession[0] : finding.sessionId, finding ? finding.turnId : undefined];
            const g = svg('g', { class: 'week-cell', tabindex: 0, role: 'button', 'aria-label': `${dayShort(r.date)}, ${hourLabel(h)}: ${compact(cell.tokens)} tokens, ${cell.findings.length} findings` });
            const on = picked.has(`${r.key}|${h}`);
            g.append(svg('path', { class: `week-wedge${cell.tokens > 0 ? ` heat heat-${stepOf(cell.tokens)}` : ' week-none'}${on ? ' week-selected' : ''}`, d: wedge(cx, cy, r0, r1, a0, a1) }));
            if (cell.findings.length) {
              const worst = cell.findings.some((f) => f.severity === 'warn') ? 'warn' : 'info';
              const mid = (a0 + a1) / 2;
              const rm = (r0 + r1) / 2;
              g.append(svg('circle', { class: `week-finding week-finding-${worst}`, cx: cx + rm * Math.sin(mid), cy: cy - rm * Math.cos(mid), r: Math.min(3.5, ring / 3) }));
            }
            const topSessions = [...cell.sessions].sort((x, y) => y[1] - x[1]).slice(0, 3);
            const nameOf = (id) => {
              const v = views.find((x) => x.summary.sessionId === id);
              return v ? sessionLabel(v.summary) : short(id);
            };
            g.addEventListener('mousemove', (e) =>
              showTip(e, [
                `${dayShort(r.date)}, ${hourLabel(h)}`,
                ['Tokens', fmt(cell.tokens)],
                ['Model calls', fmt(cell.calls)],
                ...topSessions.map(([id, t]) => [nameOf(id), compact(t)]),
                ...cell.findings.slice(0, 3).map((f) => `${f.severity === 'warn' ? '▲' : '△'} ${clip(f.summary, 120)}`),
                ...(cell.findings.length > 3 ? [`and ${cell.findings.length - 3} more findings`] : []),
              ])
            );
            g.addEventListener('mouseleave', hideTip);
            const pick = () => ctx.select(turnId ? { sessionId, turnId } : { sessionId });
            g.addEventListener('click', pick);
            g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
            root.append(g);
          }
        });

        for (const h of [0, 6, 12, 18]) {
          const a = (h / 24) * 2 * Math.PI;
          root.append(svg('line', { class: 'week-spoke', x1: cx + inner * Math.sin(a), y1: cy - inner * Math.cos(a), x2: cx + outer * Math.sin(a), y2: cy - outer * Math.cos(a) }));
          const t = svg('text', { class: 'axis-label', x: cx + (outer + 12) * Math.sin(a), y: cy - (outer + 12) * Math.cos(a) + 4, 'text-anchor': 'middle' });
          t.textContent = hourLabel(h);
          root.append(t);
        }
        // Oldest in, newest out; the two ends named, so the rings can be read.
        const ringLabel = (i, text) => {
          const t = svg('text', { class: 'week-ring-label', x: cx + 3, y: cy - (inner + (i + 0.5) * ring) + 4 });
          t.textContent = text;
          root.append(t);
        };
        if (ring >= 13) {
          rows.forEach((r, i) => ringLabel(i, r.date.toLocaleDateString([], { weekday: 'short' })));
        }
        const total = cells.reduce((a, c) => a + c.tokens, 0);
        const big = svg('text', { class: 'week-total', x: cx, y: cy + 2, 'text-anchor': 'middle' });
        big.textContent = compact(total);
        const small = svg('text', { class: 'axis-label', x: cx, y: cy + 17, 'text-anchor': 'middle' });
        small.textContent = 'tokens';
        root.append(big, small);

        const table = el('table', { class: 'week-table small' }, [
          el('thead', {}, [el('tr', {}, ['Day', 'Tokens', 'Calls', 'Findings'].map((text, i) => el('th', { class: i ? 'num' : undefined, text })))]),
          el(
            'tbody',
            {},
            [...rows].reverse().map((r) => {
              const hs = [...r.hours.values()];
              return el('tr', {}, [
                el('td', { text: r.date.toLocaleDateString([], { weekday: 'short', day: 'numeric' }) }),
                el('td', { class: 'num', text: hs.length ? compact(hs.reduce((a, c) => a + c.tokens, 0)) : '—' }),
                el('td', { class: 'num', text: hs.length ? fmt(hs.reduce((a, c) => a + c.calls, 0)) : '—' }),
                el('td', { class: 'num', text: hs.length ? fmt(hs.reduce((a, c) => a + c.findings.length, 0)) : '—' }),
              ]);
            })
          ),
        ]);
        chartHost.replaceChildren(root, table);

        const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
        legend.replaceChildren(
          el('span', { class: 'muted', text: 'tokens in the hour' }),
          ...Array.from({ length: STEPS }, (_, i) => key(`heat-swatch heat-${i + 1}`, `up to ${compact(Math.round(bound(i + 1)))}`)),
          key('swatch-week-warn', 'finding (warning)'),
          key('swatch-week-info', 'finding (info)')
        );
        note.textContent = `Rings are days, oldest in the middle; midnight is at the top and hours run clockwise, in local time. Only the ${views.length === 1 ? 'loaded session counts' : `${fmt(views.length)} loaded sessions count`}, so load more to fill the week.${undated ? ` ${fmt(undated)} finding${undated === 1 ? '' : 's'} with no time recorded left out.` : ''} Outer rings have more area, so go by color, or the table. Click a wedge to select that hour’s busiest turn.`;
      }

      return {
        update(sessions, sel) {
          views = sessions;
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
