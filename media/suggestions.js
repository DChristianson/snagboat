// Snagboat Suggestions tab: discovery's candidate rules, built-in thresholds
// against your history, shell sub-categories, and your saved rules. See
// docs/heuristics.md#discovery. Uses the helpers detail.js exposes on
// window.snagboat. Plain DOM; all data is written with textContent.
(function () {
  const S = window.snagboat;
  if (!S) return;
  const { vscode, el, compact, formatTime, suggestionsRoot } = S;

  let view = null;

  const percent = (share) => {
    const p = share * 100;
    return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
  };
  const value = (v, kind) => (kind === 'share' ? percent(v) : kind === 'tokens' ? compact(v) : String(v));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const short = (id) => id.slice(0, 8);

  // ---------- layout ----------
  const discoverBtn = el('button', { text: 'Discover again' });
  discoverBtn.addEventListener('click', () => vscode.postMessage({ type: 'discover' }));
  const status = el('p', { class: 'muted small' });
  const notes = el('div');
  const candidatesHost = el('div');
  const thresholdsHost = el('div');
  const shellHost = el('div');
  const savedHost = el('div');
  const dismissedNote = el('p', { class: 'muted small' });

  suggestionsRoot.append(
    el('section', { 'aria-label': 'Discovery' }, [
      el('div', { class: 'panel-head' }, [el('h2', { text: 'Suggested heuristics' }), el('span', { class: 'spacer' }), discoverBtn]),
      status,
      notes,
      candidatesHost,
      dismissedNote,
    ]),
    el('section', { 'aria-label': 'Built-in thresholds' }, [el('h2', { text: 'Built-in thresholds' }), thresholdsHost]),
    el('section', { 'aria-label': 'Shell sub-categories' }, [el('h2', { text: 'Shell sub-categories' }), shellHost]),
    el('section', { 'aria-label': 'Your rules' }, [el('h2', { text: 'Your rules' }), savedHost])
  );

  // ---------- rendering ----------
  const tweakTimers = {};
  function thresholdInput(c) {
    const asPercent = c.kind === 'share';
    const input = el('input', {
      type: 'number',
      class: 'threshold',
      id: `threshold-${c.id}`,
      min: asPercent ? 5 : 1,
      max: asPercent ? 100 : undefined,
      step: asPercent ? 5 : c.kind === 'tokens' ? 100000 : 1,
      'aria-label': `Threshold for ${c.title}`,
    });
    input.value = String(asPercent ? Math.round(c.threshold * 100) : c.threshold);
    input.addEventListener('input', () => {
      clearTimeout(tweakTimers[c.id]);
      tweakTimers[c.id] = setTimeout(() => {
        const n = Number(input.value);
        if (!(n > 0)) return;
        vscode.postMessage({ type: 'tweakSuggestion', id: c.id, threshold: asPercent ? n / 100 : n });
      }, 400);
    });
    return input;
  }

  function candidateCard(c) {
    const b = c.baseline;
    const overlaps = Object.entries(c.overlaps).map(([id, n]) => `${id} ${n}`);
    const tweaked = c.threshold !== c.proposedThreshold;
    return el('article', { class: 'finding info suggestion' }, [
      el('div', { class: 'head' }, [el('span', { class: 'badge info', text: 'rule' }), el('strong', { text: c.title }), el('span', { class: 'muted small', text: c.id })]),
      el('p', { class: 'summary' }, [
        'Turns with ',
        thresholdInput(c),
        ` or more ${c.describes}: ${percent(c.turnsAbove / b.turns)} of your turns (${c.turnsAbove} in ${plural(c.sessionsAbove, 'session')}).`,
        tweaked
          ? el('button', { class: 'link', text: ` Back to ${value(c.proposedThreshold, c.kind)}`, onclick: () => vscode.postMessage({ type: 'tweakSuggestion', id: c.id, threshold: c.proposedThreshold }) })
          : null,
      ]),
      el('p', { class: 'muted small', text: `Your median is ${value(b.p50, c.kind)}, 90th percentile ${value(b.p90, c.kind)}, 99th ${value(b.p99, c.kind)}, most ${value(b.max, c.kind)}.` }),
      el('p', {
        class: 'small',
        text: `Replay: ${plural(c.episodes, 'episode')} in ${plural(c.sessions, 'session')}. ${overlaps.length ? `Overlaps ${overlaps.join(', ')}.` : 'No overlap with your other heuristics.'}`,
      }),
      c.examples.length
        ? el('div', { class: 'chips small' }, [
            el('span', { class: 'muted', text: 'Where it would have fired:' }),
            ...c.examples.map((x) =>
              el('button', { class: 'link', text: x.name || short(x.sessionId), title: 'Open in Sessions with its past findings', onclick: () => vscode.postMessage({ type: 'openSession', sessionId: x.sessionId }) })
            ),
          ])
        : null,
      el('details', { class: 'small' }, [el('summary', { text: 'Rule' }), el('pre', { class: 'rule-json', text: JSON.stringify(c.rule, null, 2) })]),
      el('div', { class: 'actions' }, [
        el('button', { text: 'Accept', onclick: () => vscode.postMessage({ type: 'acceptSuggestion', id: c.id }) }),
        el('button', { text: 'Dismiss', onclick: () => vscode.postMessage({ type: 'dismissSuggestion', id: c.id }) }),
      ]),
    ]);
  }

  function renderDiscovery() {
    discoverBtn.disabled = view.status === 'running';
    discoverBtn.textContent = view.ranAt ? 'Discover again' : 'Discover';
    if (view.status === 'running') status.textContent = `Reading the last ${view.days} days of ${view.source}…`;
    else if (view.status === 'failed') status.textContent = `Discovery failed: ${view.error}`;
    else if (view.status === 'idle') status.textContent = `Discovery reads the last ${view.days} days of ${view.source} and suggests heuristics from what's unusual for you.`;
    else {
      const range = view.from ? `${S.formatDay(view.from.slice(0, 10))} to ${S.formatDay(view.to.slice(0, 10))}` : 'no history';
      status.textContent = `${view.source}, ${range}: ${plural(view.sessions, 'session')}, ${plural(view.turns, 'turn')}. Discovered ${formatTime(view.ranAt)}. Rules you accept apply in every workspace.`;
    }
    notes.replaceChildren(...view.notes.map((n) => el('p', { class: 'filter-note', text: n })));
    if (view.status === 'ready' && view.notes.length === 0 && view.candidates.length === 0) {
      candidatesHost.replaceChildren(el('p', { class: 'muted', text: 'Nothing stands out from your usual turns.' }));
    } else {
      candidatesHost.replaceChildren(...view.candidates.map(candidateCard));
    }
    dismissedNote.replaceChildren(
      ...(view.dismissed > 0
        ? [`${plural(view.dismissed, 'suggestion')} dismissed. `, el('button', { class: 'link', text: 'Show them again', onclick: () => vscode.postMessage({ type: 'clearDismissed' }) })]
        : [])
    );
  }

  function renderThresholds() {
    if (view.thresholds.length === 0) {
      thresholdsHost.replaceChildren(el('p', { class: 'muted small', text: view.status === 'ready' ? 'Not enough history to compare.' : '' }));
      return;
    }
    thresholdsHost.replaceChildren(
      el('table', {}, [
        el('thead', {}, el('tr', {}, ['Setting', 'Now', 'Your median', 'Your 99th', 'Suggested', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, view.thresholds.map((t) =>
          el('tr', {}, [
            el('td', { text: `${t.heuristic} ${t.setting}` }),
            el('td', { text: `${value(t.current, t.kind)} (${percent(t.currentShare)} of turns)` }),
            el('td', { text: value(t.baseline.p50, t.kind) }),
            el('td', { text: value(t.baseline.p99, t.kind) }),
            el('td', { text: t.suggested === undefined ? '—' : `${value(t.suggested, t.kind)} (${percent(t.suggestedShare)})` }),
            el('td', {}, t.suggested !== undefined && t.suggested !== t.current
              ? el('button', { text: 'Apply', title: 'Write the suggested value to your user settings', onclick: () => vscode.postMessage({ type: 'applyThreshold', heuristic: t.heuristic, setting: t.setting }) })
              : null),
          ])
        )),
      ])
    );
  }

  function renderShell() {
    const sh = view.shell;
    if (view.status !== 'ready') {
      shellHost.replaceChildren();
      return;
    }
    if (sh.candidates.length === 0) {
      shellHost.replaceChildren(el('p', { class: 'muted small', text: `${plural(sh.shellCalls, 'plain shell call')}; no command family takes a large share.` }));
      return;
    }
    shellHost.replaceChildren(
      el('p', { class: 'muted small', text: `${plural(sh.shellCalls, 'plain shell call')}. Accepted categories label new calls; ${percent(sh.leftShare)} would stay in Shell command.` }),
      ...sh.candidates.map((c) =>
        el('article', { class: 'finding info suggestion' }, [
          el('div', { class: 'head' }, [el('span', { class: 'badge info', text: 'category' }), el('strong', { text: c.label }), el('span', { class: 'muted small', text: c.id })]),
          el('p', { class: 'summary', text: `Commands starting with ${c.match.join(', ')}: ${percent(c.share)} of shell calls (${c.calls} in ${plural(c.sessions, 'session')}).` }),
          el('div', { class: 'actions' }, [
            el('button', { text: 'Accept', onclick: () => vscode.postMessage({ type: 'acceptShellCategory', id: c.id }) }),
            el('button', { text: 'Dismiss', onclick: () => vscode.postMessage({ type: 'dismissSuggestion', id: c.id }) }),
          ]),
        ])
      )
    );
  }

  function provenanceText(p) {
    if (!p) return 'Written in settings.';
    const by = { you: 'Added by you', discovery: 'Discovered', advisor: 'Proposed by the advisor', import: 'Imported' }[p.proposedBy] || p.proposedBy;
    const where = p.workspace ? ` in ${p.workspace}` : '';
    const replay = p.replay ? `; replay then: ${plural(p.replay.episodes, 'episode')} in ${plural(p.replay.sessions, 'session')}` : '';
    return `${by}${where}, ${formatTime(p.addedAt)}${replay}.`;
  }

  function renderSaved() {
    if (view.saved.length === 0) {
      savedHost.replaceChildren(el('p', { class: 'muted small', text: 'No rules yet. Accepted suggestions, imported rules (Snagboat: Import Rules), and rules in snagboat.rules show here.' }));
      return;
    }
    savedHost.replaceChildren(
      ...view.saved.map((s) =>
        el('div', { class: 'saved-rule' }, [
          el('div', { class: 'head' }, [el('strong', { text: s.title }), el('span', { class: 'muted small', text: `${s.section === 'rules' ? 'rule' : 'shell category'} ${s.id}` })]),
          el('p', { class: 'muted small', text: provenanceText(s.provenance) }),
          s.origin === 'saved'
            ? el('button', { text: 'Remove', onclick: () => vscode.postMessage({ type: 'removeSaved', section: s.section, id: s.id }) })
            : el('p', { class: 'muted small', text: 'Edit or remove it in settings.' }),
        ])
      )
    );
  }

  function render() {
    // A push re-renders the cards; keep the threshold being typed in focused.
    const active = document.activeElement;
    const focusId = active && active.classList && active.classList.contains('threshold') ? active.id : null;
    renderDiscovery();
    renderThresholds();
    renderShell();
    renderSaved();
    if (focusId) {
      const again = document.getElementById(focusId);
      if (again) again.focus();
    }
  }

  window.addEventListener('message', (evt) => {
    if (evt.data && evt.data.type === 'suggestions') {
      view = evt.data.view;
      render();
    }
  });
})();
