// The compact findings panel (RFC step 5c): the findings now, each with its advisor and Useful, today's
// totals, and links to the advisor UI and the detail view. State comes whole from findingsView.ts;
// everything is written with textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    for (const c of children || []) if (c) e.append(c);
    return e;
  }
  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

  function finding(f) {
    const who = [f.advisor, f.held ? 'held back' : '', f.acknowledged && !f.useful ? 'acknowledged' : ''].filter(Boolean).join(' · ');
    let act;
    if (f.useful) act = el('span', { class: 'done', text: 'Useful' });
    else {
      act = el('button', { type: 'button', text: 'Useful', title: 'This finding helped; also acknowledges it' });
      act.addEventListener('click', () => {
        act.disabled = true;
        vscode.postMessage({ type: 'useful', heuristicId: f.heuristicId });
      });
    }
    return el('div', { class: 'finding' }, [
      el('span', { class: `sev ${f.severity}` }),
      el('div', { class: 'what' }, [el('b', { text: `${f.heuristicId}: ${f.summary}` }), who ? el('span', { text: who }) : null]),
      act,
    ]);
  }

  function render(s) {
    const link = (text, type) => {
      const a = el('button', { type: 'button', class: 'link', text });
      a.addEventListener('click', () => vscode.postMessage({ type }));
      return a;
    };
    const t = s.today;
    const today = [`Today ${compact(t.tokens)} tokens`, t.cacheRate !== undefined ? `${Math.round(t.cacheRate)}% cache` : '', `${t.milestones} milestone${t.milestones === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    root.replaceChildren(
      ...(s.findings.length ? s.findings.map(finding) : [el('p', { class: 'muted', text: 'No findings now.' })]),
      el('p', { class: 'muted small', text: today }),
      el('div', { class: 'links' }, [s.advisorUi ? link('Open the advisor UI ↗', 'openAdvisorUi') : null, link('Details', 'openDetail')])
    );
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data.state);
  });
  vscode.postMessage({ type: 'ready' });
})();
