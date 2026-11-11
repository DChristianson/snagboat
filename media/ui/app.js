// The advisor UI (RFC step 5a), served by the core at /ui/. Plain script, no
// framework: it exchanges the one-time code in the address's fragment for a
// read-only token (kept in this tab only), then reads the core's API. Every
// value from the core goes into the page as text, never as markup.
(function () {
  'use strict';

  const TOKEN_KEY = 'snagboat.ui.token';
  // The workspace shown, kept in this tab rather than the address, so local paths stay out of history.
  const WORKSPACE_KEY = 'snagboat.ui.workspace';
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
  const REFRESH_MS = 60_000;
  const $ = (id) => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';

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

  // --- The fragment: #<one-time code> when opened from Snagboat; then #days=… ---------------------
  const CODE = /^#([A-Za-z0-9_-]{20,})$/;
  function fragment() {
    return new URLSearchParams(CODE.test(location.hash) ? '' : location.hash.replace(/^#/, ''));
  }
  function setFragment(params) {
    const p = new URLSearchParams(params);
    history.replaceState(null, '', `${location.pathname}${location.search}#${p.toString()}`);
  }

  // --- Talking to the core ------------------------------------------------------
  let token = null;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }

  class Unauthorized extends Error {}

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (res.status === 401) throw new Unauthorized((await res.json().catch(() => ({}))).error || 'unauthorized');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `the core answered ${res.status}`);
    return res.json();
  }

  async function signIn() {
    const m = CODE.exec(location.hash);
    if (!m) return;
    const code = m[1];
    setFragment({}); // the code is used once; don't leave it in the address or history
    const { token: t, workspace } = await api('/ui-session', { method: 'POST', body: JSON.stringify({ code }) });
    token = t;
    if (workspace) remember(WORKSPACE_KEY, workspace);
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      // no session storage: the token lasts as long as the page
    }
  }

  function showMessage(title, lines) {
    const box = $('message');
    box.replaceChildren(el('b', { text: title }), ...lines.map((l) => (typeof l === 'string' ? el('span', { text: l }) : l)));
    box.hidden = false;
  }
  function needLink(reason) {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // nothing stored
    }
    token = null;
    const how = el('span', {}, ['Open it again from a terminal with ', el('code', { text: 'snagboat open' }), ', or in VS Code with ', el('b', { text: 'Snagboat: Open Advisor UI' }), '. Each link works once.']);
    showMessage(reason, [how]);
    setStatus('down', 'Not connected');
  }
  function setStatus(kind, text) {
    const s = $('status');
    s.className = `status ${kind}`;
    s.textContent = text;
  }

  // --- Advisors ----------------------------------------------------------------------
  const GLYPHS = {
    coin: [['circle', { cx: 9, cy: 9, r: 6.5, class: 'line' }], ['path', { d: 'M9 5.5v7M6.8 7.2h3.4a1.4 1.4 0 0 1 0 2.8H7.8a1.4 1.4 0 0 0 0 2.8H11', class: 'line' }]],
    compass: [['circle', { cx: 9, cy: 9, r: 6.5, class: 'line' }], ['path', { d: 'M11.8 6.2 10 10 6.2 11.8 8 8z', class: 'solid' }]],
    anchor: [['circle', { cx: 9, cy: 4, r: 1.6, class: 'line' }], ['path', { d: 'M9 5.6V15M5.5 8h7M3.5 11a5.5 5 0 0 0 11 0', class: 'line' }]],
    telescope: [['path', { d: 'M3 11.5 12.5 6l1.5 2.6-9.5 5.5z', class: 'line' }], ['path', { d: 'M8.5 11 7 16M9 11l3 5', class: 'line' }]],
    default: [['circle', { cx: 9, cy: 9, r: 6.5, class: 'line' }]],
  };
  function glyph(name) {
    const s = svg('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true' });
    for (const [tag, attrs] of GLYPHS[name] || GLYPHS.default) svg(tag, attrs, s);
    return s;
  }
  const CUES = { amber: 'amber', blue: 'blue', red: 'red', teal: 'teal' };
  /** An advisor's icon and color: its persona.md cue, when Snagboat has that icon and color; else the default. */
  function cueOf(a) {
    const icon = a.cue && GLYPHS[a.cue.icon] ? a.cue.icon : 'default';
    const color = a.cue && CUES[a.cue.color] ? a.cue.color : 'default';
    return [icon, color];
  }

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
    const diff = m.value - m.previous;
    if (m.trend === 'same') return { text: 'same', cls: 'same' };
    if (m.unit === '%' || m.previous === 0) return { text: `${diff > 0 ? '+' : '−'}${format(Math.abs(diff), m.unit === '%' ? '' : m.unit)}`, cls: m.trend };
    const pct = Math.round((Math.abs(diff) / Math.abs(m.previous)) * 100);
    return { text: `${diff > 0 ? '+' : '−'}${pct}%`, cls: m.trend };
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
    const pts = values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
    svg('polyline', { points: pts }, s);
    const last = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
    svg('circle', { cx: x(last), cy: y(values[last]), r: 2 }, s);
    return s;
  }

  function advisorCard(a) {
    const [icon, cue] = cueOf(a);
    const card = el('article', { class: 'adv', 'aria-label': a.name });
    card.style.setProperty('--cue', `var(--cue-${cue})`);
    const max = a.notify && a.notify.maxPerHour;
    const used = a.notify && a.notify.lastHour;
    const cap = max === undefined ? 'no notification limit' : max === 0 ? 'never notifies' : `${used ?? 0} of ${max} notifications this hour`;
    const head = el('div', { class: 'adv-head' }, [
      el('span', { class: 'glyph' }, [glyph(icon)]),
      el('div', { class: 'who' }, [el('b', { text: a.name }), el('span', { class: 'goal', text: a.goal })]),
      el('span', { class: `cap${max !== undefined && max > 0 && (used ?? 0) >= max ? ' full' : ''}`, text: cap }),
    ]);
    const list = el('div', { class: 'measures' });
    for (const m of a.measures) {
      if (m.note) {
        list.append(el('div', { class: 'm notyet' }, [el('span', { text: m.label }), el('span', { class: 'note', text: m.note })]));
        continue;
      }
      const d = delta(m);
      list.append(
        el('div', { class: `m${m.value === undefined ? ' notyet' : ''}` }, [
          el('span', { text: m.label }),
          el('span', { class: 'v', text: m.value === undefined ? 'nothing yet' : format(m.value, m.unit) }),
          el('span', { class: `d ${d.cls}`, text: d.text, title: m.previous === undefined ? '' : `before: ${format(m.previous, m.unit)}` }),
          sparkline(m.series),
        ])
      );
    }
    const foot = el('div', { class: 'adv-foot' }, [el('span', { text: a.source === 'built-in' ? 'built in' : 'your persona.md' }), el('span', { class: 'mono', text: `version ${a.version}` })]);
    card.append(head, list, foot);
    return card;
  }

  function findingRow(f, advisorFor) {
    const adv = advisorFor(f.heuristicId);
    const row = el('div', { class: 'finding' }, [
      el('span', { class: `sev ${f.severity}` }),
      el('div', { class: 'what' }, [el('b', { text: `${f.heuristicId}: ${f.summary}` }), f.suggestedAction ? el('span', { text: f.suggestedAction }) : null]),
      adv ? el('span', { class: 'chip' }, [el('i'), document.createTextNode(adv.name)]) : el('span'),
    ]);
    if (adv) row.style.setProperty('--cue', `var(--cue-${cueOf(adv)[1]})`);
    return row;
  }

  // --- The page ------------------------------------------------------------------------
  const state = { workspace: null, days: 7, timer: null };

  async function loadWorkspaces() {
    const list = await api('/workspaces');
    const select = $('workspace');
    const wanted = recall(WORKSPACE_KEY);
    select.replaceChildren(...list.map((w) => el('option', { value: w.workspace, text: w.folder ? w.folder.split(/[\\/]/).filter(Boolean).pop() + ` · ${w.folder}` : w.workspace })));
    if (list.length === 0) {
      showMessage('No workspaces recorded yet', ['The core records a workspace once it has its first events: start an agent session in a project, then reload this page.']);
      return false;
    }
    state.workspace = list.some((w) => w.workspace === wanted) ? wanted : list[0].workspace;
    select.value = state.workspace;
    return true;
  }

  async function render() {
    if (!state.workspace) return;
    const q = `workspace=${encodeURIComponent(state.workspace)}`;
    const [advisors, findings] = await Promise.all([api(`/advisors?${q}&days=${state.days}&series=1`), api(`/findings?${q}`).catch(() => [])]);
    $('advisors').replaceChildren(...advisors.advisors.map(advisorCard));
    $('count-advisors').textContent = String(advisors.advisors.length);
    const advisorFor = (id) => advisors.advisors.find((a) => (a.notify.rules || []).includes(id));
    const active = (findings[0] && findings[0].findings) || [];
    $('count-findings').textContent = active.length ? String(active.length) : '';
    $('findings-note').textContent = active.length ? `· ${active.length} active` : '';
    $('findings').replaceChildren(...(active.length ? active.map((f) => findingRow(f, advisorFor)) : [el('p', { class: 'empty', text: 'Nothing found right now.' })]));
    const problems = advisors.problems || [];
    $('problems').hidden = problems.length === 0;
    $('problems').textContent = problems.length ? `Problems in your advisors' persona.md files: ${problems.join('; ')}` : '';
    remember(WORKSPACE_KEY, state.workspace);
    setFragment({ days: String(state.days) });
  }

  async function refresh() {
    try {
      const health = await api('/health');
      setStatus('ok', `core ${health.version}`);
      await render();
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
      setStatus('down', 'The core is not answering');
    }
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
    $('workspace').addEventListener('change', () => {
      state.workspace = $('workspace').value;
      void refresh();
    });
    $('days').addEventListener('change', () => {
      state.days = Number($('days').value);
      void refresh();
    });
    await refresh();
    state.timer = setInterval(refresh, REFRESH_MS);
  }

  void start();
})();
