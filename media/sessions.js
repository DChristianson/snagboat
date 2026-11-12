// Snagboat Sessions tab: a session list, then one session as a turn tree
// (icicle) above a context timeline. See docs/design/conversation-view.md.
// The two drawings are media/drawings/turnTree.js and contextTimeline.js;
// this file is the tab's chrome around them: the list, breadcrumb, buttons, prompt panel, and findings
// table, with its own focus and selected turn mapped onto the shared
// selection. Uses the helpers detail.js exposes on window.snagboat. Plain
// DOM; all data is written with textContent, never innerHTML.
(function () {
  const S = window.snagboat;
  const drawings = window.snagboatDrawings;
  if (!S || !drawings) return;
  const { vscode, el, compact, fmt, formatTime, clip, persist, sessionsRoot, showTip, hideTip, ms, short, duration, agentName, modelShort, findNode, pathTo } = S;
  const saved = vscode.getState() || {};

  const ui = {
    list: null, // { day, days, sessions }
    view: null, // SessionView
    focusId: 's', // tree node shown at full width
    selectedTurn: null,
    expanded: !!saved.sessionExpanded,
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
  // Explain asks the advisor (a model you configure); it shows what it will send before the first request.
  const explain = (extra) => vscode.postMessage({ type: 'explain', sessionId: ui.view.summary.sessionId, ...(extra || {}) });
  const explainBtn = el('button', { text: 'Explain session', title: 'Ask the advisor model what happened in this session' });
  explainBtn.addEventListener('click', () => explain());
  const tacticsBtn = el('button', { text: 'Tactics', title: 'Ask the advisor model whether the models used fit each turn, and whether a different way of prompting would have cost less' });
  tacticsBtn.addEventListener('click', () => vscode.postMessage({ type: 'tactics', sessionId: ui.view.summary.sessionId }));
  const promptPanel = el('section', { class: 'prompt-panel', 'aria-label': 'Prompt', hidden: true });
  const treeHost = el('div', { class: 'tree-host' });
  const expandBtn = el('button', {});
  expandBtn.addEventListener('click', () => {
    ui.expanded = !ui.expanded;
    persist({ sessionExpanded: ui.expanded });
    render();
  });
  const wholeBtn = el('button', { text: 'Show whole session' });
  wholeBtn.addEventListener('click', () => timeline.zoomAll());
  const timelineHost = el('div', { class: 'timeline-host' });
  const timelinePanel = el('section', { class: 'timeline-panel', 'aria-label': 'Context timeline' }, [
    el('div', { class: 'panel-head' }, [el('strong', { text: 'Context timeline' }), el('span', { class: 'spacer' }), wholeBtn, expandBtn]),
    timelineHost,
  ]);
  const findingsSection = el('section', { class: 'session-findings', 'aria-label': 'Findings in this session' });
  const sessionSection = el('section', { class: 'session-view', hidden: true }, [
    el('div', { class: 'session-head' }, [crumbs, el('span', { class: 'spacer' }), explainBtn, tacticsBtn, closeBtn]),
    sessionMeta,
    treeHost,
    promptPanel,
    timelinePanel,
    findingsSection,
  ]);
  sessionsRoot.append(listSection, sessionSection);

  // ---------- the two drawings ----------
  // A tree click carries its focus; a prompt rule doesn't, and returns the
  // tree to the whole session with that prompt highlighted.
  function onSelect(sel) {
    ui.selectedTurn = sel.turnId || null;
    ui.focusId = sel.focusId || 's';
    if (sel.focusId) timeline.zoomTo(null);
    render();
  }
  const ctx = { ...window.snagboatKit, showTip, hideTip, select: onSelect };
  const tree = drawings.turnTree(treeHost, ctx);
  const timeline = drawings.contextTimeline(timelineHost, ctx);

  // ---------- helpers ----------
  const isLive = (s) => Date.now() - ms(s.lastTs) < 10 * 60 * 1000;

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
        el('td', { text: `${isLive(s) ? '● ' : ''}${new Date(s.firstTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` }),
        el('td', { text: agentName(s.agent) }),
        el('td', { text: s.models.map(modelShort).join(', ') || '—' }),
        el('td', { class: 'num', text: fmt(s.prompts) }),
        el('td', { class: 'num', text: fmt(s.modelCalls) }),
        el('td', { class: 'num', text: compact(s.tokens) }),
        el('td', { class: 'num', text: duration(s.firstTs, s.lastTs) }),
        el('td', { title: s.name ? `${s.name} (${s.sessionId})` : s.sessionId }, [
          ...(s.name ? [el('span', { text: clip(s.name, 48) }), el('span', { class: 'muted', text: ` ${short(s.sessionId)}` })] : [el('span', { class: 'muted', text: short(s.sessionId) })]),
          // The advisor's headline, model output, under the name.
          list.headlines && list.headlines[s.sessionId] ? el('div', { class: 'muted small', text: clip(list.headlines[s.sessionId], 90), title: `Headline by the advisor (model output): ${list.headlines[s.sessionId]}` }) : null,
        ]),
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
      items.push(el('span', { class: 'muted', text: ' › ' }));
      const label = node.kind === 'session' ? sessionLabel(v.summary) : node.label;
      items.push(
        i === path.length - 1
          ? el('span', { text: label })
          : el('button', { class: 'link', text: label, onclick: () => tree.focus(node.id) })
      );
    });
    crumbs.replaceChildren(...items);
    const s = v.summary;
    sessionMeta.textContent = `${agentName(s.agent)} · ${s.models.map(modelShort).join(', ')} · ${fmt(s.prompts)} prompts · ${fmt(s.modelCalls)} model calls · ${fmt(s.toolCalls)} tool calls · ${compact(s.tokens)} tokens${s.subagents ? ` · ${s.subagents} subagents` : ''}${isLive(s) ? ' · live' : ''}${v.headline ? ` · advisor: ${v.headline}` : ''}`;
  }

  const sessionLabel = (s) => (s.name ? clip(s.name, 60) : short(s.sessionId));

  // The selected turn's prompt text, when it was captured (several messages can share a turn).
  function renderPromptPanel() {
    const v = ui.view;
    const messages = ui.selectedTurn ? v.prompts.filter((p) => p.turnId === ui.selectedTurn) : [];
    promptPanel.hidden = messages.length === 0;
    if (!messages.length) return promptPanel.replaceChildren();
    promptPanel.replaceChildren(
      el('div', { class: 'prompt-head' }, [
        el('strong', { text: `P${messages[0].index}` }),
        el('span', { class: 'muted small', text: ` ${formatTime(messages[0].ts)}` }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'link', text: 'Explain turn', title: 'Ask the advisor model what happened in this turn', onclick: () => explain({ turnId: messages[0].turnId }) }),
      ]),
      ...messages.map((p) => el('p', { class: p.text ? 'prompt-text' : 'prompt-text muted', text: p.text || 'Prompt text wasn’t captured for this turn (text capture was off, or it’s past text retention).' }))
    );
  }

  // ---------- findings in this session ----------
  const findingState = (f) => (f.active ? 'Active now' : 'Earlier');

  function showFinding(f) {
    // Select its turn (or zoom to its span) and bring the timeline into view.
    if (f.turnIds.length) {
      ui.selectedTurn = f.turnIds[0];
      timeline.zoomTo(null);
    } else {
      const pad = 5 * 60 * 1000;
      timeline.zoomTo([ms(f.fromTs) - pad, ms(f.toTs || f.fromTs) + pad]);
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
              el('td', { class: 'nowrap' }, [el('span', { class: `sev ${f.severity}`, text: '▲ ' }), f.heuristicId]),
              el('td', { text: f.severity === 'warn' ? 'Warning' : 'Info' }),
              el('td', { text: findingState(f) }),
              el('td', { text: turnLabel(f) }),
              el('td', { text: f.summary }),
              el('td', { class: 'nowrap' }, [
                el('button', { class: 'link', text: 'Show', onclick: () => showFinding(f) }),
                ' ',
                el('button', { class: 'link', text: 'Explain', title: 'Ask the advisor model about this finding', onclick: () => explain({ heuristicId: f.heuristicId, ...(f.turnIds[0] ? { turnId: f.turnIds[0] } : {}) }) }),
              ]),
            ])
          )
        ),
      ])
    );
  }

  // ---------- wiring ----------
  function render() {
    renderList();
    const v = ui.view;
    sessionSection.hidden = !v;
    if (!v) return;
    if (!findNode(v.tree, ui.focusId)) ui.focusId = 's';
    sessionSection.classList.toggle('expanded', ui.expanded);
    expandBtn.textContent = ui.expanded ? '⤡ Collapse' : '⤢ Expand';
    renderCrumbs();
    const selection = { sessionId: v.summary.sessionId, turnId: ui.selectedTurn || undefined, focusId: ui.focusId };
    tree.update([v], selection, { expanded: ui.expanded });
    renderPromptPanel();
    timeline.update([v], selection, { expanded: ui.expanded });
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
