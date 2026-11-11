// The advisor UI (RFC step 5a, as revised in the design pass), served by the
// core at /ui/. Plain script, no framework. It exchanges the one-time code in
// the address's fragment for a key kept in this tab, then reads the core's
// API. Every value from the core goes into the page as text, never as markup.
//
// Two views: the advisors (a card each, holding its brief and the finding it
// has to surface, with Useful / Acknowledge / Mute), and one advisor's page
// (its measures, chart, rules and voice), at #advisor=<id>.
(function () {
  'use strict';

  const TOKEN_KEY = 'snagboat.ui.token';
  // The workspace shown, kept in this tab rather than the address, so local paths stay out of history.
  const WORKSPACE_KEY = 'snagboat.ui.workspace';
  const REFRESH_MS = 60_000;
  const $ = (id) => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';

  function remember(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // no session storage: forgotten on reload
    }
  }
  function recall(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function forget(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // nothing stored
    }
  }

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
  function svg(tag, attrs, parent) {
    const e = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.append(e);
    return e;
  }

  // --- The fragment: #<one-time code> when opened from Snagboat; then #days=…[&advisor=…] ----------
  const CODE = /^#([A-Za-z0-9_-]{20,})$/;
  function fragment() {
    return new URLSearchParams(CODE.test(location.hash) ? '' : location.hash.replace(/^#/, ''));
  }
  function setFragment(params) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${new URLSearchParams(params).toString()}`);
  }

  // --- Talking to the core ------------------------------------------------------
  let token = recall(TOKEN_KEY);
  class Unauthorized extends Error {}
  class Refused extends Error {}

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Unauthorized(body.error || 'unauthorized');
    if (res.status === 409) throw new Refused(body.error || 'refused');
    if (!res.ok) throw new Error(body.error || `the core answered ${res.status}`);
    return body;
  }

  async function signIn() {
    const m = CODE.exec(location.hash);
    if (!m) return;
    setFragment({}); // the code is used once; don't leave it in the address or history
    const { token: t, workspace } = await api('/ui-session', { method: 'POST', body: JSON.stringify({ code: m[1] }) });
    token = t;
    remember(TOKEN_KEY, t);
    if (workspace) remember(WORKSPACE_KEY, workspace);
  }

  function showMessage(title, lines) {
    $('message').replaceChildren(el('b', { text: title }), ...lines.map((l) => (typeof l === 'string' ? el('span', { text: l }) : l)));
    $('message').hidden = false;
  }
  function needLink(reason) {
    forget(TOKEN_KEY);
    token = null;
    showMessage(reason, [el('span', {}, ['Open it again from a terminal with ', el('code', { text: 'snagboat open' }), ', or in VS Code with ', el('b', { text: 'Snagboat: Open Advisor UI' }), '. Each link works once.'])]);
    setStatus('down', 'Not connected');
  }
  function setStatus(kind, text) {
    $('status').className = `status ${kind}`;
    $('status').textContent = text;
  }

  // --- Advisors' look: persona.md's cue (icon and color) ------------------------------
  const GLYPHS = {
    coin: [['circle', { cx: 9, cy: 9, r: 6.5, class: 'line' }], ['path', { d: 'M9 5.5v7M6.8 7.2h3.4a1.4 1.4 0 0 1 0 2.8H7.8a1.4 1.4 0 0 0 0 2.8H11', class: 'line' }]],
    compass: [['circle', { cx: 9, cy: 9, r: 6.5, class: 'line' }], ['path', { d: 'M11.8 6.2 10 10 6.2 11.8 8 8z', class: 'solid' }]],
    anchor: [['circle', { cx: 9, cy: 4, r: 1.6, class: 'line' }], ['path', { d: 'M9 5.6V15M5.5 8h7M3.5 11a5.5 5 0 0 0 11 0', class: 'line' }]],
    telescope: [['path', { d: 'M3 11.5 12.5 6l1.5 2.6-9.5 5.5z', class: 'line' }], ['path', { d: 'M8.5 11 7 16M9 11l3 5', class: 'line' }]],
    default: [['circle', { cx: 9, cy: 9, r: 6.5, class: 'line' }]],
  };
  const COLORS = { amber: true, blue: true, red: true, teal: true };
  function cueOf(a) {
    return [a.cue && GLYPHS[a.cue.icon] ? a.cue.icon : 'default', a.cue && COLORS[a.cue.color] ? a.cue.color : 'default'];
  }
  function glyph(name, size = 18) {
    const s = svg('svg', { width: size, height: size, viewBox: '0 0 18 18', 'aria-hidden': 'true' });
    for (const [tag, attrs] of GLYPHS[name] || GLYPHS.default) svg(tag, attrs, s);
    return s;
  }
  function paint(node, a) {
    node.style.setProperty('--cue', `var(--cue-${cueOf(a)[1]})`);
  }

  // --- Numbers ---------------------------------------------------------------------------------------
  function format(value, unit) {
    if (value === undefined || value === null) return '—';
    const abs = Math.abs(value);
    let n;
    if (unit === 'tokens' && abs >= 1e6) n = `${(value / 1e6).toFixed(1)}M`;
    else if (unit === 'tokens' && abs >= 1e4) n = `${Math.round(value / 1e3)}k`;
    else n = abs >= 100 ? Math.round(value).toLocaleString('en-US') : String(Math.round(value * 10) / 10);
    if (unit === '%') return `${n}%`;
    if (unit === 'min') return `${n} min`;
    return n;
  }
  function delta(m) {
    if (m.value === undefined || m.previous === undefined) return { text: m.value === undefined ? '' : 'new', cls: 'none' };
    if (m.trend === 'same') return { text: 'same', cls: 'same' };
    const diff = m.value - m.previous;
    if (m.unit === '%' || m.previous === 0) return { text: `${diff > 0 ? '+' : '−'}${format(Math.abs(diff), m.unit === '%' ? '' : m.unit)}`, cls: m.trend };
    return { text: `${diff > 0 ? '+' : '−'}${Math.round((Math.abs(diff) / Math.abs(m.previous)) * 100)}%`, cls: m.trend };
  }
  function sparkline(series) {
    const values = (series || []).map((v) => (v === null ? null : Number(v)));
    const known = values.filter((v) => v !== null);
    if (known.length < 2) return el('span');
    const w = 56, h = 18, pad = 2;
    const min = Math.min(...known), max = Math.max(...known);
    const x = (i) => pad + (i * (w - 2 * pad)) / (values.length - 1);
    const y = (v) => (max === min ? h / 2 : h - pad - ((v - min) * (h - 2 * pad)) / (max - min));
    const s = svg('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': `daily values, last ${values.length} days` });
    svg('polyline', { points: values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ') }, s);
    const last = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
    svg('circle', { cx: x(last), cy: y(values[last]), r: 2 }, s);
    return s;
  }

  // --- Responding to a finding --------------------------------------------------------------
  const DONE = { useful: 'Marked useful', acknowledge: 'Acknowledged', mute: 'Muted' };
  /** Responses made in this tab, so the card says so until the finding clears. */
  const responded = new Map();
  function responses(finding) {
    const key = `${state.workspace}\n${finding.heuristicId}`;
    const box = el('div', { class: 'acts' });
    const done = responded.get(key);
    if (done) {
      box.append(el('span', { class: 'done', text: DONE[done] }));
      return box;
    }
    const buttons = [
      el('button', { class: 'btn', type: 'button', text: 'Useful', title: 'This finding helped; also hides it until it clears' }),
      el('button', { class: 'btn', type: 'button', text: 'Acknowledge', title: 'Hide it from the status bar until it clears' }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Mute', title: 'Hide this heuristic in this workspace until unmuted' }),
    ];
    ['useful', 'acknowledge', 'mute'].forEach((response, i) => {
      buttons[i].addEventListener('click', async () => {
        for (const b of buttons) b.disabled = true;
        try {
          await api('/findings/respond', { method: 'POST', body: JSON.stringify({ workspace: state.workspace, heuristicId: finding.heuristicId, response }) });
          responded.set(key, response);
          box.replaceChildren(el('span', { class: 'done', text: DONE[response] }));
        } catch (err) {
          for (const b of buttons) b.disabled = false;
          if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
          const note = box.querySelector('.err') || el('span', { class: 'err' });
          note.textContent = err.message;
          box.append(note);
        }
      });
    });
    box.append(...buttons);
    return box;
  }

  // --- The advisors view --------------------------------------------------------------------------------
  function surfaceLine(s) {
    const dd = el('dd', {}, [el('span', { class: `surf ${s.kind}`, text: s.label })]);
    if (s.finding) {
      dd.append(el('b', { text: `${s.finding.heuristicId}: ` }), document.createTextNode(s.finding.summary));
      if (s.text) dd.append(document.createTextNode(` ${s.text}`));
      dd.append(responses(s.finding));
    } else if (s.text) dd.append(document.createTextNode(s.text));
    return dd;
  }
  function aheadLine(ahead) {
    const parts = [];
    if (ahead.inProgress.length) parts.push(el('b', { text: 'Now: ' }), document.createTextNode(`${ahead.inProgress.map((b) => `${b.id} "${b.title}"`).join(', ')}. `));
    if (ahead.next) parts.push(el('b', { text: 'Next: ' }), document.createTextNode(`${ahead.next.id} "${ahead.next.title}" (ready). `));
    if (ahead.firstBlocked) parts.push(el('b', { text: 'Blocked: ' }), document.createTextNode(`${ahead.blocked}, first ${ahead.firstBlocked.id}${ahead.firstBlocked.blockedBy.length ? ` waiting on ${ahead.firstBlocked.blockedBy.join(', ')}` : ''}. `));
    parts.push(document.createTextNode(`${ahead.closedThisWeek} closed this week.`));
    return el('dd', {}, [el('span', { class: 'surf source', text: 'beads' }), ...parts]);
  }

  function advisorCard(a) {
    const card = el('article', { class: 'adv', 'aria-label': a.name });
    paint(card, a);
    const max = a.notify && a.notify.maxPerHour;
    const used = (a.notify && a.notify.lastHour) || 0;
    const cap = max === undefined ? 'no notification limit' : max === 0 ? 'never notifies' : `${used} of ${max} this hour`;
    card.append(
      el('div', { class: 'adv-head' }, [
        el('span', { class: 'glyph' }, [glyph(cueOf(a)[0])]),
        el('div', { class: 'who' }, [el('b', { text: a.name }), el('span', { class: 'status-line', text: a.status, title: `goal: ${a.goal}` })]),
        el('span', { class: `cap${max > 0 && used >= max ? ' full' : ''}`, text: cap }),
      ])
    );
    const b = a.brief;
    if (b) {
      const dl = el('dl');
      if (b.ahead) dl.append(el('dt', { text: 'Ahead' }), aheadLine(b.ahead));
      if (b.watching) dl.append(el('dt', { text: 'Watching' }), el('dd', { text: b.watching }));
      dl.append(el('dt', { text: 'To surface' }), surfaceLine(b.surface));
      card.append(el('div', { class: 'brief' }, [el('p', { class: 'sum', text: b.summary }), dl]));
    }
    const open = el('a', { href: `#${new URLSearchParams({ days: String(state.days), advisor: a.id }).toString()}`, text: 'Measures and detail' });
    card.append(el('div', { class: 'adv-foot' }, [el('span', { text: `${a.source === 'built-in' ? 'built in' : 'your persona.md'} · no model` }), open]));
    return card;
  }

  /** One row per heuristic (responses apply to a heuristic, not one finding), its worst finding first. */
  function findingRow(group) {
    const f = group.find((x) => x.severity === 'warn') || group[0];
    const more = group.length > 1 ? ` (and ${group.length - 1} more)` : '';
    return el('div', { class: 'finding' }, [
      el('span', { class: `sev ${f.severity}` }),
      el('div', { class: 'what' }, [el('b', { text: `${f.heuristicId}: ${f.summary}${more}` }), f.suggestedAction ? el('span', { text: f.suggestedAction }) : null, responses(f)]),
      el('span'),
    ]);
  }
  function byHeuristic(findings) {
    const groups = new Map();
    for (const f of findings) groups.set(f.heuristicId, [...(groups.get(f.heuristicId) || []), f]);
    return [...groups.values()];
  }

  async function renderAdvisors() {
    const q = `workspace=${encodeURIComponent(state.workspace)}`;
    const [data, findings] = await Promise.all([api(`/advisors?${q}&days=${state.days}&series=1`), api(`/findings?${q}`).catch(() => [])]);
    state.advisors = data.advisors;
    const add = el('button', { class: 'adv-add', type: 'button', disabled: 'disabled', title: 'Adding an advisor comes with the next step', 'aria-label': 'Add an advisor (coming with the next step)', text: '+' });
    $('advisors').replaceChildren(...data.advisors.map(advisorCard), add);
    $('count-advisors').textContent = String(data.advisors.length);
    // Findings no advisor speaks for still show, below the cards.
    const claimed = new Set(data.advisors.flatMap((a) => a.notify.rules || []));
    const others = ((findings[0] && findings[0].findings) || []).filter((f) => !claimed.has(f.heuristicId));
    $('others').hidden = others.length === 0;
    $('other-findings').replaceChildren(...byHeuristic(others).map(findingRow));
    showProblems(data.problems);
  }

  // --- One advisor's page ----------------------------------------------------------------------------------
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function weekLabels(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 7 * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    return out;
  }
  function chart(host, series, unit, labels) {
    host.replaceChildren();
    const values = series.map((v) => (v === null ? null : Number(v)));
    const known = values.filter((v) => v !== null);
    if (known.length < 2) {
      host.append(el('p', { class: 'small muted', text: 'Not enough weeks with something to measure yet.' }));
      return;
    }
    const W = 460, H = 200, L = 52, R = 14, T = 16, B = 28;
    const top = niceMax(Math.max(...known));
    const x = (i) => L + (i * (W - L - R)) / (values.length - 1);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `by week: ${values.map((v) => format(v, unit)).join(', ')}` }, host);
    for (let k = 0; k <= 4; k++) {
      const v = (top * k) / 4;
      svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, s);
      svg('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, s).textContent = format(v, unit);
    }
    labels.forEach((label, i) => {
      if ((labels.length - 1 - i) % 2 !== 0) return; // every other week, ending on this one
      svg('text', { x: x(i), y: H - 8, 'text-anchor': i === labels.length - 1 ? 'end' : i === 0 ? 'start' : 'middle', class: 'tick' }, s).textContent = label;
    });
    const pts = values.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean);
    svg('path', { d: `M${pts[0][0]},${y(0)} ${pts.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${pts[pts.length - 1][0]},${y(0)} Z`, class: 'area' }, s);
    svg('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'line' }, s);
    const last = pts[pts.length - 1];
    svg('circle', { cx: last[0], cy: last[1], r: 3.5, class: 'dot' }, s);
    svg('text', { x: last[0] - 6, y: Math.max(T + 10, last[1] - 8), 'text-anchor': 'end', class: 'end' }, s).textContent = format(known[known.length - 1], unit);
  }

  async function renderAdvisor(id) {
    const q = `workspace=${encodeURIComponent(state.workspace)}`;
    const [daily, weekly] = await Promise.all([api(`/advisors?${q}&days=${state.days}&series=1`), api(`/advisors?${q}&days=7&weeks=8`)]);
    const a = daily.advisors.find((x) => x.id === id);
    if (!a) {
      setFragment({ days: String(state.days) });
      showView('advisors');
      return renderAdvisors();
    }
    paint($('view-advisor'), a);
    $('detail-glyph').replaceChildren(glyph(cueOf(a)[0], 22));
    $('advisor-h').textContent = a.name;
    $('detail-status').textContent = a.status;
    $('detail-meta').textContent = `goal ${a.goal} · ${a.source === 'built-in' ? 'built in' : 'your persona.md'} · version ${a.version}`;
    // The first measure with something to show, by week.
    const w = weekly.advisors.find((x) => x.id === id);
    const first = (w ? w.measures : []).find((m) => !m.note && (m.series || []).filter((v) => v !== null).length >= 2);
    $('chart-h').textContent = first ? `${first.label}, last 8 weeks` : 'By week';
    if (first) chart($('chart'), first.series, first.unit, weekLabels(first.series.length));
    else $('chart').replaceChildren(el('p', { class: 'small muted', text: 'Not enough weeks with something to measure yet.' }));
    $('chart-note').textContent = first ? `${first.better === 'lower' ? 'Lower' : 'Higher'} is better.` : '';
    const max = a.notify.maxPerHour;
    $('speaks').replaceChildren(
      el('dt', { text: 'Rules' }),
      el('dd', { class: 'mono small', text: (a.notify.rules || []).join(' · ') || 'none' }),
      el('dt', { text: 'Notifies' }),
      el('dd', { text: max === undefined ? 'no limit' : max === 0 ? 'never' : `at most ${max} an hour · ${a.notify.lastHour || 0} this hour` }),
      el('dt', { text: 'Model' }),
      el('dd', { text: 'none: it measures and surfaces without one' })
    );
    $('voice').textContent = a.voice || '';
    $('measures-note').textContent = `· last ${state.days} days against the ${state.days} before`;
    $('detail-measures').replaceChildren(
      ...a.measures.map((m) => {
        if (m.note) return el('div', { class: 'm notyet' }, [el('span', { text: m.label }), el('span', { class: 'note', text: m.note })]);
        const d = delta(m);
        return el('div', { class: `m${m.value === undefined ? ' notyet' : ''}` }, [
          el('span', { text: m.label }),
          el('span', { class: 'v', text: m.value === undefined ? 'nothing yet' : format(m.value, m.unit) }),
          el('span', { class: `d ${d.cls}`, text: d.text, title: m.previous === undefined ? '' : `before: ${format(m.previous, m.unit)}` }),
          sparkline(m.series),
        ]);
      })
    );
    showProblems(daily.problems);
  }

  function showProblems(problems) {
    $('problems').hidden = !problems || problems.length === 0;
    $('problems').textContent = problems && problems.length ? `Problems in your advisors' persona.md files: ${problems.join('; ')}` : '';
  }
  function showView(name) {
    $('view-advisors').hidden = name !== 'advisors';
    $('view-advisor').hidden = name !== 'advisor';
  }

  // --- The page ------------------------------------------------------------------------
  const state = { workspace: null, days: 7, advisors: [] };

  async function loadWorkspaces() {
    const list = await api('/workspaces');
    const name = (w) => (w.folder ? `${w.folder.split(/[\\/]/).filter(Boolean).pop()} · ${w.folder}` : w.workspace);
    $('workspace').replaceChildren(...list.map((w) => el('option', { value: w.workspace, text: name(w) })));
    if (list.length === 0) {
      showMessage('No workspaces recorded yet', ['The core records a workspace once it has its first events: start an agent session in a project, then reload this page.']);
      return false;
    }
    const wanted = recall(WORKSPACE_KEY);
    state.workspace = list.some((w) => w.workspace === wanted) ? wanted : list[0].workspace;
    $('workspace').value = state.workspace;
    return true;
  }

  async function refresh() {
    try {
      const health = await api('/health');
      setStatus('ok', `core ${health.version}`);
      remember(WORKSPACE_KEY, state.workspace);
      const advisor = fragment().get('advisor');
      showView(advisor ? 'advisor' : 'advisors');
      if (advisor) await renderAdvisor(advisor);
      else await renderAdvisors();
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core: the core restarted, or the link was already used.');
      setStatus('down', 'The core is not answering');
    }
  }

  function home(e) {
    e.preventDefault();
    setFragment({ days: String(state.days) });
    void refresh();
  }

  async function start() {
    const days = Number(fragment().get('days'));
    if ([7, 14, 30].includes(days)) state.days = days;
    $('days').value = String(state.days);
    try {
      await signIn();
    } catch (err) {
      return needLink(err.message || 'That link has expired or was already used.');
    }
    if (!token) return needLink('Open the advisor UI from Snagboat to connect it to the core.');
    try {
      if (!(await loadWorkspaces())) return;
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core: the core restarted, or the link was already used.');
      return showMessage('The core is not answering', [String(err.message || err)]);
    }
    if (!fragment().get('days')) setFragment({ days: String(state.days) });
    $('workspace').addEventListener('change', () => {
      state.workspace = $('workspace').value;
      responded.clear();
      void refresh();
    });
    $('days').addEventListener('change', () => {
      state.days = Number($('days').value);
      setFragment({ ...Object.fromEntries(fragment()), days: String(state.days) });
      void refresh();
    });
    $('back').addEventListener('click', home);
    $('nav-advisors').addEventListener('click', home);
    window.addEventListener('hashchange', () => void refresh());
    await refresh();
    setInterval(refresh, REFRESH_MS);
  }

  void start();
})();
