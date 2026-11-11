// The advisor UI (RFC step 5a, as revised in the design pass), served by the
// core at /ui/. Plain script, no framework. It exchanges the one-time code in
// the address's fragment for a key kept in this tab, then reads the core's
// API. Every value from the core goes into the page as text, never as markup.
//
// Views: the advisors (a card each, holding its brief and the finding it has
// to surface, with Useful / Acknowledge / Mute); one advisor's page (its
// measures, chart, rules and voice), at #advisor=<id>; and from step 5b the
// sessions (#view=sessions), one session with what came of it
// (#session=<id>), and Explore (#view=explore), which draw with the Factory
// Clock visualizers the core serves beside this page.
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
  // A link may name where to go after signing in: #<code>&session=<id> (from VS Code's "Show in session").
  const CODE = /^#([A-Za-z0-9_-]{20,})(?:&(.*))?$/;
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
    // The code is used once; don't leave it in the address or history. Keep only where it said to go.
    const then = new URLSearchParams(m[2] || '');
    const keep = {};
    for (const k of ['session', 'advisor', 'view']) if (then.get(k)) keep[k] = then.get(k);
    setFragment(keep);
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
  /** What the core has for a finding's response, in words; undefined when it's still open. */
  function stateText(st) {
    if (!st) return undefined;
    if (st.muted) return 'Muted';
    if (st.useful) return 'Marked useful';
    if (st.acknowledged) return 'Acknowledged';
    return undefined;
  }
  /**
   * Useful / Acknowledge / Mute for a finding, or what you already chose. The core keeps responses for every
   * front door (this page, VS Code, the Claude Code plugin), so what's shown is what it has.
   */
  function responses(finding, st) {
    const box = el('div', { class: 'acts' });
    const done = stateText(st);
    if (done) {
      box.append(el('span', { class: 'done', text: done }));
      if (st.muted) box.append(unmuteButton(finding, box));
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
          const now = await api('/findings/respond', { method: 'POST', body: JSON.stringify({ workspace: state.workspace, heuristicId: finding.heuristicId, response }) });
          box.replaceWith(responses(finding, now));
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

  function unmuteButton(finding, box) {
    const b = el('button', { class: 'btn ghost', type: 'button', text: 'Unmute' });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const now = await api('/findings/respond', { method: 'POST', body: JSON.stringify({ workspace: state.workspace, heuristicId: finding.heuristicId, response: 'unmute' }) });
        box.replaceWith(responses(finding, now));
      } catch (err) {
        b.disabled = false;
        if (err instanceof Unauthorized) needLink('This page has lost its connection to the core.');
      }
    });
    return b;
  }

  // --- The advisors view --------------------------------------------------------------------------------
  function surfaceLine(s) {
    const dd = el('dd', {}, [el('span', { class: `surf ${s.kind}`, text: s.label })]);
    if (s.finding) {
      dd.append(el('b', { text: `${s.finding.heuristicId}: ` }), document.createTextNode(s.finding.summary));
      if (s.text) dd.append(document.createTextNode(` ${s.text}`));
      dd.append(responses(s.finding, s.state));
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
  function findingRow(group, states) {
    const f = group.find((x) => x.severity === 'warn') || group[0];
    const st = states[f.heuristicId];
    const more = group.length > 1 ? ` (and ${group.length - 1} more)` : '';
    return el('div', { class: 'finding' }, [
      el('span', { class: `sev ${f.severity}` }),
      el('div', { class: 'what' }, [el('b', { text: `${f.heuristicId}: ${f.summary}${more}` }), f.suggestedAction ? el('span', { text: f.suggestedAction }) : null, responses(f, st)]),
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
    const add = el('button', { class: 'adv-add', type: 'button', title: 'Add an advisor', 'aria-label': 'Add an advisor', text: '+' });
    add.addEventListener('click', () => {
      location.hash = '#view=add';
    });
    $('advisors').replaceChildren(...data.advisors.map(advisorCard), add);
    $('count-advisors').textContent = String(data.advisors.length);
    // Findings no advisor speaks for still show, below the cards.
    const claimed = new Set(data.advisors.flatMap((a) => a.notify.rules || []));
    const current = findings[0] || { findings: [], responses: {} };
    const others = (current.findings || []).filter((f) => !claimed.has(f.heuristicId));
    $('others').hidden = others.length === 0;
    $('other-findings').replaceChildren(...byHeuristic(others).map((g) => findingRow(g, current.responses || {})));
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
    svg('circle', { cx: last[0], cy: last[1], r: 3.5, class: 'pt' }, s);
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
  const VIEWS = ['advisors', 'advisor', 'add', 'sessions', 'session', 'explore', 'suggestions'];
  function showView(name) {
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
    // The nav marks the section you're in: an advisor's page is under Advisors, a session's under Sessions.
    const section = { advisor: 'advisors', add: 'advisors', session: 'sessions' }[name] || name;
    for (const n of ['advisors', 'sessions', 'explore', 'suggestions']) {
      $(`nav-${n}`).classList.toggle('on', n === section);
      if (n === section) $(`nav-${n}`).setAttribute('aria-current', 'page');
      else $(`nav-${n}`).removeAttribute('aria-current');
    }
    // The period applies to advisors' measures only.
    for (const e of document.querySelectorAll('[data-advisors-only]')) e.hidden = name !== 'advisors' && name !== 'advisor';
    if (name !== 'explore' && exploreTab) window.snagboatExplore.hidden();
    if (name !== 'sessions') state.sessionLimit = SESSIONS_PAGE;
  }
  /** Which view the address names: #advisor=<id>, #session=<id>, #view=sessions|explore, else the advisors. */
  function route() {
    const f = fragment();
    if (f.get('advisor')) return ['advisor', f.get('advisor')];
    if (f.get('session')) return ['session', f.get('session')];
    if (['sessions', 'explore', 'add', 'suggestions'].includes(f.get('view'))) return [f.get('view')];
    return ['advisors'];
  }

  // --- Sessions, one session, and Explore (RFC step 5b) ------------------------------------------------
  // The Factory Clock visualizers draw a session as VS Code's Sessions and Explore tabs do; the core
  // serves them beside this page, and they load the first time a session or Explore is shown.
  let vizLoading = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el('script', { src });
      s.addEventListener('load', resolve);
      s.addEventListener('error', () => reject(new Error(`couldn't load ${src}`)));
      document.body.append(s);
    });
  }
  function loadViz() {
    vizLoading ??= (async () => {
      await loadScript('vizkit.js');
      const res = await fetch('viz/index.json');
      const files = res.ok ? await res.json() : [];
      for (const f of files) await loadScript(f);
      await loadScript('explore.js');
      const kit = window.snagboatVizKit;
      return { ...kit, tooltip: $('tooltip'), ...kit.tipFor($('tooltip')) };
    })();
    vizLoading.catch(() => {
      vizLoading = null;
    });
    return vizLoading;
  }

  const AGENTS = { 'claude-code': 'Claude Code', copilot: 'Copilot', 'copilot-cli': 'Copilot CLI' };
  const agentLabel = (a) => AGENTS[a] || a;
  function compactNumber(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    return n.toLocaleString();
  }
  function lengthText(fromTs, toTs) {
    const min = Math.round((Date.parse(toTs) - Date.parse(fromTs)) / 60_000);
    if (!(min >= 1)) return 'under a minute';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  }
  function startedText(ts) {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }
  const sessionTitle = (s) => s.name || `${agentLabel(s.agent)} session ${s.sessionId.slice(0, 8)}`;
  const short = (commit) => (commit || '').slice(0, 7);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  // What each outcome type is called, and whether it's good news, bad news or neither.
  const OUTCOMES = {
    tests_green: ['tests green', 'good'],
    milestone: ['milestone', 'good'],
    commit_kept: ['commit kept', 'good'],
    commit_reverted: ['commit reverted', 'bad'],
    code_survival: ['code survival', ''],
    finding_response: ['finding', ''],
    notified: ['notified', ''],
    approval: ['approval', ''],
  };
  /** One outcome as a chip: its name, and what it says. */
  function outcomeChip(o) {
    const [name, tone] = OUTCOMES[o.type] || [o.type, ''];
    let text = '';
    let cls = tone;
    if (o.type === 'tests_green') text = `${o.failures ? `after ${plural(o.failures, 'failure')}` : 'first run'}${o.afterMs ? `, ${lengthText(new Date(0).toISOString(), new Date(o.afterMs).toISOString())}` : ''}`;
    else if (o.type === 'milestone' || o.type === 'commit_kept' || o.type === 'commit_reverted') text = `${short(o.commit)}${o.days ? ` · ${o.days} days` : ''}`;
    else if (o.type === 'code_survival') {
      text = `${(o.linesSurviving ?? 0).toLocaleString()} of ${(o.linesWritten ?? 0).toLocaleString()} lines at ${o.days} days`;
      if (o.linesWritten && o.linesSurviving / o.linesWritten < 0.5) cls = 'bad';
    } else if (o.type === 'finding_response') {
      text = `${o.heuristicId} · ${{ useful: 'marked useful', acknowledged: 'acknowledged', muted: 'muted', passed: 'passed unanswered' }[o.response] || o.response}`;
      if (o.response === 'useful') cls = 'good';
    } else if (o.type === 'notified') text = o.heuristicId ? `${o.heuristicId}${o.advisor ? ` · ${o.advisor}` : ''}` : o.advisor || '';
    else if (o.type === 'approval') {
      text = o.decision === 'denied' ? 'denied by auto mode' : 'asked you';
      if (o.decision === 'denied') cls = 'bad';
    }
    return el('span', { class: `oc ${cls}`, title: new Date(o.ts).toLocaleString() }, [el('b', { text: name }), text ? document.createTextNode(` ${text}`) : null]);
  }
  /** A session's outcome counts as chips, for the list. */
  function countChips(counts) {
    const order = Object.keys(OUTCOMES).filter((t) => counts[t]);
    if (!order.length) return [el('span', { class: 'muted small', text: '—' })];
    return order.map((t) => {
      const [name, tone] = OUTCOMES[t];
      return el('span', { class: `oc ${tone}` }, [el('b', { text: name }), counts[t] > 1 ? document.createTextNode(` ×${counts[t]}`) : null]);
    });
  }

  const SESSIONS_PAGE = 100;
  async function renderSessions() {
    const list = await api(`/sessions?workspace=${encodeURIComponent(state.workspace)}`);
    $('count-sessions').textContent = String(list.length);
    const shown = list.slice(0, state.sessionLimit);
    $('sessions-note').textContent = list.length ? `${plural(list.length, 'session')}, latest activity first` : '';
    $('sessions-body').replaceChildren(
      ...(shown.length
        ? shown.map((s) =>
            el('tr', {}, [
              el('td', {}, [
                el('a', { href: `#${new URLSearchParams({ session: s.sessionId }).toString()}`, text: sessionTitle(s) }),
                el('div', { class: 'muted small', text: [agentLabel(s.agent), ...s.models].join(' · ') }),
              ]),
              el('td', { class: 'nowrap', text: startedText(s.firstTs) }),
              el('td', { class: 'n', text: lengthText(s.firstTs, s.lastTs) }),
              el('td', { class: 'n', text: s.prompts.toLocaleString() }),
              el('td', { class: 'n', text: s.toolCalls.toLocaleString() }),
              el('td', { class: 'n', text: compactNumber(s.tokens) }),
              el('td', {}, [el('div', { class: 'outcomes' }, countChips(s.outcomes || {}))]),
            ])
          )
        : [el('tr', {}, [el('td', { colspan: '7', class: 'empty', text: 'No sessions recorded in this workspace yet.' })])])
    );
    $('sessions-more').hidden = list.length <= shown.length;
  }

  /**
   * A session's findings, one row per heuristic: the one reporting now first (with its responses), then
   * those found replaying the session, each with how many times and over what span, its latest summary shown.
   */
  function sessionFindingRows(findings, states) {
    const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const groups = new Map();
    for (const f of findings) {
      const key = `${f.active ? 'now' : 'then'}:${f.heuristicId}`;
      groups.set(key, [...(groups.get(key) || []), f]);
    }
    const rows = [...groups.values()].sort((a, b) => Number(b[0].active) - Number(a[0].active));
    return rows.map((group) => {
      const starts = group.map((f) => f.startedTs || f.fromTs).filter(Boolean).sort();
      const latest = group[group.length - 1];
      const severity = group.some((f) => f.severity === 'warn') ? 'warn' : 'info';
      const when = starts.length ? (starts.length > 1 ? `from ${clock(starts[0])} to ${clock(starts[starts.length - 1])}` : `from ${clock(starts[0])}`) : '';
      const what = [latest.active ? 'Reporting now' : 'Found replaying the session', group.length > 1 ? `${group.length} times` : '', when].filter(Boolean).join(' · ');
      return el('div', { class: 'finding' }, [
        el('span', { class: `sev ${severity}` }),
        el('div', { class: 'what' }, [el('b', { text: `${latest.heuristicId}: ${latest.summary}` }), el('span', { text: what }), latest.active ? responses(latest, states[latest.heuristicId]) : null]),
        el('span'),
      ]);
    });
  }

  // The session page's two drawings stay mounted, so a refresh keeps your focus and zoom.
  const sessionUi = { tree: null, timeline: null, view: null, focusId: 's', selectedTurn: null };
  function drawSession() {
    const v = sessionUi.view;
    if (!v || !sessionUi.tree) return;
    const selection = { sessionId: v.summary.sessionId, turnId: sessionUi.selectedTurn || undefined, focusId: sessionUi.focusId };
    sessionUi.tree.update([v], selection, {});
    sessionUi.timeline.update([v], selection, {});
  }
  async function renderSession(id) {
    const [ctx, page] = await Promise.all([loadViz(), api(`/sessions/${encodeURIComponent(id)}/view?workspace=${encodeURIComponent(state.workspace)}`)]);
    // A reply for a session you've since left (or an older refresh) is dropped.
    if (route()[0] !== 'session' || route()[1] !== id) return;
    const v = page.view;
    const s = v.summary;
    if (!sessionUi.tree) {
      const select = (sel) => {
        sessionUi.selectedTurn = sel.turnId || null;
        sessionUi.focusId = sel.focusId || 's';
        if (sel.focusId) sessionUi.timeline.zoomTo(null);
        drawSession();
      };
      const c = { ...ctx, select };
      sessionUi.tree = window.snagboatViz.get('turn-tree').mount($('tree-host'), c);
      sessionUi.timeline = window.snagboatViz.get('context-timeline').mount($('timeline-host'), c);
      $('whole').onclick = () => sessionUi.timeline?.zoomAll();
    }
    if (!sessionUi.view || sessionUi.view.summary.sessionId !== s.sessionId) {
      sessionUi.focusId = 's';
      sessionUi.selectedTurn = null;
    }
    sessionUi.view = v;
    state.lastSession = s.sessionId;
    $('session-h').textContent = sessionTitle(s);
    $('session-meta').textContent = [agentLabel(s.agent), ...s.models, lengthText(s.firstTs, s.lastTs), plural(s.prompts, 'prompt'), plural(s.toolCalls, 'tool call'), `${compactNumber(s.tokens)} tokens`, startedText(s.firstTs)].join(' · ');
    $('session-outcomes').replaceChildren(...(page.outcomes.length ? page.outcomes.map(outcomeChip) : [el('span', { class: 'empty', text: 'Nothing recorded yet. Tests going green, commits and what became of them, and how you met its findings show here as they happen; commits kept and code survival take 7 days.' })]));
    drawSession();
    $('session-findings').replaceChildren(...(v.findings.length ? sessionFindingRows(v.findings, page.responses) : [el('p', { class: 'empty', text: 'No findings in this session.' })]));
    const exploreWith = (vizId, label) => {
      const b = el('button', { class: 'btn', type: 'button', text: label });
      b.addEventListener('click', () => {
        writeExploreState({ ...readExploreState(), picked: [s.sessionId], current: vizId });
        if (exploreTab) exploreTab.destroy();
        exploreTab = null;
        location.hash = '#view=explore';
      });
      return b;
    };
    $('session-explore').replaceChildren(exploreWith('factory-clock', 'Factory Clock'), exploreWith('living-network', 'Living Network'), exploreWith('gantt', 'Gantt and waterfall'), exploreWith('tool-ribbon', 'Tool-call ribbon'), el('span', { class: 'muted small', text: 'or any of the others in Explore' }));
  }

  // Explore: packages/viz/explore.js over a source that reads the core. Its saved state (picked sessions,
  // the current visualizer, the puck's corner) is kept per workspace in this tab.
  let exploreTab = null;
  let exploreWorkspace = null;
  const exploreKey = () => `snagboat.ui.explore.${state.workspace}`;
  function readExploreState() {
    try {
      const v = JSON.parse(recall(exploreKey()) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  function writeExploreState(v) {
    remember(exploreKey(), JSON.stringify(v));
  }
  function exploreSource() {
    const workspace = state.workspace;
    const q = `workspace=${encodeURIComponent(workspace)}`;
    const listeners = { sessions: [], explorer: [] };
    const failed = (err) => {
      if (err instanceof Unauthorized) needLink('This page has lost its connection to the core.');
      else setStatus('down', err.message || 'The core is not answering');
    };
    return {
      listSessions() {
        api(`/sessions?${q}`)
          .then((list) => {
            const sessions = [...list].sort((a, b) => b.firstTs.localeCompare(a.firstTs) || a.sessionId.localeCompare(b.sessionId));
            for (const cb of listeners.sessions) cb({ sessions, headlines: {} });
          })
          .catch(failed);
      },
      loadSessions(ids) {
        api(`/explore?${q}&ids=${ids.map(encodeURIComponent).join(',')}`)
          .then((st) => {
            for (const cb of listeners.explorer) cb(st);
          })
          .catch(failed);
      },
      closeExplorer() {
        for (const cb of listeners.explorer) cb(null);
      },
      getState: readExploreState,
      setState(partial) {
        writeExploreState({ ...readExploreState(), ...partial });
      },
      onSessions(cb) {
        listeners.sessions.push(cb);
      },
      onExplorer(cb) {
        listeners.explorer.push(cb);
      },
      openSessionId: () => state.lastSession || null,
    };
  }
  async function renderExplore() {
    const ctx = await loadViz();
    if (exploreTab && exploreWorkspace !== state.workspace) {
      exploreTab.destroy();
      exploreTab = null;
    }
    if (!exploreTab) {
      exploreWorkspace = state.workspace;
      exploreTab = window.snagboatExplore.mount($('explore-root'), exploreSource(), ctx);
    }
    exploreTab.shown();
  }

  // --- Adding an advisor (step 5c) ---------------------------------------------------------------------
  // The form writes a new persona.md through the core (POST /advisors); the built-ins are templates.
  let addForm = null; // { measures, rules, templates, colors, icons } from GET /advisor-form
  let addWired = false; // the form's listeners, added once
  function checkbox(name, value, label, note) {
    return el('label', {}, [el('input', { type: 'checkbox', name, value }), document.createTextNode(label), note ? el('span', { class: 'note', text: note }) : null]);
  }
  function radio(name, value, children) {
    return el('label', {}, [el('input', { type: 'radio', name, value }), ...children]);
  }
  function fillAdd(t) {
    $('add-name').value = t ? `${t.name} (yours)` : '';
    $('add-status').value = t ? t.status : '';
    $('add-goal').value = t ? t.goal : '';
    $('add-max').value = String(t ? t.maxPerHour : 2);
    $('add-voice').value = t ? t.voice : '';
    for (const box of document.querySelectorAll('#add-measures input')) box.checked = !!t && t.measures.includes(box.value);
    for (const box of document.querySelectorAll('#add-rules input')) box.checked = !!t && t.rules.includes(box.value);
    for (const r of document.querySelectorAll('#add-colors input')) r.checked = r.value === (t ? t.color : addForm.colors[0]);
    for (const r of document.querySelectorAll('#add-icons input')) r.checked = r.value === (t ? t.icon : addForm.icons[0]);
  }
  async function renderAdd() {
    if (addForm) return;
    addForm = await api('/advisor-form');
    $('add-template').replaceChildren(el('option', { value: '', text: 'A blank advisor' }), ...addForm.templates.map((t) => el('option', { value: t.from, text: `A copy of ${t.name}` })));
    $('add-measures').replaceChildren(...addForm.measures.map((m) => checkbox('measure', m.id, m.label, m.notYet ? 'not measured yet' : '')));
    $('add-rules').replaceChildren(...addForm.rules.map((r) => checkbox('rule', r.id, r.title ? `${r.id}: ${r.title}` : r.id)));
    $('add-colors').replaceChildren(...addForm.colors.map((c) => radio('color', c, [el('span', { class: `glyph cue-${c}` }, [glyph('default', 14)]), document.createTextNode(c)])));
    $('add-icons').replaceChildren(...addForm.icons.map((i) => radio('icon', i, [el('span', { class: 'glyph' }, [glyph(i, 16)]), document.createTextNode(i)])));
    fillAdd(null);
    if (addWired) return;
    addWired = true;
    $('add-template').addEventListener('change', () => fillAdd(addForm.templates.find((t) => t.from === $('add-template').value) || null));
    $('add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const picked = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.checked).map((x) => x.value);
      const body = {
        name: $('add-name').value,
        status: $('add-status').value,
        goal: $('add-goal').value,
        measures: picked('#add-measures input'),
        rules: picked('#add-rules input'),
        maxPerHour: Number($('add-max').value),
        color: picked('#add-colors input')[0],
        icon: picked('#add-icons input')[0],
        voice: $('add-voice').value,
      };
      $('add-submit').disabled = true;
      $('add-error').textContent = '';
      try {
        const { advisor } = await api('/advisors', { method: 'POST', body: JSON.stringify(body) });
        addForm = null; // fresh choices (and a clean form) next time
        $('add-form').reset();
        location.hash = `#${new URLSearchParams({ days: String(state.days), advisor: advisor.id }).toString()}`;
      } catch (err) {
        if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
        $('add-error').textContent = err.message;
      } finally {
        $('add-submit').disabled = false;
      }
    });
  }

  // --- Suggestions (step 5c-2) ------------------------------------------------------------------------
  // VS Code's own Suggestions tab (media/suggestions.js), run over the core: a shim gives it the helpers
  // and the postMessage it expects, sends its actions to POST /suggestions, and hands it each view.
  let suggestionsReady = null;
  let suggestionsPoll = null;
  const SUGGESTION_ACTIONS = {
    discover: () => ({ action: 'discover' }),
    tweakSuggestion: (m) => ({ action: 'tweak', id: m.id, threshold: m.threshold }),
    acceptSuggestion: (m) => ({ action: 'accept', id: m.id }),
    acceptShellCategory: (m) => ({ action: 'acceptCategory', id: m.id }),
    dismissSuggestion: (m) => ({ action: 'dismiss', id: m.id }),
    clearDismissed: () => ({ action: 'clearDismissed' }),
    applyThreshold: (m) => ({ action: 'applyThreshold', heuristic: m.heuristic, setting: m.setting }),
    removeSaved: (m) => ({ action: 'removeSaved', section: m.section, id: m.id }),
    askAdvisor: () => ({ action: 'askAdvisor' }),
    applyAdvisorThreshold: (m) => ({ action: 'applyAdvisorThreshold', heuristic: m.heuristic, setting: m.setting }),
  };
  let choosingAdvisor = false;
  /**
   * Beside VS Code's view: the core's local advisors (step 5c-2b). A request waiting for your approval shows
   * its exact payload with Send and Cancel; Ask another advisor lists the others; an error says what failed.
   */
  function renderAdvice(view) {
    const box = $('advice');
    const core = view.core || { advisors: [] };
    const parts = [];
    const send = (body) => void suggestionMessage({ type: '__core', body });
    if (core.approval) {
      const a = core.approval;
      const yes = el('button', { class: 'btn primary', type: 'button', text: 'Send' });
      const no = el('button', { class: 'btn ghost', type: 'button', text: "Don't send" });
      yes.addEventListener('click', () => send({ action: 'approve', id: a.id, send: true }));
      no.addEventListener('click', () => send({ action: 'approve', id: a.id, send: false }));
      parts.push(
        el('h2', { text: `Send this to ${a.advisor} (${a.model})?` }),
        el('p', { class: 'small', text: `Below is exactly what will be sent, to a model on this machine. This is the first request with ${a.advisor}'s current address and sending rules; you won't be asked again until they change, here or in VS Code.` }),
        el('pre', { class: 'payload', text: a.payload }),
        el('div', { class: 'acts' }, [yes, no])
      );
    } else if (choosingAdvisor) {
      parts.push(el('h2', { text: 'Ask which advisor?' }));
      const row = el('div', { class: 'acts' });
      for (const c of core.advisors) {
        const b = el('button', { class: 'btn', type: 'button', text: c.model ? `${c.label} (${c.model})` : c.label });
        b.addEventListener('click', () => {
          choosingAdvisor = false;
          send({ action: 'askAdvisor', advisorId: c.id });
        });
        row.append(b);
      }
      const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Cancel' });
      cancel.addEventListener('click', () => {
        choosingAdvisor = false;
        renderAdvice(view);
      });
      row.append(cancel);
      parts.push(row);
    }
    if (core.error) parts.push(el('p', { class: 'err', text: core.error }));
    if (!core.advisors.length && view.status === 'ready') {
      parts.push(el('p', { class: 'small muted', text: 'To have an advisor name these candidates and propose rules here, run a local model (for example Ollama) or add one to snagboat.advisors in your user settings. The advisor UI asks only models on this machine; hosted advisors stay in VS Code.' }));
    }
    box.replaceChildren(...parts);
    box.hidden = parts.length === 0;
  }
  let lastSuggestions = null;
  function showSuggestions(view) {
    lastSuggestions = view;
    window.postMessage({ type: 'suggestions', view }, location.origin);
    renderAdvice(view);
    clearTimeout(suggestionsPoll);
    // Discovery and advisor requests run in the core; look again until they're done (a request waiting for
    // your approval is shown, not polled).
    const busy = view.status === 'running' || (view.advisor && view.advisor.status === 'asking' && !(view.core && view.core.approval));
    if (busy && route()[0] === 'suggestions') suggestionsPoll = setTimeout(() => void refreshSuggestions(), 1500);
  }
  async function refreshSuggestions() {
    try {
      showSuggestions(await api(`/suggestions?workspace=${encodeURIComponent(state.workspace)}`));
    } catch (err) {
      if (err instanceof Unauthorized) needLink('This page has lost its connection to the core.');
      else setStatus('down', err.message || 'The core is not answering');
    }
  }
  async function suggestionMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'openSession' && typeof m.sessionId === 'string') {
      location.hash = `#${new URLSearchParams({ session: m.sessionId }).toString()}`;
      return;
    }
    if (m.type === 'askAnotherAdvisor') {
      choosingAdvisor = true;
      if (lastSuggestions) renderAdvice(lastSuggestions);
      return;
    }
    const make = m.type === '__core' ? () => m.body : SUGGESTION_ACTIONS[m.type];
    if (!make) return;
    try {
      showSuggestions(await api('/suggestions', { method: 'POST', body: JSON.stringify({ workspace: state.workspace, ...make(m) }) }));
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
      showMessage("Couldn't do that", [String(err.message || err)]);
    }
  }
  function loadSuggestions() {
    suggestionsReady ??= (async () => {
      await loadViz();
      await loadScript('shared.js');
      window.snagboat = {
        ...window.snagboatShared,
        suggestionsRoot: $('suggestions-root'),
        vscode: { postMessage: (m) => void suggestionMessage(m), getState: () => ({}), setState: () => undefined },
      };
      await loadScript('suggestions.js');
    })();
    suggestionsReady.catch(() => {
      suggestionsReady = null;
    });
    return suggestionsReady;
  }
  async function renderSuggestions() {
    await loadSuggestions();
    await refreshSuggestions();
  }

  // --- The page ------------------------------------------------------------------------
  const state = { workspace: null, days: 7, advisors: [], sessionLimit: SESSIONS_PAGE, lastSession: null };

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

  /** Draws the view the address names; on the timer, Explore is left alone (it keeps its own sessions). */
  async function refresh(timer = false) {
    const [view, id] = route();
    if (timer && (view === 'explore' || view === 'add' || view === 'suggestions')) return;
    try {
      const health = await api('/health');
      setStatus('ok', `core ${health.version}`);
      remember(WORKSPACE_KEY, state.workspace);
      showView(view);
      if (view === 'advisor') await renderAdvisor(id);
      else if (view === 'session') await renderSession(id);
      else if (view === 'sessions') await renderSessions();
      else if (view === 'explore') await renderExplore();
      else if (view === 'add') await renderAdd();
      else if (view === 'suggestions') await renderSuggestions();
      else await renderAdvisors();
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core: the core restarted, or the link was already used.');
      if (view === 'session' && /no session/.test(err.message || '')) {
        $('session-h').textContent = 'Session not found';
        $('session-meta').textContent = 'It may belong to another workspace, or be older than the store keeps.';
        sessionUi.view = null;
        sessionUi.tree?.destroy();
        sessionUi.timeline?.destroy();
        $('tree-host').replaceChildren();
        $('timeline-host').replaceChildren();
        sessionUi.tree = null;
        sessionUi.timeline = null;
        for (const box of ['session-outcomes', 'session-findings', 'session-explore']) $(box).replaceChildren();
        return;
      }
      setStatus('down', err.message && !(err instanceof TypeError) ? err.message : 'The core is not answering');
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
    if (!fragment().get('days')) setFragment({ ...Object.fromEntries(fragment()), days: String(state.days) });
    $('workspace').addEventListener('change', () => {
      state.workspace = $('workspace').value;
      state.lastSession = null;
      // A session belongs to one workspace: switching shows the new one's list.
      if (route()[0] === 'session') setFragment({ view: 'sessions', days: String(state.days) });
      void refresh();
    });
    $('days').addEventListener('change', () => {
      state.days = Number($('days').value);
      setFragment({ ...Object.fromEntries(fragment()), days: String(state.days) });
      void refresh();
    });
    $('back').addEventListener('click', home);
    $('nav-advisors').addEventListener('click', home);
    $('sessions-more').addEventListener('click', () => {
      state.sessionLimit += SESSIONS_PAGE;
      void renderSessions();
    });
    window.addEventListener('hashchange', () => void refresh());
    await refresh();
    setInterval(() => void refresh(true), REFRESH_MS);
  }

  void start();
})();
