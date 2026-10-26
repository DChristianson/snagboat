// Snagboat Sessions tab: a session list, then one session as a turn tree
// (icicle) above a context timeline. See docs/design/conversation-view.md.
// Uses the helpers detail.js exposes on window.snagboat. Plain DOM and SVG;
// all data is written with textContent, never innerHTML.
(function () {
  const S = window.snagboat;
  if (!S) return;
  const { vscode, el, svg, compact, fmt, formatTime, clip, persist, sessionsRoot, tooltip } = S;
  const saved = vscode.getState() || {};

  const ui = {
    list: null, // { day, days, sessions }
    view: null, // SessionView
    focusId: 's', // tree node shown at full width
    selectedTurn: null,
    expanded: !!saved.sessionExpanded,
    zoom: null, // [fromMs, toMs] or null for the default domain
  };

  // ---------- layout ----------
  const daySelect = el('select', { 'aria-label': 'Day' });
  daySelect.addEventListener('change', () => vscode.postMessage({ type: 'listSessions', day: daySelect.value }));
  const listHost = el('div', { class: 'session-list' });
  const listSection = el('section', { 'aria-label': 'Sessions' }, [el('div', { class: 'controls' }, [el('label', { class: 'muted small', text: 'Day ' }), daySelect]), listHost]);

  const crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  const closeBtn = el('button', { text: 'Close session' });
  closeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'closeSession' });
    persist({ sessionId: null });
  });
  const sessionMeta = el('p', { class: 'muted small' });
  const promptPanel = el('section', { class: 'prompt-panel', 'aria-label': 'Prompt', hidden: true });
  const treeHost = el('div', { class: 'tree-host' });
  const expandBtn = el('button', {});
  expandBtn.addEventListener('click', () => {
    ui.expanded = !ui.expanded;
    persist({ sessionExpanded: ui.expanded });
    render();
  });
  const wholeBtn = el('button', { text: 'Show whole session' });
  wholeBtn.addEventListener('click', () => {
    ui.zoom = 'all';
    renderTimeline();
  });
  const timelineHost = el('div', { class: 'timeline-host' });
  const timelineNote = el('p', { class: 'muted small' });
  const timelinePanel = el('section', { class: 'timeline-panel', 'aria-label': 'Context timeline' }, [
    el('div', { class: 'panel-head' }, [el('strong', { text: 'Context timeline' }), el('span', { class: 'spacer' }), wholeBtn, expandBtn]),
    timelineHost,
    timelineNote,
  ]);
  const findingsSection = el('section', { class: 'session-findings', 'aria-label': 'Findings in this session' });
  const sessionSection = el('section', { class: 'session-view', hidden: true }, [
    el('div', { class: 'session-head' }, [crumbs, el('span', { class: 'spacer' }), closeBtn]),
    sessionMeta,
    treeHost,
    promptPanel,
    timelinePanel,
    findingsSection,
  ]);
  sessionsRoot.append(listSection, sessionSection);

  // ---------- helpers ----------
  const ms = (ts) => Date.parse(ts);
  const short = (id) => id.slice(0, 8);
  function duration(fromTs, toTs) {
    const m = Math.round((ms(toTs) - ms(fromTs)) / 60000);
    return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`;
  }
  const isLive = (s) => Date.now() - ms(s.lastTs) < 10 * 60 * 1000;
  const agentName = (a) => (a === 'claude-code' ? 'Claude Code' : a === 'copilot' ? 'Copilot' : a);
  const modelShort = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  function findNode(node, id) {
    if (node.id === id) return node;
    for (const c of node.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
    return null;
  }
  function pathTo(node, id, acc = []) {
    if (node.id === id) return [...acc, node];
    for (const c of node.children) {
      const p = pathTo(c, id, [...acc, node]);
      if (p) return p;
    }
    return null;
  }
  function showTip(evt, rows) {
    tooltip.replaceChildren(...rows.map((r) => (typeof r === 'string' ? el('div', { text: r }) : el('div', { class: 'row' }, [el('span', { text: r[0] }), el('span', { text: r[1] })]))));
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, evt.clientX + 12))}px`;
    tooltip.style.top = `${Math.max(8, evt.clientY - tooltip.offsetHeight - 10)}px`;
  }
  const hideTip = () => (tooltip.hidden = true);
  /** Truncates text to fit a width (about 7px per character at 12px), with an ellipsis. */
  function fit(text, widthPx) {
    const max = Math.floor((widthPx - 12) / 7);
    return max < 2 ? '' : text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '\u2026';
  }

  // ---------- session list ----------
  function renderList() {
    const list = ui.list;
    if (!list) return;
    const wanted = list.days.length ? list.days : [list.day];
    if ([...daySelect.options].map((o) => o.value).join() !== wanted.join()) {
      daySelect.replaceChildren(...wanted.map((d) => el('option', { value: d, text: d })));
    }
    daySelect.value = list.day;
    listSection.hidden = ui.expanded && !!ui.view;
    if (list.sessions.length === 0) {
      listHost.replaceChildren(el('p', { class: 'muted', text: 'No agent sessions on this day.' }));
      return;
    }
    const rows = list.sessions.map((s) => {
      const open = ui.view && ui.view.summary.sessionId === s.sessionId;
      const tr = el('tr', { class: open ? 'selected' : undefined, tabindex: 0, 'aria-selected': String(!!open) }, [
        el('td', { text: `${isLive(s) ? '\u25cf ' : ''}${new Date(s.firstTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` }),
        el('td', { text: agentName(s.agent) }),
        el('td', { text: s.models.map(modelShort).join(', ') || '\u2014' }),
        el('td', { class: 'num', text: fmt(s.prompts) }),
        el('td', { class: 'num', text: fmt(s.modelCalls) }),
        el('td', { class: 'num', text: compact(s.tokens) }),
        el('td', { class: 'num', text: duration(s.firstTs, s.lastTs) }),
        el(
          'td',
          { title: s.name ? `${s.name} (${s.sessionId})` : s.sessionId },
          s.name ? [el('span', { text: clip(s.name, 48) }), el('span', { class: 'muted', text: ` ${short(s.sessionId)}` })] : [el('span', { class: 'muted', text: short(s.sessionId) })]
        ),
      ]);
      const openIt = () => {
        persist({ sessionId: s.sessionId });
        vscode.postMessage({ type: 'openSession', sessionId: s.sessionId });
      };
      tr.addEventListener('click', openIt);
      tr.addEventListener('keydown', (e) => e.key === 'Enter' && openIt());
      return tr;
    });
    listHost.replaceChildren(
      el('div', { class: 'list-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, ['Started', 'Agent', 'Models', 'Prompts', 'Model calls', 'Tokens', 'Span', 'Session'].map((h, i) => el('th', { class: i >= 3 && i <= 6 ? 'num' : undefined, text: h })))]),
          el('tbody', {}, rows),
        ]),
      ])
    );
  }

  // ---------- breadcrumb ----------
  function renderCrumbs() {
    const v = ui.view;
    const path = pathTo(v.tree, ui.focusId) || [v.tree];
    const items = [el('button', { class: 'link', text: 'Sessions', onclick: () => vscode.postMessage({ type: 'closeSession' }) })];
    path.forEach((node, i) => {
      items.push(el('span', { class: 'muted', text: ' \u203a ' }));
      const label = node.kind === 'session' ? sessionLabel(v.summary) : node.label;
      items.push(
        i === path.length - 1
          ? el('span', { text: label })
          : el('button', { class: 'link', text: label, onclick: () => focus(node.id) })
      );
    });
    crumbs.replaceChildren(...items);
    const s = v.summary;
    sessionMeta.textContent = `${agentName(s.agent)} \u00b7 ${s.models.map(modelShort).join(', ')} \u00b7 ${fmt(s.prompts)} prompts \u00b7 ${fmt(s.modelCalls)} model calls \u00b7 ${fmt(s.toolCalls)} tool calls \u00b7 ${compact(s.tokens)} tokens${s.subagents ? ` \u00b7 ${s.subagents} subagents` : ''}${isLive(s) ? ' \u00b7 live' : ''}`;
  }

  const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));

  // The selected turn's prompt text, when it was captured (several messages can share a turn).
  function renderPromptPanel() {
    const v = ui.view;
    const messages = ui.selectedTurn ? v.prompts.filter((p) => p.turnId === ui.selectedTurn) : [];
    promptPanel.hidden = messages.length === 0;
    if (!messages.length) return promptPanel.replaceChildren();
    promptPanel.replaceChildren(
      el('div', { class: 'prompt-head' }, [el('strong', { text: `P${messages[0].index}` }), el('span', { class: 'muted small', text: ` ${formatTime(messages[0].ts)}` })]),
      ...messages.map((p) => el('p', { class: p.text ? 'prompt-text' : 'prompt-text muted', text: p.text || 'Prompt text wasn\u2019t captured for this turn (text capture was off, or it\u2019s past text retention).' }))
    );
  }

  function focus(id) {
    const node = findNode(ui.view.tree, id);
    if (!node) return;
    ui.focusId = node.children.length ? id : (pathTo(ui.view.tree, id) || []).slice(-2)[0]?.id || 's';
    ui.selectedTurn = node.turnId || (pathTo(ui.view.tree, id) || []).map((n) => n.turnId).filter(Boolean).pop() || null;
    ui.zoom = null;
    render();
  }

  // ---------- turn tree (icicle) ----------
  function renderTree() {
    const v = ui.view;
    const root = findNode(v.tree, ui.focusId) || v.tree;
    const width = Math.max(320, treeHost.clientWidth || 800);
    const rowH = 40;
    const gap = 4;
    const maxDepth = ui.expanded ? 1 : 3;
    const levels = [];
    (function walk(node, depth, x0, x1) {
      (levels[depth] = levels[depth] || []).push({ node, x0, x1 });
      if (depth >= maxDepth || node.tokens <= 0) return;
      let x = x0;
      for (const c of node.children) {
        const w = ((x1 - x0) * c.tokens) / node.tokens;
        walk(c, depth + 1, x, x + w);
        x += w;
      }
    })(root, 0, 0, width);
    const height = (ui.expanded ? levels.length - 1 : levels.length) * (rowH + gap);
    const root$ = svg('svg', { class: 'tree', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Turn tree: where this session\u2019s tokens went' });
    levels.forEach((row, depth) => {
      for (const { node, x0, x1 } of row) {
        if (depth === 0 && ui.expanded) continue; // expanded: show only the prompt row
        const y = (ui.expanded ? depth - 1 : depth) * (rowH + gap);
        const w = x1 - x0;
        if (w < 0.5) continue;
        const selected = node.turnId && node.turnId === ui.selectedTurn && node.kind === 'prompt';
        const g = svg('g', { class: 'tree-node', tabindex: 0, role: 'button' });
        g.append(svg('rect', { class: nodeClass(node, selected), x: x0 + 1, y, width: Math.max(w - 2, 0.5), height: rowH, rx: 3 }));
        if (node.colorGroup) g.append(svg('rect', { class: `cat-stripe cat-${node.colorGroup}`, x: x0 + 1, y, width: Math.max(w - 2, 0.5), height: 4, rx: 2 }));
        if (w > 36) {
          const t = svg('text', { class: 'node-label', x: x0 + 7, y: y + 16 });
          t.textContent = fit(node.kind === 'session' ? `Session ${sessionLabel(v.summary)}` : node.label, w - (node.findings ? 14 : 0));
          const t2 = svg('text', { class: 'node-sub-label', x: x0 + 7, y: y + 31 });
          t2.textContent = fit(`${node.approximate ? '\u2248 ' : ''}${compact(node.tokens)}`, w);
          g.append(t, t2);
        }
        if (node.findings && w > 18) {
          const warn = node.findings.some((f) => f.severity === 'warn');
          g.append(svg('path', { class: warn ? 'warn-mark' : 'info-mark', d: `M${x1 - 12},${y + 15} l5,-9 l5,9 z` }));
        }
        const label = node.kind === 'session' ? `Session ${sessionLabel(v.summary)}` : node.label;
        const promptText = node.kind === 'prompt' && node.turnId ? v.prompts.find((p) => p.turnId === node.turnId && p.text)?.text : undefined;
        g.addEventListener('mousemove', (e) =>
          showTip(e, [label, ...(promptText ? [clip(promptText, 240)] : []), ['Tokens', `${node.approximate ? '\u2248 ' : ''}${fmt(node.tokens)}`], ...(node.findings || []).map((f) => [`\u25b2 ${f.heuristicId}`, f.severity])])
        );
        g.addEventListener('mouseleave', hideTip);
        g.addEventListener('click', () => focus(node.id));
        g.addEventListener('keydown', (e) => e.key === 'Enter' && focus(node.id));
        root$.append(g);
      }
    });
    treeHost.replaceChildren(root$, ui.expanded ? '' : treeLegend(v, levels));
  }

  // Turns alternate two shades so neighbors contrast; categories take their color group (tinted, with a solid top stripe).
  function nodeClass(node, selected) {
    const parts = ['node'];
    if (node.kind === 'category') parts.push(`cat cat-${node.colorGroup || 0}`);
    else if (node.kind === 'prompt' || node.kind === 'agent') parts.push(node.shade === undefined ? 'node-unlinked' : `turn-${node.shade}`);
    if (node.kind === 'agent') parts.push(node.agentId ? 'node-sub' : 'node-agent');
    if (selected) parts.push('node-selected');
    return parts.join(' ');
  }

  function treeLegend(v, levels) {
    const shown = levels.flat().map((l) => l.node);
    const groups = new Set(shown.filter((n) => n.kind === 'category').map((n) => n.colorGroup || 0));
    if (!groups.size) return '';
    const key = (cls, text) => el('span', { class: 'key' }, [el('span', { class: `swatch ${cls}` }), text]);
    return el('div', { class: 'legend tree-legend small' }, [
      ...v.categoryGroups.map((label, i) => (groups.has(i + 1) ? key(`cat-${i + 1}`, label) : '')),
      groups.has(0) ? key('cat-0', 'Other and replies only') : null,
      shown.some((n) => n.kind === 'prompt' && n.shade === undefined) ? key('swatch-unlinked', 'Unlinked') : null,
    ]);
  }

  // ---------- context timeline ----------
  function turnSpan(turnId) {
    const v = ui.view;
    const starts = v.prompts.filter((p) => p.turnId === turnId).map((p) => ms(p.ts));
    const calls = v.calls.filter((c) => c.turnId === turnId).map((c) => ms(c.ts));
    const all = [...starts, ...calls];
    return all.length ? [Math.min(...all), Math.max(...all)] : null;
  }

  function domain() {
    const v = ui.view;
    const times = [...v.calls.map((c) => ms(c.ts)), ...v.prompts.map((p) => ms(p.ts))];
    const full = [Math.min(...times), Math.max(...times)];
    if (Array.isArray(ui.zoom)) return ui.zoom;
    if (ui.zoom === 'all') return full;
    // Default: the selected turn, or the most recent turn, with padding.
    const turn = ui.selectedTurn || (v.prompts.length ? v.prompts[v.prompts.length - 1].turnId : null);
    const span = turn && turnSpan(turn);
    if (!span) return full;
    const pad = Math.max(60_000, (span[1] - span[0]) * 0.15);
    return [Math.max(full[0], span[0] - pad), Math.min(full[1], span[1] + pad)];
  }

  function renderTimeline() {
    const v = ui.view;
    expandBtn.textContent = ui.expanded ? '\u2921 Collapse' : '\u2922 Expand';
    if (v.calls.length === 0) {
      timelineHost.replaceChildren(el('p', { class: 'muted', text: 'No model calls with token usage in this session.' }));
      timelineNote.textContent = '';
      return;
    }
    const [t0, t1raw] = domain();
    const t1 = t1raw > t0 ? t1raw : t0 + 60_000;
    const width = Math.max(320, timelineHost.clientWidth || 800);
    const mainCalls = v.calls.filter((c) => !c.agentId);
    const ctxOf = (c) => c.input + c.cacheRead + c.cacheCreation;
    const markValues = Object.values(v.marks).flatMap((m) => [m.largestSeen, m.limit]).filter((x) => typeof x === 'number');
    const maxCtx = Math.max(1, ...mainCalls.map(ctxOf), ...markValues);
    const top = Math.pow(10, Math.floor(Math.log10(maxCtx))) * Math.ceil(maxCtx / Math.pow(10, Math.floor(Math.log10(maxCtx))));
    const m = { l: 52, r: 12, t: 22 };
    const ph = ui.expanded ? 260 : 150;
    const outH = ui.expanded ? 46 : 0;
    const lanes = ui.expanded ? v.subagents.length : 0;
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
    const sel = ui.selectedTurn && turnSpan(ui.selectedTurn);
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
          `${new Date(ts).toLocaleString()}${c.model ? ` \u00b7 ${modelShort(c.model)}` : ''}`,
          ['Prompt', c.turnId ? `P${(v.prompts.find((p) => p.turnId === c.turnId) || {}).index ?? '?'}` : '\u2014'],
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
        if (typeof val === 'number' && val <= top) markLines.push({ val, text: `${label} ${compact(val)} \u00b7 ${modelShort(model)}` });
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
        // Select the turn; the tree returns to the whole session with that prompt highlighted.
        ui.selectedTurn = p.turnId;
        ui.focusId = 's';
        render();
      };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
      g.addEventListener('mousemove', (e) => showTip(e, [`P${p.index} \u00b7 ${formatTime(p.ts)}`, ...(p.text ? [clip(p.text, 240)] : [])]));
      g.addEventListener('mouseleave', hideTip);
      root.append(g);
    }

    // Compactions.
    for (const c of v.compactions) {
      const ts = ms(c.ts);
      if (ts < t0 || ts > t1) continue;
      root.append(svg('line', { class: 'compaction-line', x1: x(ts), x2: x(ts), y1: m.t, y2: m.t + ph }));
      const t = svg('text', { class: 'axis-label', x: x(ts) + 4, y: m.t + ph - 6 });
      t.textContent = `\u2913 compacted${c.trigger === 'manual' ? ' (manual)' : ''}`;
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
      if (ui.expanded) {
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
    if (ui.expanded) {
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
        if (Math.abs(b - a) > 8) {
          ui.zoom = [toTime(Math.min(a, b)), toTime(Math.max(a, b))];
          renderTimeline();
        } else brush.setAttribute('hidden', '');
      });
    }

    timelineHost.replaceChildren(root);
    const subNote = v.subagents.length && !ui.expanded ? ` \u00b7 ${v.subagents.length} subagent lane${v.subagents.length > 1 ? 's' : ''} when expanded` : '';
    timelineNote.textContent = `Showing ${new Date(t0).toLocaleString()} \u2013 ${new Date(t1).toLocaleTimeString()}${ui.zoom === 'all' ? ' (whole session)' : ''}. Main agent's context only; subagents run in their own context.${subNote}`;
  }

  // ---------- wiring ----------
  // ---------- findings in this session ----------
  const findingState = (f) => (f.active ? 'Active now' : 'Earlier');
  function findingTip(f) {
    return [
      `\u25b2 ${f.heuristicId} (${f.severity === 'warn' ? 'warning' : 'info'})`,
      f.summary,
      ['State', findingState(f)],
      ['Started', formatTime(f.startedTs || f.fromTs)],
    ];
  }

  function showFinding(f) {
    // Select its turn (or zoom to its span) and bring the timeline into view.
    if (f.turnIds.length) {
      ui.selectedTurn = f.turnIds[0];
      ui.zoom = null;
    } else {
      const pad = 5 * 60 * 1000;
      ui.zoom = [ms(f.fromTs) - pad, ms(f.toTs || f.fromTs) + pad];
    }
    ui.focusId = 's';
    render();
    timelinePanel.scrollIntoView({ block: 'nearest' });
  }

  function renderFindings() {
    const list = ui.view.findings.filter((f) => f.fromTs);
    findingsSection.hidden = list.length === 0;
    if (!list.length) return findingsSection.replaceChildren();
    const turnLabel = (f) => f.turnIds.map((t) => ui.view.prompts.find((p) => p.turnId === t)).filter(Boolean).map((p) => `P${p.index}`).join(', ');
    findingsSection.replaceChildren(
      el('h2', { text: `Findings in this session (${list.length})` }),
      el('p', { class: 'muted small', text: 'Earlier findings are what the heuristics would have reported at the time, replayed with your current settings.' }),
      el('table', { class: 'findings-table' }, [
        el('thead', {}, [el('tr', {}, ['When', 'Heuristic', 'Severity', 'State', 'Turn', 'Summary', ''].map((h) => el('th', { text: h })))]),
        el(
          'tbody',
          {},
          list.map((f) =>
            el('tr', { class: f.active ? 'active' : 'past' }, [
              el('td', { class: 'nowrap', text: formatTime(f.startedTs || f.fromTs) }),
              el('td', { class: 'nowrap' }, [el('span', { class: `sev ${f.severity}`, text: '\u25b2 ' }), f.heuristicId]),
              el('td', { text: f.severity === 'warn' ? 'Warning' : 'Info' }),
              el('td', { text: findingState(f) }),
              el('td', { text: turnLabel(f) }),
              el('td', { text: f.summary }),
              el('td', { class: 'nowrap' }, [el('button', { class: 'link', text: 'Show', onclick: () => showFinding(f) })]),
            ])
          )
        ),
      ])
    );
  }

  function render() {
    renderList();
    const v = ui.view;
    sessionSection.hidden = !v;
    if (!v) return;
    if (!findNode(v.tree, ui.focusId)) ui.focusId = 's';
    sessionSection.classList.toggle('expanded', ui.expanded);
    renderCrumbs();
    renderTree();
    renderPromptPanel();
    renderTimeline();
    renderFindings();
  }

  window.addEventListener('message', (evt) => {
    const d = evt.data;
    if (!d) return;
    if (d.type === 'sessions') {
      ui.list = d.list;
      renderList();
    } else if (d.type === 'session') {
      const switched = !d.view || !ui.view || d.view.summary.sessionId !== ui.view.summary.sessionId;
      ui.view = d.view;
      if (switched) {
        ui.focusId = 's';
        ui.selectedTurn = null;
        ui.zoom = null;
      }
      render();
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => ui.view && render(), 150);
  });

  window.snagboatSessions = {
    shown() {
      if (!ui.list) vscode.postMessage({ type: 'listSessions' });
      if (!ui.view && saved.sessionId) vscode.postMessage({ type: 'openSession', sessionId: saved.sessionId });
    },
  };
})();
