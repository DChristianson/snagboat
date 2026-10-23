// Snagboat detail view. Plain DOM, no framework; every piece of event data is
// written with textContent, never innerHTML. The layout is built once and its
// parts updated in place, so a live state push never steals focus from the
// filter inputs or resets the timeline's scroll position.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    range: saved.range || 30,
    agent: saved.agent || '',
    kind: saved.kind || '',
    status: saved.status || '',
    search: saved.search || '',
    // { heuristicId, summary, refs: Set<string> } while the timeline is narrowed to one finding's events.
    finding: null,
  };
  let state = null;

  const SERIES = [
    { slot: 1, label: 'Claude Code', match: (a) => a === 'claude-code' },
    { slot: 2, label: 'Copilot', match: (a) => a === 'copilot' },
    { slot: 3, label: 'Other agents', match: () => true },
  ];
  const seriesOf = (agent) => SERIES.find((s) => s.match(agent));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Shared with sessions.js, which keeps its own keys in the same saved state.
  function persist(extra) {
    vscode.setState({ ...(vscode.getState() || {}), range: ui.range, agent: ui.agent, kind: ui.kind, status: ui.status, search: ui.search, ...(extra || {}) });
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const child of [].concat(children || [])) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
  }

  const fmt = (n) => n.toLocaleString();
  function compact(n) {
    if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    for (const step of [1, 2, 5, 10]) if (step * pow >= v) return step * pow;
    return 10 * pow;
  }
  function formatTime(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }
  function formatDay(day) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // ---------- layout (built once) ----------

  const app = document.getElementById('app');
  const tooltip = document.getElementById('tooltip');

  const updatedNote = el('p', { class: 'muted small' });
  const captureNote = el('p', { class: 'muted small' });
  const tiles = el('div', { class: 'tiles' });
  const findingsList = el('div');
  const mutedRow = el('div', { class: 'chips' });

  const rangeButtons = [7, 30, 90].map((days) => {
    const button = el('button', { text: `${days} days`, 'aria-pressed': String(ui.range === days) });
    button.addEventListener('click', () => {
      ui.range = days;
      persist();
      for (const b of rangeButtons) b.setAttribute('aria-pressed', String(b === button));
      renderChart();
    });
    return button;
  });
  const legend = el('div', { class: 'legend' });
  const chartHost = el('div');
  const chartTable = el('div');

  const agentSelect = el('select', { 'aria-label': 'Filter by agent' });
  const kindSelect = el('select', { 'aria-label': 'Filter by kind' });
  const statusSelect = el('select', { 'aria-label': 'Filter by status' });
  const searchInput = el('input', { type: 'search', placeholder: 'Filter by target, session, or reply text', 'aria-label': 'Filter by target, session, or reply text' });
  searchInput.value = ui.search;
  for (const [select, key] of [[agentSelect, 'agent'], [kindSelect, 'kind'], [statusSelect, 'status']]) {
    select.addEventListener('change', () => {
      ui[key] = select.value;
      persist();
      renderTimeline();
    });
  }
  searchInput.addEventListener('input', () => {
    ui.search = searchInput.value;
    persist();
    renderTimeline();
  });
  const findingNote = el('div', { class: 'filter-note', hidden: true });
  const timelineCount = el('p', { class: 'muted small' });
  const timelineBody = el('tbody');

  // ---------- tabs: Overview (this script) and Sessions (sessions.js) ----------
  const overviewRoot = el('div', { id: 'overview-root', role: 'tabpanel', 'aria-labelledby': 'tab-overview' });
  const sessionsRoot = el('div', { id: 'sessions-root', role: 'tabpanel', 'aria-labelledby': 'tab-sessions', hidden: true });
  const tabButtons = {};
  function selectTab(tab, notify) {
    for (const [name, btn] of Object.entries(tabButtons)) btn.setAttribute('aria-selected', String(name === tab));
    overviewRoot.hidden = tab !== 'overview';
    sessionsRoot.hidden = tab !== 'sessions';
    persist({ tab });
    if (notify) vscode.postMessage({ type: 'tab', tab });
    if (tab === 'sessions' && window.snagboatSessions) window.snagboatSessions.shown();
  }
  for (const [name, label] of [['overview', 'Overview'], ['sessions', 'Sessions']]) {
    const btn = el('button', { id: `tab-${name}`, class: 'tab', role: 'tab', text: label });
    btn.addEventListener('click', () => selectTab(name, true));
    tabButtons[name] = btn;
  }
  const tabBar = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Snagboat views' }, Object.values(tabButtons));

  app.replaceChildren(el('div', { class: 'title-row' }, [el('h1', { text: 'Snagboat' }), tabBar]), overviewRoot, sessionsRoot);
  overviewRoot.append(
    el('header', {}, [updatedNote, captureNote, tiles]),
    el('section', { 'aria-labelledby': 'findings-h' }, [el('h2', { id: 'findings-h', text: 'Findings' }), findingsList, mutedRow]),
    el('section', { 'aria-labelledby': 'usage-h' }, [
      el('h2', { id: 'usage-h', text: 'Token usage per day' }),
      el('div', { class: 'controls', role: 'group', 'aria-label': 'Date range' }, rangeButtons),
      legend,
      chartHost,
      chartTable,
    ]),
    el('section', { 'aria-labelledby': 'timeline-h' }, [
      el('h2', { id: 'timeline-h', text: 'Timeline' }),
      el('div', { class: 'controls' }, [agentSelect, kindSelect, statusSelect, searchInput]),
      findingNote,
      timelineCount,
      el('div', { class: 'timeline-wrap' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Time' }),
              el('th', { text: 'Agent' }),
              el('th', { text: 'Session' }),
              el('th', { text: 'Kind' }),
              el('th', { text: 'Status' }),
              el('th', { text: 'Target' }),
              el('th', { class: 'num', text: 'Tokens' }),
            ]),
          ]),
          timelineBody,
        ]),
      ]),
    ])
  );

  // Helpers for sessions.js (same document, same CSP nonce).
  window.snagboat = { vscode, el, svg, compact, fmt, formatTime, persist, sessionsRoot, selectTab, tooltip };

  // ---------- header ----------

  function renderHeader() {
    updatedNote.textContent = `Updated ${new Date(state.generatedAt).toLocaleTimeString()}`;
    captureNote.textContent = state.capture.enabled
      ? `Content capture is on: agent reply excerpts are stored in the local event log for ${state.capture.retentionDays} days.`
      : 'Content capture is off: no reply text is stored. Turn on snagboat.captureContent to enable the verbal-hedge heuristic.';
    tiles.replaceChildren(
      ...[
        ['Tokens today', state.today.tokens],
        ['Agent events today', state.today.events],
        ['Local edits today', state.today.edits],
      ].map(([label, value]) => el('div', { class: 'tile' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: fmt(value) })]))
    );
  }

  // ---------- findings ----------

  function renderFindings() {
    const active = state.findings
      .filter((f) => !f.muted)
      .sort(
        (a, b) =>
          Number(a.acknowledged) - Number(b.acknowledged) ||
          Number(b.severity === 'warn') - Number(a.severity === 'warn') ||
          b.detectedAt.localeCompare(a.detectedAt)
      );

    if (active.length === 0) {
      findingsList.replaceChildren(el('p', { class: 'muted', text: 'No active findings.' }));
    } else {
      findingsList.replaceChildren(
        ...active.map((f) =>
          el('article', { class: `finding ${f.severity}${f.acknowledged ? ' acknowledged' : ''}` }, [
            el('div', { class: 'head' }, [
              el('span', { class: `badge ${f.severity}`, text: f.severity === 'warn' ? 'Warning' : 'Info' }),
              el('strong', { text: f.heuristicId }),
              f.acknowledged && el('span', { class: 'muted small', text: 'Acknowledged: hidden from the status bar until it clears' }),
            ]),
            el('p', { class: 'summary', text: f.summary }),
            f.suggestedAction && el('p', { class: 'muted small', text: f.suggestedAction }),
            el('div', { class: 'actions' }, [
              f.eventRefs.length > 0 &&
                el('button', {
                  text: `Show ${f.eventRefs.length} event${f.eventRefs.length === 1 ? '' : 's'}`,
                  onclick: () => {
                    ui.finding = { heuristicId: f.heuristicId, summary: f.summary, refs: new Set(f.eventRefs) };
                    renderTimeline();
                    document.getElementById('timeline-h').scrollIntoView({ behavior: 'smooth' });
                  },
                }),
              f.sessionId &&
                el('button', {
                  text: 'Show in session',
                  onclick: () => {
                    persist({ sessionId: f.sessionId });
                    vscode.postMessage({ type: 'openSession', sessionId: f.sessionId });
                  },
                }),
              !f.acknowledged &&
                el('button', { text: 'Acknowledge', onclick: () => vscode.postMessage({ type: 'acknowledge', heuristicId: f.heuristicId }) }),
              el('button', {
                text: `Mute ${f.heuristicId}`,
                title: 'Hide this heuristic everywhere in this workspace until unmuted',
                onclick: () => vscode.postMessage({ type: 'setMuted', heuristicId: f.heuristicId, muted: true }),
              }),
            ]),
          ])
        )
      );
    }

    if (state.muted.length === 0) {
      mutedRow.replaceChildren();
    } else {
      mutedRow.replaceChildren(
        el('span', { class: 'muted small', text: 'Muted:' }),
        ...state.muted.map((id) => {
          const count = state.findings.filter((f) => f.heuristicId === id).length;
          return el('span', { class: 'chip' }, [
            el('span', { text: count > 0 ? `${id} (${count} active)` : id }),
            el('button', { text: 'Unmute', onclick: () => vscode.postMessage({ type: 'setMuted', heuristicId: id, muted: false }) }),
          ]);
        })
      );
    }
  }

  // ---------- chart ----------

  function rangeDays() {
    const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const days = [];
    for (let i = ui.range - 1; i >= 0; i--) days.push(new Date(todayMs - i * DAY_MS).toISOString().slice(0, 10));
    return days;
  }

  function renderChart() {
    if (!state) return;
    const byDate = new Map(state.daily.map((d) => [d.date, d.perAgent]));
    const rows = rangeDays().map((date) => {
      const values = { 1: 0, 2: 0, 3: 0 };
      for (const [agent, tokens] of Object.entries(byDate.get(date) || {})) values[seriesOf(agent).slot] += tokens;
      return { date, values, total: values[1] + values[2] + values[3] };
    });
    const present = SERIES.filter((s) => rows.some((r) => r.values[s.slot] > 0));

    if (present.length === 0) {
      legend.replaceChildren();
      chartHost.replaceChildren(el('p', { class: 'muted', text: 'No token usage recorded in this range.' }));
      chartTable.replaceChildren();
      return;
    }

    // A single series is named by the section title; a legend box would only repeat it.
    legend.replaceChildren(
      ...(present.length >= 2
        ? present.map((s) => el('span', { class: 'key' }, [el('span', { class: `swatch s${s.slot}`, 'aria-hidden': 'true' }), el('span', { text: s.label })]))
        : [el('span', { class: 'muted small', text: present[0].label })])
    );

    const width = Math.max(320, chartHost.clientWidth || 800);
    const height = 220;
    const m = { top: 8, right: 8, bottom: 24, left: 48 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const max = niceMax(Math.max(...rows.map((r) => r.total)));
    const band = plotW / rows.length;
    const colW = Math.max(2, Math.min(24, band * 0.7));
    const y = (v) => m.top + plotH - (v / max) * plotH;

    const root = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Stacked daily token usage for the last ${ui.range} days; see the table view for values` });

    for (const tick of [0, max / 2, max]) {
      root.append(svg('line', { class: 'grid', x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick) }));
      const label = svg('text', { class: 'axis-label', x: m.left - 6, y: y(tick) + 4, 'text-anchor': 'end' });
      label.textContent = compact(tick);
      root.append(label);
    }

    const labelEvery = Math.ceil(rows.length / 6);
    rows.forEach((row, i) => {
      const cx = m.left + band * i + band / 2;
      const x = cx - colW / 2;
      let cursor = y(0);
      const segments = SERIES.filter((s) => row.values[s.slot] > 0);
      segments.forEach((s, j) => {
        const h = (row.values[s.slot] / max) * plotH;
        const top = cursor - h;
        // 2px surface gap between stacked segments, taken from the lower edge of every segment above the first.
        const gap = j > 0 && h > 3 ? 2 : 0;
        const drawH = Math.max(1, h - gap);
        if (j === segments.length - 1) {
          const r = Math.min(4, drawH, colW / 2);
          root.append(
            svg('path', {
              class: `s${s.slot}`,
              d: `M${x},${top + drawH} V${top + r} Q${x},${top} ${x + r},${top} H${x + colW - r} Q${x + colW},${top} ${x + colW},${top + r} V${top + drawH} Z`,
            })
          );
        } else {
          root.append(svg('rect', { class: `s${s.slot}`, x, y: top, width: colW, height: drawH }));
        }
        cursor = top;
      });

      if (i % labelEvery === 0 || i === rows.length - 1) {
        const label = svg('text', { class: 'axis-label', x: cx, y: height - 6, 'text-anchor': 'middle' });
        label.textContent = formatDay(row.date);
        root.append(label);
      }

      // Hit target is the whole band, much larger than the column itself.
      const hit = svg('rect', { class: 'col-hit', x: m.left + band * i, y: m.top, width: band, height: plotH, tabindex: row.total > 0 ? 0 : -1 });
      hit.setAttribute('aria-label', `${formatDay(row.date)}: ${fmt(row.total)} tokens`);
      const show = (evt) => showTooltip(row, present, evt, hit);
      hit.addEventListener('mousemove', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', hideTooltip);
      // A day's column opens the Sessions list for that day.
      if (row.total > 0) {
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', () => {
          selectTab('sessions', true);
          vscode.postMessage({ type: 'listSessions', day: row.date });
        });
      }
      hit.addEventListener('blur', hideTooltip);
      root.insertBefore(hit, root.firstChild);
    });

    chartHost.replaceChildren(root);

    const withData = rows.filter((r) => r.total > 0).reverse();
    chartTable.replaceChildren(
      el('details', {}, [
        el('summary', { text: 'Table view' }),
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Day (UTC)' }), ...present.map((s) => el('th', { class: 'num', text: s.label })), el('th', { class: 'num', text: 'Total' })])]),
          el(
            'tbody',
            {},
            withData.map((r) =>
              el('tr', {}, [el('td', { text: r.date }), ...present.map((s) => el('td', { class: 'num', text: fmt(r.values[s.slot]) })), el('td', { class: 'num', text: fmt(r.total) })])
            )
          ),
        ]),
      ])
    );
  }

  function showTooltip(row, present, evt, target) {
    if (row.total === 0) return hideTooltip();
    tooltip.replaceChildren(
      el('div', { text: `${formatDay(row.date)} (UTC)` }),
      ...present
        .filter((s) => row.values[s.slot] > 0)
        .map((s) =>
          el('div', { class: 'row' }, [
            el('span', { class: 'key' }, [el('span', { class: `swatch s${s.slot}`, 'aria-hidden': 'true' }), el('span', { text: s.label })]),
            el('span', { text: fmt(row.values[s.slot]) }),
          ])
        ),
      el('div', { class: 'row total' }, [el('span', { text: 'Total' }), el('span', { text: fmt(row.total) })])
    );
    tooltip.hidden = false;
    const anchor = evt.type === 'focus' ? target.getBoundingClientRect() : { left: evt.clientX, top: evt.clientY, width: 0 };
    const tw = tooltip.offsetWidth;
    const left = Math.min(window.innerWidth - tw - 8, anchor.left + anchor.width / 2 + 12);
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, anchor.top - tooltip.offsetHeight - 8)}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  // ---------- timeline ----------

  function syncSelect(select, values, current, allLabel) {
    const wanted = ['', ...values];
    if (current && !values.includes(current)) wanted.push(current); // keep a saved choice selectable even if it has no rows right now
    const existing = [...select.options].map((o) => o.value);
    if (existing.join('\n') !== wanted.join('\n')) {
      select.replaceChildren(...wanted.map((v) => el('option', { value: v, text: v || allLabel })));
    }
    select.value = current;
  }

  // Expanded excerpts survive live re-renders; they're reset only by reloading the view.
  const expanded = new Set();
  function toggleExpanded(id, open) {
    if (open) expanded.add(id);
    else expanded.delete(id);
  }

  function renderTimeline() {
    if (!state) return;
    const events = state.timeline.events;
    const distinct = (key) => [...new Set(events.map((e) => e[key]))].sort();
    syncSelect(agentSelect, distinct('agent'), ui.agent, 'All agents');
    syncSelect(kindSelect, distinct('kind'), ui.kind, 'All kinds');
    syncSelect(statusSelect, distinct('status'), ui.status, 'All statuses');

    const needle = ui.search.trim().toLowerCase();
    const rows = events.filter(
      (e) =>
        (!ui.finding || ui.finding.refs.has(e.id)) &&
        (!ui.agent || e.agent === ui.agent) &&
        (!ui.kind || e.kind === ui.kind) &&
        (!ui.status || e.status === ui.status) &&
        (!needle ||
          (e.target || '').toLowerCase().includes(needle) ||
          e.sessionId.toLowerCase().includes(needle) ||
          (e.textExcerpt || '').toLowerCase().includes(needle))
    );

    if (ui.finding) {
      const missing = ui.finding.refs.size - events.filter((e) => ui.finding.refs.has(e.id)).length;
      findingNote.replaceChildren(
        el('span', {
          text: `Showing events behind ${ui.finding.heuristicId}: \u201c${ui.finding.summary}\u201d${missing > 0 ? ` (${missing} no longer in the timeline)` : ''}`,
        }),
        el('button', { text: 'Show all', onclick: () => { ui.finding = null; renderTimeline(); } })
      );
      findingNote.hidden = false;
    } else {
      findingNote.hidden = true;
    }

    timelineCount.textContent =
      `${fmt(rows.length)} of ${fmt(events.length)} events from the last 24 hours` +
      (state.timeline.truncated ? ' (newest 1,000 only)' : '');

    timelineBody.replaceChildren(
      ...rows.flatMap((e) => [
        el('tr', { class: ui.finding ? 'highlight' : undefined }, [
          el('td', { text: formatTime(e.ts), title: e.ts }),
          el('td', { text: e.agent }),
          el('td', {}, [
            e.agent === 'generic-fs'
              ? el('span', { class: 'muted', text: '\u2014' })
              : el('button', {
              class: 'link',
              text: e.sessionId.slice(0, 8),
              title: 'Open this session',
              onclick: () => {
                persist({ sessionId: e.sessionId });
                vscode.postMessage({ type: 'openSession', sessionId: e.sessionId });
              },
            }),
          ]),
          el('td', { text: e.toolLabel ? `${e.kind} \u00b7 ${e.toolLabel}` : e.kind }),
          el('td', { class: e.status === 'failure' ? 'status-failure' : undefined, text: e.status }),
          el('td', {}, [
            e.target === undefined
              ? el('span', { class: 'muted', text: '\u2014' })
              : e.openable
                ? el('button', { class: 'link', text: e.target, title: 'Open file', onclick: () => vscode.postMessage({ type: 'openFile', target: e.target }) })
                : el('span', { text: e.target }),
          ]),
          el('td', { class: 'num', text: e.tokens === undefined ? '' : fmt(e.tokens) }),
        ]),
        e.textExcerpt &&
          el('tr', { class: `excerpt${ui.finding ? ' highlight' : ''}` }, [
            el('td'),
            el('td', { colspan: 5 }, [el('details', { open: expanded.has(e.id) || undefined, ontoggle: (evt) => toggleExpanded(e.id, evt.currentTarget.open) }, [
              el('summary', { text: 'Reply excerpt' }),
              el('p', { class: 'excerpt-text', text: e.textExcerpt }),
            ])]),
          ]),
      ].filter(Boolean))
    );
  }

  // ---------- wiring ----------

  function render() {
    renderHeader();
    renderFindings();
    renderChart();
    renderTimeline();
  }

  window.addEventListener('message', (evt) => {
    if (evt.data && evt.data.type === 'state') {
      state = evt.data.state;
      render();
    } else if (evt.data && evt.data.type === 'navigate') {
      selectTab(evt.data.tab, false);
    }
  });
  // Restore the tab from the last session of this panel.
  const savedTab = (vscode.getState() || {}).tab;
  if (savedTab === 'sessions') {
    selectTab('sessions', false);
    vscode.postMessage({ type: 'tab', tab: 'sessions' });
  } else {
    selectTab('overview', false);
  }
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderChart, 150);
  });
  vscode.postMessage({ type: 'ready' });
})();
