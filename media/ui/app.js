// The advisor UI (RFC step 5a, as revised in the design pass), served by the
// core at /ui/. Plain script, no framework. It exchanges the one-time code in
// the address's fragment for a key kept in this tab, then reads the core's
// API. Every value from the core goes into the page as text, never as markup.
//
// Views: the advisors (a card each, holding its brief and the finding it has
// to surface, with Useful / Acknowledge / Mute); one advisor's page (its
// measures, chart, rules and voice), at #advisor=<id>; and from step 5b the
// sessions (#view=sessions), and one session with what came of it
// (#session=<id>), drawn with Snagboat's two session drawings (media/drawings),
// which the core serves beside this page. And a workspace's plan items with the sessions,
// commits and branches linked to each (#view=plans), drawn by plans.js.
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
    if (!res.ok) throw Object.assign(new Error(body.error || `the core answered ${res.status}`), { status: res.status });
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
    if (ahead.source === 'plan') return planLine(ahead);
    const parts = [];
    if (ahead.inProgress.length) parts.push(el('b', { text: 'Now: ' }), document.createTextNode(`${ahead.inProgress.map((b) => `${b.id} "${b.title}"`).join(', ')}. `));
    if (ahead.next) parts.push(el('b', { text: 'Next: ' }), document.createTextNode(`${ahead.next.id} "${ahead.next.title}" (ready). `));
    if (ahead.firstBlocked) parts.push(el('b', { text: 'Blocked: ' }), document.createTextNode(`${ahead.blocked}, first ${ahead.firstBlocked.id}${ahead.firstBlocked.blockedBy.length ? ` waiting on ${ahead.firstBlocked.blockedBy.join(', ')}` : ''}. `));
    parts.push(document.createTextNode(`${ahead.closedThisWeek} closed this week.`));
    return el('dd', {}, [el('span', { class: 'surf source', text: 'beads' }), ...parts]);
  }

  /** No Beads: the agent's own todo list, its items' text when it was captured, else counts. */
  function planLine(plan) {
    const total = plan.pending + plan.inProgressCount + plan.completed;
    const parts = [];
    if (plan.inProgress.length) parts.push(el('b', { text: 'Now: ' }), document.createTextNode(`${plan.inProgress.map((t) => `"${t}"`).join(', ')}. `));
    if (plan.next) parts.push(el('b', { text: 'Next: ' }), document.createTextNode(`"${plan.next}". `));
    const counts = `${plan.completed} of ${total} done${!plan.text && plan.inProgressCount ? `, ${plan.inProgressCount} in progress` : ''}`;
    const from = plan.live ? '' : ` In ${plan.sessionName ? `"${plan.sessionName}"` : 'the last session'}.`;
    parts.push(document.createTextNode(`${counts}.${from}`));
    return el('dd', { title: "the agent's todo list in its session" }, [el('span', { class: 'surf source', text: 'plan' }), ...parts]);
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
        a.review && a.review.unmarked ? el('a', { class: 'pill amber', href: `#${new URLSearchParams({ days: String(state.days), advisor: a.id }).toString()}`, text: `${a.review.unmarked} proposal${a.review.unmarked === 1 ? '' : 's'}`, title: `waiting in the ${a.review.label} report` }) : null,
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
    card.append(el('div', { class: 'adv-foot' }, [el('span', { text: `${a.source === 'built-in' ? 'built in' : 'your persona.md'} · ${a.model ? `model ${a.model}` : 'no model'} · reports ${a.period || 'weekly'}` }), open]));
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
      el('dd', { text: a.model ? `${a.model} (snagboat.advisors) writes its reports` : 'none: its reports carry the numbers only' }),
      el('dt', { text: 'Reports' }),
      el('dd', { text: a.period || 'weekly' })
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
    await renderReport(a);
    await renderSetupHistory(a);
  }

  // --- An advisor's period report (goal tracking lifecycle, snagboat-79f.7.5) ---------------------------
  // The latest report from the core: where the goal stands, verdicts on running experiments, and its
  // proposed rule changes with how you've marked them.
  const MARKS = { open: 'Not marked', accepted: 'Accepted', discarded: 'Discarded', revised: 'To revise', kept: 'Kept going', closed: 'Closed' };
  const num = (v) => (typeof v === 'number' ? v.toLocaleString() : String(v));
  function changeText(c) {
    return c.kind === 'setting' ? `${c.key} ${c.before === undefined ? 'unset' : num(c.before)} → ${num(c.after)}` : `${c.before ? 'changed rule' : 'new rule'} ${c.rule.id}`;
  }
  function scopeText(scope) {
    return scope === 'global' ? 'global' : scope.workspace.split(/[\\/]/).filter(Boolean).pop() || scope.workspace;
  }
  function kindText(c) {
    return c.kind === 'setting' ? `Rule change · ${c.key}` : c.before ? `Rule change · ${c.rule.title || c.rule.id}` : `New rule · ${c.rule.title || c.rule.id}`;
  }
  function proposalCard(p, actions) {
    return el('article', { class: `prop${p.status === 'revised' && actions === null ? ' old' : ''}`, 'aria-label': p.title }, [
      el('div', { class: 'prop-head' }, [el('b', { text: p.title }), el('span', { class: 'pill scope', text: scopeText(p.scope) })]),
      el('span', { class: 'kind', text: kindText(p.change) }),
      el('span', { class: 'change', text: changeText(p.change) }),
      el('span', { class: 'why', text: `${p.what} Why: ${p.why}` }),
      el('div', { class: 'pred' }, [el('b', { text: 'Prediction, tracked once accepted' }), document.createTextNode(p.prediction.text)]),
      p.note ? el('div', { class: 'note', text: `Your note: ${p.note}` }) : null,
      actions || el('span', { class: `mark ${p.status}`, text: MARKS[p.status] || p.status }),
    ]);
  }
  function verdictLine(v) {
    const RESULTS = { met: 'Met', 'not-met': 'Not met', 'too-early': 'Too early', confounded: 'Mixed up' };
    return el('div', { class: 'verdict' }, [el('span', { class: `pill ${v.result}`, text: RESULTS[v.result] || v.result }), el('span', { text: v.text })]);
  }
  /** The report panel; `act` (snagboat-79f.7.13) adds the review's buttons. */
  async function renderReport(a) {
    let view;
    try {
      view = await api(`/advisors/${encodeURIComponent(a.id)}/report`);
    } catch (err) {
      if (err instanceof Unauthorized) throw err;
      $('report-meta').textContent = '';
      $('report').replaceChildren(el('p', { class: 'small muted', text: `No report yet. The core writes one when the ${a.period || 'weekly'} period closes.` }), el('div', { class: 'foot' }, reportFoot(a, { review: { state: 'numbers-only' }, proposals: [] })));
      return;
    }
    const r = view.report;
    const latest = r.revisions && r.revisions.length ? r.revisions[r.revisions.length - 1] : null;
    $('report-meta').textContent = `· ${r.label}${r.trigger === 'request' ? ' (asked for)' : ''}${latest ? ` · revision ${latest.rev}` : ''}`;
    const parts = [el('p', { class: 'sum', text: latest ? latest.summary : r.summary })];
    parts.push(el('span', { class: 'small muted', text: `${r.from.slice(0, 10)} to ${r.to.slice(0, 10)}${r.previous ? `, against ${r.previous}` : ''} · all workspaces` }));
    parts.push(
      el('div', { class: 'measures' }, r.measures.map((m) => {
        if (m.note) return el('div', { class: 'm notyet' }, [el('span', { text: m.label }), el('span', { class: 'note', text: m.note })]);
        const d = delta(m);
        return el('div', { class: `m${m.value === undefined ? ' notyet' : ''}` }, [el('span', { text: m.label }), el('span', { class: 'v', text: m.value === undefined ? 'nothing yet' : format(m.value, m.unit) }), el('span', { class: `d ${d.cls}`, text: d.text }), el('span')]);
      }))
    );
    const verdicts = latest && latest.verdicts.length ? latest.verdicts : r.verdicts || [];
    if (verdicts.length) parts.push(el('h3', { text: 'Experiments' }), ...verdicts.map(verdictLine));
    if (!latest) parts.push(...modelState(a, view));
    else if (!view.proposals.length) parts.push(el('p', { class: 'small muted', text: 'No changes proposed.' }));
    else {
      parts.push(el('h3', { text: 'Proposed changes' }));
      for (const p of view.proposals) {
        // A revised proposal follows the one it replaces, struck through, with your note.
        const old = p.replaces && (view.replaced || []).find((x) => x.id === p.replaces);
        if (old) parts.push(proposalCard(old, null));
        parts.push(proposalCard(p, reportActions ? reportActions(view, p) : null));
      }
    }
    parts.push(el('div', { class: 'foot', id: 'report-foot' }, reportFoot ? reportFoot(a, view) : [el('span', { class: 'small muted', text: reviewText(view.review) })]));
    $('report').replaceChildren(...parts);
  }
  /** Why a report has no model answer yet: asking, waiting for your approval, failed, not sent, or not asked. */
  let askPoll = null;
  function modelState(a, view) {
    if (!a.model) return [el('p', { class: 'small muted', text: 'No model is set in its persona.md, so this report has the numbers only.' })];
    clearTimeout(askPoll);
    const again = (label) => {
      const b = el('button', { class: 'btn', type: 'button', text: label });
      b.addEventListener('click', () => void act(() => api(`/advisors/${encodeURIComponent(a.id)}/report/answer?id=${encodeURIComponent(view.report.id)}`, { method: 'POST' })));
      return b;
    };
    const ask = view.ask;
    if (!ask) return [el('p', { class: 'small muted', text: `${a.model} hasn't been asked about this report since the core started.` }), el('div', { class: 'btns' }, [again(`Ask ${a.model}`)])];
    if (ask.state === 'failed') return [el('p', { class: 'err', text: `${a.model} couldn't answer: ${ask.error}` }), el('div', { class: 'btns' }, [again('Ask the model again')])];
    if (ask.state === 'not-sent') return [el('p', { class: 'small muted', text: "The request wasn't sent: it was waiting for your approval and you didn't send it, or it timed out." }), el('div', { class: 'btns' }, [again('Ask the model again')])];
    // Asking: look again shortly, while you approve or it answers.
    askPoll = setTimeout(() => {
      if (reviewing === a && !$('view-advisor').hidden) void renderReport(a);
    }, 3000);
    if (!ask.approval) return [el('p', { class: 'small muted', text: `Asking ${a.model}… a local model can take a minute or two.` })];
    const ap = ask.approval;
    const decide = (send) => () =>
      void act(async () => {
        try {
          await api('/suggestions', { method: 'POST', body: JSON.stringify({ workspace: state.workspace, action: 'approve', id: ap.id, send }) });
        } catch (err) {
          if (!(err instanceof Refused)) throw err; // already answered elsewhere
        }
      });
    const sendBtn = el('button', { class: 'btn primary', type: 'button', text: 'Send' });
    sendBtn.addEventListener('click', decide(true));
    const noBtn = el('button', { class: 'btn ghost', type: 'button', text: "Don't send" });
    noBtn.addEventListener('click', decide(false));
    return [
      el('div', { class: 'approval' }, [
        el('b', { text: `Send this to ${ap.advisor} (${ap.model})?` }),
        el('span', { class: 'small muted', text: "The first request with this model's address and sending rules waits for you to see exactly what it sends. Once you send it, later requests go without asking." }),
        el('details', {}, [el('summary', { text: 'The request, exactly as sent' }), el('pre', { class: 'payload', text: ap.payload })]),
        el('div', { class: 'btns' }, [sendBtn, noBtn]),
      ]),
    ];
  }
  function reviewText(rv) {
    if (rv.state === 'numbers-only') return '';
    if (rv.state === 'accepted') return 'Accepted: the accepted changes are running as experiments.';
    if (rv.state === 'revising') return 'Sent back to revise; the advisor is answering your notes.';
    return `${rv.marked} of ${rv.marked + rv.unmarked} marked${rv.toRevise ? ` · ${rv.toRevise} to revise` : ''}`;
  }
  // --- The experiments page (snagboat-79f.7.9) ------------------------------------------------------------
  // One table of every experiment, across workspaces: the change, its review date, and its tracked measure
  // against the baseline, filtered by project, advisor, a search, and status.
  let experimentsData = null;
  let experimentsWired = false;
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function experimentRows() {
    const { experiments, now } = experimentsData;
    const project = $('x-project').value;
    const advisor = $('x-advisor').value;
    const status = $('x-status').value;
    const q = $('x-search').value.trim().toLowerCase();
    const shown = experiments.filter((x) => (!project || scopeText(x.scope) === project) && (!advisor || x.advisor === advisor) && (!status || x.status === status) && (!q || `${x.title} ${changeText(x.change)}`.toLowerCase().includes(q)));
    $('x-count').textContent = `${shown.length} of ${experiments.length} experiment${experiments.length === 1 ? '' : 's'}`;
    const head = el('thead', {}, [el('tr', {}, ['Experiment', 'Advisor', 'Project', 'Change', 'Started', 'Review', 'Measure', 'Baseline', 'Now', 'Status', ''].map((h) => el('th', { text: h })))]);
    const body = el('tbody', {}, shown.map((x) => {
      const n = now[x.id] || {};
      const unit = n.unit || '';
      const moved = n.value === undefined || x.baseline.value === undefined || n.value === x.baseline.value ? 'flat' : (n.value < x.baseline.value) === (n.better === 'lower') ? 'up' : 'down';
      const review = x.status === 'running' ? `${fmtDate(x.reviewAt)}${x.keptGoing ? ` · kept going ${x.keptGoing === 1 ? 'once' : `${x.keptGoing} times`}` : ''}` : '';
      const ended = { accepted: 'Ended · accepted', reverted: 'Ended · reverted', replaced: 'Ended · replaced' };
      const revert = el('button', { class: 'btn', type: 'button', text: 'Revert', title: 'Put back what this change replaced, and end the experiment' });
      revert.addEventListener('click', () => void (async () => {
        $('x-error').textContent = '';
        try {
          await api(`/experiments/${encodeURIComponent(x.id)}`, { method: 'POST', body: JSON.stringify({ action: 'revert' }) });
        } catch (err) {
          if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
          $('x-error').textContent = err.message;
          return;
        }
        await renderExperiments();
      })());
      return el('tr', {}, [
        el('td', {}, [el('b', { text: x.title }), x.overlaps && x.overlaps.length && x.status === 'running' ? el('span', { class: 'small muted', text: ' · overlaps another experiment', title: x.overlaps.join(', ') }) : null]),
        el('td', { text: x.advisor }),
        el('td', {}, [el('span', { class: 'pill scope', text: scopeText(x.scope) })]),
        el('td', { class: 'mono', text: changeText(x.change) }),
        el('td', { text: fmtDate(x.startedAt) }),
        el('td', { text: review }),
        el('td', { text: n.label || x.baseline.measure }),
        el('td', { class: 'num', text: x.baseline.value === undefined ? '—' : format(x.baseline.value, unit) }),
        el('td', { class: `num ${moved}`, text: n.value === undefined ? '—' : format(n.value, unit) }),
        el('td', {}, [el('span', { class: `pill ${x.status === 'running' ? 'run' : 'ended'}`, text: x.status === 'running' ? 'Running' : ended[x.ended && x.ended.how] || 'Ended' })]),
        el('td', {}, [x.status === 'running' ? revert : null]),
      ]);
    }));
    $('x-table').replaceChildren(head, body);
    if (!experiments.length) $('x-table').replaceChildren(el('caption', { class: 'empty', text: "No experiments yet. When you accept an advisor's report, each accepted proposal is applied and tracked here." }));
  }
  async function renderExperiments() {
    experimentsData = await api('/experiments');
    const keep = (id, values, label) => {
      const was = $(id).value;
      $(id).replaceChildren(el('option', { value: '', text: `${label}: All` }), ...values.map((v) => el('option', { value: v, text: `${label}: ${v}` })));
      $(id).value = values.includes(was) ? was : '';
    };
    keep('x-project', [...new Set(experimentsData.experiments.map((x) => scopeText(x.scope)))].sort(), 'Project');
    keep('x-advisor', [...new Set(experimentsData.experiments.map((x) => x.advisor))].sort(), 'Advisor');
    $('count-experiments').textContent = String(experimentsData.experiments.filter((x) => x.status === 'running').length || '');
    if (!experimentsWired) {
      experimentsWired = true;
      for (const id of ['x-project', 'x-advisor', 'x-status']) $(id).addEventListener('change', () => experimentsData && experimentRows());
      $('x-search').addEventListener('input', () => experimentsData && experimentRows());
    }
    experimentRows();
  }

  // --- The review on the advisor page (snagboat-79f.7.13) ------------------------------------------------
  // Mark each proposal, switch until you send, then Accept report or Revise report. The page only calls
  // the core's routes; the same review works from an agent session through MCP.
  let reviewing = null; // the advisor whose report is shown
  let reviewPoll = null;
  async function act(fn) {
    $('report-error') && ($('report-error').textContent = '');
    try {
      await fn();
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
      if ($('report-error')) $('report-error').textContent = err.message;
      return;
    }
    if (reviewing) await renderReport(reviewing);
  }
  function mark(p, m, note) {
    return act(() => api(`/proposals/${encodeURIComponent(p.id)}`, { method: 'POST', body: JSON.stringify({ mark: m, ...(note !== undefined ? { note } : {}) }) }));
  }
  function reportActions(view, p) {
    const open = view.review.state === 'open';
    const carried = p.rev < view.review.rev && p.status === 'accepted';
    if (!open || carried) return el('span', { class: `mark ${p.status}`, text: carried && open ? 'Accepted · kept from the last revision' : MARKS[p.status] || p.status });
    const button = (m, label, on) => {
      const b = el('button', { class: `btn${on ? ' on' : ''}`, type: 'button', text: label, 'aria-pressed': on ? 'true' : 'false' });
      b.addEventListener('click', () => (m === 'revise' ? showNote() : void mark(p, m)));
      return b;
    };
    const noteId = `note-${p.id}`;
    const box = el('div', { class: 'note-edit', hidden: p.status !== 'revised' ? '' : null }, [
      el('label', { class: 'sr-only', for: noteId, text: `What to change in "${p.title}"` }),
      el('textarea', { id: noteId, rows: '2', maxlength: '1000', placeholder: 'What should change? Your note goes back to the advisor.' }),
      el('button', { class: 'btn', type: 'button', text: 'Save note' }),
    ]);
    if (p.status !== 'revised') box.hidden = true;
    const area = box.querySelector('textarea');
    area.value = p.note || '';
    box.querySelector('button').addEventListener('click', () => void mark(p, 'revise', area.value));
    function showNote() {
      box.hidden = false;
      area.focus();
    }
    return el('div', { class: 'review-acts' }, [
      el('div', { class: 'btns' }, [button('accept', 'Accept proposal', p.status === 'accepted'), button('discard', 'Discard proposal', p.status === 'discarded'), button('revise', 'Revise (with note)', p.status === 'revised')]),
      box,
    ]);
  }
  function reportFoot(a, view) {
    reviewing = a;
    clearTimeout(reviewPoll);
    const rv = view.review;
    const ask = el('button', { class: 'btn ghost', type: 'button', text: 'Ask for a report now', title: 'A report from the last one to now' });
    ask.addEventListener('click', () => void act(() => api(`/advisors/${encodeURIComponent(a.id)}/report`, { method: 'POST' })));
    const err = el('span', { class: 'err', id: 'report-error', role: 'alert' });
    if (rv.state === 'revising') {
      // The advisor is answering your notes; look again shortly.
      reviewPoll = setTimeout(() => {
        if (reviewing === a && !$('view-advisor').hidden) void renderReport(a);
      }, 3000);
      return [el('span', { class: 'small muted', text: 'Sent back to revise; the advisor is answering your notes.' }), err];
    }
    if (rv.state === 'open') {
      const accepted = view.proposals.filter((p) => p.status === 'accepted').length;
      const summary = rv.unmarked ? `${rv.marked} of ${rv.marked + rv.unmarked} marked` : `${accepted} accepted${rv.toRevise ? ` · ${rv.toRevise} to revise` : ''}${view.proposals.length - accepted - rv.toRevise ? ` · ${view.proposals.length - accepted - rv.toRevise} discarded` : ''}`;
      const send = el('button', { class: 'btn primary', type: 'button', text: rv.toRevise ? 'Revise report' : 'Accept report', disabled: rv.send ? null : '' });
      if (!rv.send) send.disabled = true;
      send.title = rv.send ? (rv.send === 'accept' ? 'Applies the accepted changes and tracks each as an experiment' : 'Sends your notes back to the advisor') : 'Mark every proposal first';
      send.addEventListener('click', () => void act(() => api(`/advisors/${encodeURIComponent(a.id)}/report/${rv.rev}?id=${encodeURIComponent(view.report.id)}`, { method: 'POST' })));
      return [el('span', { class: 'small muted', text: `${summary}. You can switch a choice until you send.` }), el('div', { class: 'btns' }, [err, send])];
    }
    const done = rv.state === 'accepted' ? [el('span', { class: 'small muted' }, [document.createTextNode('Accepted: the accepted changes are running as '), el('a', { href: '#view=experiments', text: 'experiments' }), document.createTextNode('.')])] : [];
    return [...done, el('div', { class: 'btns' }, [err, ask])];
  }

  function showProblems(problems) {
    $('problems').hidden = !problems || problems.length === 0;
    $('problems').textContent = problems && problems.length ? `Problems in your advisors' persona.md files: ${problems.join('; ')}` : '';
  }
  const VIEWS = ['advisors', 'advisor', 'add', 'sessions', 'session', 'plans', 'suggestions', 'experiments'];
  function showView(name) {
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
    // The nav marks the section you're in: an advisor's page is under Advisors, a session's under Sessions.
    const section = { advisor: 'advisors', add: 'advisors', session: 'sessions' }[name] || name;
    for (const n of ['advisors', 'sessions', 'plans', 'suggestions', 'experiments']) {
      $(`nav-${n}`).classList.toggle('on', n === section);
      if (n === section) $(`nav-${n}`).setAttribute('aria-current', 'page');
      else $(`nav-${n}`).removeAttribute('aria-current');
    }
    // The period applies to advisors' measures only.
    for (const e of document.querySelectorAll('[data-advisors-only]')) e.hidden = name !== 'advisors' && name !== 'advisor';
    if (name !== 'sessions') state.sessionLimit = SESSIONS_PAGE;
  }
  /** Which view the address names: #advisor=<id>, #session=<id>, #view=sessions|add|plans|suggestions|experiments, else the advisors. */
  function route() {
    const f = fragment();
    if (f.get('advisor')) return ['advisor', f.get('advisor')];
    if (f.get('session')) return ['session', f.get('session')];
    if (['sessions', 'add', 'plans', 'suggestions', 'experiments'].includes(f.get('view'))) return [f.get('view')];
    return ['advisors'];
  }

  // --- Sessions and one session (RFC step 5b) ----------------------------------------------------------
  // The two session drawings (media/drawings) draw a session as VS Code's Sessions tab does; the core
  // serves them beside this page, and they load the first time a session is shown.
  let drawingsLoading = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el('script', { src });
      s.addEventListener('load', resolve);
      s.addEventListener('error', () => reject(new Error(`couldn't load ${src}`)));
      document.body.append(s);
    });
  }
  function loadDrawings() {
    drawingsLoading ??= (async () => {
      for (const f of ['drawings/kit.js', 'drawings/turnTree.js', 'drawings/contextTimeline.js']) await loadScript(f);
      const kit = window.snagboatKit;
      return { ...kit, ...kit.tipFor($('tooltip')) };
    })();
    drawingsLoading.catch(() => {
      drawingsLoading = null;
    });
    return drawingsLoading;
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
    const [ctx, page] = await Promise.all([loadDrawings(), api(`/sessions/${encodeURIComponent(id)}/view?workspace=${encodeURIComponent(state.workspace)}`)]);
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
      sessionUi.tree = window.snagboatDrawings.turnTree($('tree-host'), c);
      sessionUi.timeline = window.snagboatDrawings.contextTimeline($('timeline-host'), c);
      $('whole').onclick = () => sessionUi.timeline?.zoomAll();
    }
    if (!sessionUi.view || sessionUi.view.summary.sessionId !== s.sessionId) {
      sessionUi.focusId = 's';
      sessionUi.selectedTurn = null;
    }
    sessionUi.view = v;
    $('session-h').textContent = sessionTitle(s);
    $('session-meta').textContent = [agentLabel(s.agent), ...s.models, lengthText(s.firstTs, s.lastTs), plural(s.prompts, 'prompt'), plural(s.toolCalls, 'tool call'), `${compactNumber(s.tokens)} tokens`, startedText(s.firstTs)].join(' · ');
    $('session-outcomes').replaceChildren(...(page.outcomes.length ? page.outcomes.map(outcomeChip) : [el('span', { class: 'empty', text: 'Nothing recorded yet. Tests going green, commits and what became of them, and how you met its findings show here as they happen; commits kept and code survival take 7 days.' })]));
    drawSession();
    $('session-findings').replaceChildren(...(v.findings.length ? sessionFindingRows(v.findings, page.responses) : [el('p', { class: 'empty', text: 'No findings in this session.' })]));
  }

  // --- Adding an advisor (step 5c; by conversation, snagboat-79f.7.16) ------------------------------------
  // The + page is a chat with a model you pick (the core's /advisor-setups routes): talk the goal through,
  // then accept, revise or discard the advisor it proposes. The form stays as the fallback: it writes a new
  // persona.md through the core (POST /advisors), with the built-ins, or the latest proposal, to start from.
  let addForm = null; // { measures, rules, templates, colors, icons } from GET /advisor-form
  let addWired = false; // the form's listeners, added once
  function checkbox(name, value, label, note) {
    return el('label', {}, [el('input', { type: 'checkbox', name, value }), document.createTextNode(label), note ? el('span', { class: 'note', text: note }) : null]);
  }
  function radio(name, value, children) {
    return el('label', {}, [el('input', { type: 'radio', name, value }), ...children]);
  }
  /** Fills the form from a template (a built-in, named "(yours)"), from a proposal (asIs), or blank. */
  function fillAdd(t, asIs = false) {
    $('add-name').value = t ? (asIs ? t.name : `${t.name} (yours)`) : '';
    $('add-status').value = t ? t.status : '';
    $('add-goal').value = t ? t.goal : '';
    $('add-max').value = String(t ? t.maxPerHour : 2);
    $('add-period').value = t ? t.period : 'weekly';
    $('add-model').value = t && t.model && addForm.models.some((m) => m.id === t.model) ? t.model : '';
    $('add-voice').value = t ? t.voice : '';
    for (const box of document.querySelectorAll('#add-measures input')) box.checked = !!t && t.measures.includes(box.value);
    for (const box of document.querySelectorAll('#add-rules input')) box.checked = !!t && t.rules.includes(box.value);
    for (const r of document.querySelectorAll('#add-colors input')) r.checked = r.value === (t ? t.color : addForm.colors[0]);
    for (const r of document.querySelectorAll('#add-icons input')) r.checked = r.value === (t ? t.icon : addForm.icons[0]);
  }
  async function renderAdd() {
    await renderAddForm();
    showForm(false); // the conversation first; the form is a click away
    await renderSetup();
  }
  async function renderAddForm() {
    if (addForm) return;
    addForm = await api('/advisor-form');
    $('add-template').replaceChildren(el('option', { value: '', text: 'A blank advisor' }), ...addForm.templates.map((t) => el('option', { value: t.from, text: `A copy of ${t.name}` })));
    $('add-measures').replaceChildren(...addForm.measures.map((m) => checkbox('measure', m.id, m.label, m.notYet ? 'not measured yet' : '')));
    $('add-rules').replaceChildren(...addForm.rules.map((r) => checkbox('rule', r.id, r.title ? `${r.id}: ${r.title}` : r.id)));
    $('add-period').replaceChildren(...addForm.periods.map((p) => el('option', { value: p, text: p[0].toUpperCase() + p.slice(1) })));
    $('add-model').replaceChildren(el('option', { value: '', text: 'None: numbers only' }), ...addForm.models.map((m) => el('option', { value: m.id, text: m.model ? `${m.label} (${m.model})` : m.label })));
    $('add-colors').replaceChildren(...addForm.colors.map((c) => radio('color', c, [el('span', { class: `glyph cue-${c}` }, [glyph('default', 14)]), document.createTextNode(c)])));
    $('add-icons').replaceChildren(...addForm.icons.map((i) => radio('icon', i, [el('span', { class: 'glyph' }, [glyph(i, 16)]), document.createTextNode(i)])));
    fillAdd(null);
    if (addWired) return;
    addWired = true;
    wireSetup();
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
        period: $('add-period').value,
        model: $('add-model').value,
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

  // --- The setup conversation (snagboat-79f.7.16) ------------------------------------------------------------
  // A draft is named in the address (#view=add&setup=<id>), so a reload comes back to it. Nothing is sent
  // before a model is picked; the picker stays, to switch on any turn. The model answers in the background
  // (the first request waits for your approval, shown here), so the page looks again while it's asking.
  let setupView = null; // GET /advisor-setups/:id, or null before your first message
  let setupList = null; // GET /advisor-setups: drafts, and the models you can pick
  let setupPoll = null;
  function setupId() {
    return fragment().get('setup') || '';
  }
  function modelName(models, m) {
    if (!m) return 'the model';
    const known = (models || []).find((x) => x.id === m.advisor);
    return `${known ? known.label : m.advisor}${m.model ? ` (${m.model})` : ''}`;
  }
  /** A conversation's turns as chat bubbles, each answer naming the model that gave it. Read only. */
  function setupTurns(setup, models) {
    return setup.turns.map((t) => {
      const switched = t.from === 'you' && t.model ? ` · switched to ${modelName(models, t.model)}` : '';
      const who = t.from === 'model' ? modelName(models, t.model || setup.model) : `${t.revise ? 'Your note on the proposal' : 'You'}${switched}`;
      return el('div', { class: `turn ${t.from}${t.revise ? ' revise' : ''}` }, [
        el('span', { class: 'who small muted', text: who }),
        t.text ? el('p', { text: t.text }) : el('p', { class: 'small muted', text: 'Asked this model to answer instead.' }),
        t.from === 'model' && !t.proposal && t.problems && t.problems.length ? el('p', { class: 'small rejected', text: `Snagboat couldn't use what it proposed: ${t.problems.join(' ')}` }) : null,
      ]);
    });
  }
  /** The latest proposal anywhere in the conversation, for the form to start from. */
  function latestProposal(setup) {
    for (let i = setup.turns.length - 1; i >= 0; i--) if (setup.turns[i].proposal) return setup.turns[i].proposal;
    return null;
  }
  function measureLabel(id) {
    const m = addForm && addForm.measures.find((x) => x.id === id);
    return m ? m.label : id;
  }
  /** The proposed advisor as a card, like a report's proposals: Accept, Revise (with note) and Discard while it's open. */
  function setupProposalCard(view) {
    const { setup } = view;
    const p = setup.proposal.spec;
    const rows = [
      el('div', { class: 'prop-head' }, [el('b', {}, [el('span', { class: `glyph cue-${p.color}` }, [glyph(p.icon, 14)]), document.createTextNode(` ${p.name}`)]), el('span', { class: 'pill scope', text: `reports ${p.period}` })]),
      el('span', { class: 'kind', text: `New advisor · goal ${p.goal}` }),
      el('span', { class: 'change', text: p.status }),
      el('span', { class: 'why', text: `Measures: ${p.measures.map(measureLabel).join(', ')}.` }),
      el('span', { class: 'why', text: `Speaks for ${p.rules.length ? p.rules.join(', ') : 'no rules'} · notifies ${p.maxPerHour === 0 ? 'never' : `at most ${p.maxPerHour} an hour`} · its reports are written by ${modelName(view.models, { advisor: p.model || setup.model.advisor })}` }),
      el('div', { class: 'pred' }, [el('b', { text: 'Voice' }), document.createTextNode(p.voice || 'The default: it says plainly what it sees, with the numbers behind it.')]),
    ];
    if (setup.status !== 'open') return el('article', { class: 'prop', 'aria-label': p.name }, [...rows, el('span', { class: `mark ${setup.status === 'accepted' ? 'accepted' : ''}`, text: setup.status === 'accepted' ? 'Accepted' : 'Discarded' })]);
    const accept = el('button', { class: 'btn primary', type: 'button', text: 'Accept', title: 'Writes its persona.md and opens its page' });
    accept.addEventListener('click', () => void setupAct(async () => {
      const r = await api(`/advisor-setups/${encodeURIComponent(setup.id)}/proposal`, { method: 'POST', body: JSON.stringify({ action: 'accept', turn: setup.proposal.turn }) });
      if (!r.advisor) return true;
      addForm = null; // fresh choices (the new advisor's name is taken) next time
      location.hash = `#${new URLSearchParams({ days: String(state.days), advisor: r.advisor.id }).toString()}`;
      return false;
    }));
    const noteId = `setup-note-${setup.proposal.turn}`;
    const box = el('div', { class: 'note-edit' }, [
      el('label', { class: 'sr-only', for: noteId, text: `What to change in ${p.name}` }),
      el('textarea', { id: noteId, rows: '2', maxlength: '4000', placeholder: 'What should change? Your note goes back to the model, and the conversation goes on.' }),
      el('button', { class: 'btn', type: 'button', text: 'Send note' }),
    ]);
    box.hidden = true;
    const area = box.querySelector('textarea');
    box.querySelector('button').addEventListener('click', () => void setupAct(async () => {
      await api(`/advisor-setups/${encodeURIComponent(setup.id)}/proposal`, { method: 'POST', body: JSON.stringify({ action: 'revise', note: area.value, ...pickedModel(setup) }) });
      return true;
    }));
    const revise = el('button', { class: 'btn', type: 'button', text: 'Revise (with note)' });
    revise.addEventListener('click', () => {
      box.hidden = false;
      area.focus();
    });
    const discard = el('button', { class: 'btn', type: 'button', text: 'Discard', title: 'Drops this draft; its record is kept' });
    discard.addEventListener('click', () => void discardSetup());
    return el('article', { class: 'prop', 'aria-label': p.name }, [...rows, el('div', { class: 'review-acts' }, [el('div', { class: 'btns' }, [accept, revise, discard]), box])]);
  }
  /** The model to switch to, when the picker names another than the conversation's. */
  function pickedModel(setup) {
    const m = $('setup-model').value;
    return m && (!setup || m !== setup.model.advisor) ? { model: m } : {};
  }
  /** Runs a setup action, then draws the conversation again (unless it returns false); shows what failed. */
  async function setupAct(fn) {
    $('setup-error').textContent = '';
    let again = true;
    try {
      again = await fn();
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core.');
      $('setup-error').textContent = err.message;
    }
    if (again !== false) await renderSetup().catch((err) => ($('setup-error').textContent = err.message));
  }
  function discardSetup() {
    const id = setupId();
    if (!id) return Promise.resolve();
    return setupAct(async () => {
      await api(`/advisor-setups/${encodeURIComponent(id)}/proposal`, { method: 'POST', body: JSON.stringify({ action: 'discard' }) });
      return true;
    });
  }
  /** Where the model's answer to your last turn stands: asking (and the approval it waits for), failed, or not sent. */
  function setupAskState(view) {
    const { setup, ask } = view;
    const again = (label) => {
      const b = el('button', { class: 'btn', type: 'button', text: label });
      b.addEventListener('click', () => void setupAct(async () => {
        await api(`/advisor-setups/${encodeURIComponent(setup.id)}/messages`, { method: 'POST', body: JSON.stringify({ ...pickedModel(setup) }) });
        return true;
      }));
      return b;
    };
    const lastYours = setup.status === 'open' && setup.turns.length > 0 && setup.turns[setup.turns.length - 1].from === 'you';
    if (!ask) return lastYours ? [el('p', { class: 'small muted', text: 'Your last turn has no answer since the core started.' }), el('div', { class: 'btns' }, [again('Ask the model')])] : [];
    if (ask.state === 'failed') return [el('p', { class: 'err', text: `The model couldn't answer: ${ask.error}` }), el('div', { class: 'btns' }, [again('Ask again')])];
    if (ask.state === 'not-sent') return [el('p', { class: 'small muted', text: "The request wasn't sent: it was waiting for your approval and you didn't send it, or it timed out." }), el('div', { class: 'btns' }, [again('Ask again')])];
    if (!ask.approval) return [el('p', { class: 'small muted', text: `Asking ${modelName(view.models, setup.model)}… a local model can take a minute or two.` })];
    const ap = ask.approval;
    const decide = (send) => () =>
      void setupAct(async () => {
        try {
          await api(`/advisor-setups/${encodeURIComponent(setup.id)}/approval`, { method: 'POST', body: JSON.stringify({ id: ap.id, send }) });
        } catch (err) {
          if (!(err instanceof Refused)) throw err; // already answered elsewhere
        }
        return true;
      });
    const sendBtn = el('button', { class: 'btn primary', type: 'button', text: 'Send' });
    sendBtn.addEventListener('click', decide(true));
    const noBtn = el('button', { class: 'btn ghost', type: 'button', text: "Don't send" });
    noBtn.addEventListener('click', decide(false));
    return [
      el('div', { class: 'approval' }, [
        el('b', { text: `Send this to ${ap.advisor} (${ap.model})?` }),
        el('span', { class: 'small muted', text: `${ap.ability ? `${ap.ability}. ` : ''}The first request with this model's address and sending rules waits for you to see exactly what it sends. Once you send it, later requests go without asking.` }),
        el('details', {}, [el('summary', { text: 'The request, exactly as sent' }), el('pre', { class: 'payload', text: ap.payload })]),
        el('div', { class: 'btns' }, [sendBtn, noBtn]),
      ]),
    ];
  }
  /** Draws the + page's conversation: the model picker, the turns, the proposal, and what you can do next. */
  async function renderSetup() {
    clearTimeout(setupPoll);
    const id = setupId();
    setupList = await api('/advisor-setups');
    setupView = null;
    if (id) {
      try {
        setupView = await api(`/advisor-setups/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof Unauthorized) throw err;
        setFragment({ view: 'add' }); // a draft that's gone: start afresh
      }
    }
    const models = setupList.models;
    const setup = setupView && setupView.setup;
    const open = !setup || setup.status === 'open';
    // The picker: what you picked, else the conversation's model; empty until you pick one.
    const was = $('setup-model').value;
    $('setup-model').replaceChildren(el('option', { value: '', text: 'Pick a model…' }), ...models.map((m) => el('option', { value: m.id, text: m.model ? `${m.label} (${m.model})` : m.label })));
    $('setup-model').value = models.some((m) => m.id === was) ? was : setup && models.some((m) => m.id === setup.model.advisor) ? setup.model.advisor : '';
    $('setup-model').disabled = !open || !models.length;
    $('setup-model-hint').textContent = models.length
      ? 'A model on this machine from your advisor settings (snagboat.advisors). You can switch at any turn to try another; each answer shows the model that gave it.'
      : 'No model on this machine offers this. Run a local model (for example Ollama), or add one to snagboat.advisors in your user settings; or fill in the form instead.';
    // An unfinished draft, when you haven't one open here.
    const drafts = setupList.drafts.filter((d) => d.status === 'open' && d.turns.length && d.id !== id);
    $('setup-drafts').hidden = !!setup || !drafts.length;
    if (!setup && drafts.length) {
      const first = drafts[0].turns[0].text || '';
      $('setup-drafts').replaceChildren(
        document.createTextNode(`You have an unfinished conversation from ${fmtDate(drafts[0].startedAt)} ("${first.length > 60 ? `${first.slice(0, 60)}…` : first}"). `),
        el('a', { href: `#${new URLSearchParams({ view: 'add', setup: drafts[0].id }).toString()}`, text: 'Continue it' })
      );
    }
    const parts = setup ? setupTurns(setup, models) : [el('p', { class: 'small muted', text: 'Pick a model, then say what you care about. It asks a question or two, settles a goal with you, and proposes an advisor for it.' })];
    if (setup && setup.proposal) parts.push(setupProposalCard(setupView));
    if (setup && setup.status === 'accepted') parts.push(el('p', { class: 'small' }, [document.createTextNode('Accepted: it made '), el('a', { href: `#${new URLSearchParams({ days: String(state.days), advisor: setup.advisor }).toString()}`, text: setup.advisor }), document.createTextNode('.')]));
    if (setup && setup.status === 'discarded') parts.push(el('p', { class: 'small muted', text: 'Discarded. Its record is kept; start another to try again.' }));
    $('setup-turns').replaceChildren(...parts);
    $('setup-state').replaceChildren(...(setupView ? setupAskState(setupView) : []));
    const asking = !!(setupView && setupView.ask && setupView.ask.state === 'asking');
    $('setup-compose').hidden = !open;
    setSendable(asking);
    $('setup-discard').hidden = !setup || !open;
    $('setup-new').hidden = !setup || open;
    // Look again while the model is asking: often while it thinks, less often while it waits for your approval.
    if (asking) {
      setupPoll = setTimeout(() => {
        if (route()[0] === 'add' && setupId() === id) void renderSetup().catch(() => undefined);
      }, setupView.ask.approval ? 4000 : 1500);
    }
  }
  /** No message before a model is picked, or while the model is answering. */
  function setSendable(asking) {
    const picked = !!$('setup-model').value;
    $('setup-send').disabled = asking || !picked;
    $('setup-send').title = !picked ? 'Pick a model first' : asking ? 'The model is still answering' : '';
  }
  function showForm(show) {
    $('add-form').hidden = !show;
    $('setup-panel').hidden = show;
  }
  /** The chat's listeners, added once with the form's. */
  function wireSetup() {
    $('setup-model').addEventListener('change', () => setSendable(!!(setupView && setupView.ask && setupView.ask.state === 'asking')));
    $('setup-compose').addEventListener('submit', (e) => {
      e.preventDefault();
      const model = $('setup-model').value;
      const text = $('setup-text').value.trim();
      if (!model) {
        $('setup-error').textContent = 'Pick a model first.';
        return;
      }
      if (!text) return;
      $('setup-send').disabled = true;
      void setupAct(async () => {
        const setup = setupView && setupView.setup;
        if (!setup) {
          const v = await api('/advisor-setups', { method: 'POST', body: JSON.stringify({ model, text }) });
          setFragment({ view: 'add', setup: v.setup.id });
        } else {
          await api(`/advisor-setups/${encodeURIComponent(setup.id)}/messages`, { method: 'POST', body: JSON.stringify({ text, ...pickedModel(setup) }) });
        }
        $('setup-text').value = '';
        return true;
      });
    });
    $('setup-text').addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('setup-compose').requestSubmit();
      }
    });
    $('setup-discard').addEventListener('click', () => void discardSetup());
    $('setup-new').addEventListener('click', () => {
      setFragment({ view: 'add' });
      void setupAct(async () => true);
    });
    $('setup-form-link').addEventListener('click', () => {
      // The form, filled in from the latest proposal when there is one.
      const p = setupView && latestProposal(setupView.setup);
      if (p) {
        $('add-template').value = '';
        fillAdd(p, true);
      }
      showForm(true);
    });
    $('add-chat').addEventListener('click', () => showForm(false));
  }
  /** On an advisor's page: the conversation it was set up with, read only, when it was set up by one. */
  async function renderSetupHistory(a) {
    let v;
    try {
      v = await api(`/advisor-setups?advisor=${encodeURIComponent(a.id)}`);
    } catch (err) {
      if (err instanceof Unauthorized) throw err;
      $('setup-history').hidden = true;
      return;
    }
    const s = v.setup;
    const models = (setupList && setupList.models) || [];
    $('setup-history').hidden = false;
    $('setup-history-meta').textContent = `· ${fmtDate(s.startedAt)}, ${s.turns.length} turn${s.turns.length === 1 ? '' : 's'}`;
    $('setup-history-turns').replaceChildren(...setupTurns(s, models), ...(s.proposal ? [setupProposalCard({ setup: s, models })] : []));
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
  };
  function showSuggestions(view) {
    window.postMessage({ type: 'suggestions', view }, location.origin);
    clearTimeout(suggestionsPoll);
    // Discovery runs in the core; look again until it's done.
    if (view.status === 'running' && route()[0] === 'suggestions') suggestionsPoll = setTimeout(() => void refreshSuggestions(), 1500);
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
    const make = SUGGESTION_ACTIONS[m.type];
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
      await loadDrawings();
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

  // --- Plans (#view=plans) ---------------------------------------------------------------------
  // GET /plans: the workspace's plan items (and its other worktrees'), with their transitions and the
  // sessions, commits and branches the linker linked to each. plans.js draws them; this keeps the
  // filters, which items are open, and the last answer, so the timer redraws only when it changes.
  const plansUi = { statuses: null, query: '', open: new Set(), data: null, json: null, wired: false };
  function plansKit() {
    return window.snagboatPlans;
  }
  function wirePlans() {
    if (plansUi.wired) return;
    plansUi.wired = true;
    const P = plansKit();
    plansUi.statuses = new Set(P.STATUSES);
    $('p-search').addEventListener('input', () => {
      plansUi.query = $('p-search').value;
      drawPlans();
    });
    // toggle doesn't bubble; a capturing listener on the list still hears every item's.
    $('plans-root').addEventListener(
      'toggle',
      (e) => {
        const d = e.target;
        if (!(d instanceof HTMLElement) || !d.matches('details.pi')) return;
        if (d.open) plansUi.open.add(d.dataset.item);
        else plansUi.open.delete(d.dataset.item);
      },
      true
    );
    // A session of another worktree is in that workspace's store: switch to it, then open the session.
    $('plans-root').addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[data-session]') : null;
      const ws = a && a.dataset.workspace;
      if (ws && ws !== state.workspace && [...$('workspace').options].some((o) => o.value === ws)) {
        state.workspace = ws;
        $('workspace').value = ws;
      }
    });
  }
  function statusFilters(counts) {
    const P = plansKit();
    $('p-statuses').replaceChildren(
      ...P.STATUSES.map((st) => {
        const box = el('input', { type: 'checkbox', value: st });
        box.checked = plansUi.statuses.has(st);
        box.addEventListener('change', () => {
          if (box.checked) plansUi.statuses.add(st);
          else plansUi.statuses.delete(st);
          drawPlans();
        });
        return el('label', { class: `p-st st-${st}` }, [box, el('span', { text: `${P.STATUS_TEXT[st]} ` }), el('span', { class: 'muted', text: String(counts[st] || 0) })]);
      })
    );
  }
  function plansMessage(title, lines) {
    $('plans-root').replaceChildren(el('div', { class: 'message' }, [el('b', { text: title }), ...lines.map((l) => (typeof l === 'string' ? el('span', { text: l }) : l))]));
  }
  const code = (t) => el('code', { text: t });
  function drawPlans() {
    const P = plansKit();
    const view = plansUi.data;
    if (!view) return;
    const counts = P.statusCounts(view.items);
    statusFilters(counts);
    const others = view.workspaces.filter((w) => w !== view.workspace);
    $('plans-note').textContent = `${plural(view.items.length, 'item')}${view.prefix ? ` · beads prefix ${view.prefix}` : ''}${others.length ? ` · with ${plural(others.length, 'other worktree')}` : ''}`;
    $('count-plans').textContent = view.items.length ? String(view.items.length) : '';
    if (view.items.length === 0) {
      $('p-count').textContent = '';
      return plansMessage('No plan records for this workspace yet', [
        el('span', {}, [
          "The core's plan job writes them to the workspace's ",
          code('plan.jsonl'),
          ': from Beads (',
          code('bd --readonly export'),
          ' and its history) when the project has a ',
          code('.beads'),
          ' folder and bd is installed here, or else from the planning markdown under ',
          code('docs/'),
          ' (headings, numbered steps, checklists), marked inferred. It runs every 5 minutes while a session in the project is active, hourly otherwise.',
        ]),
        el('span', {}, [
          'In a dev container, where bd runs only inside: ',
          code('snagboat containers allow --edit'),
          ' adds the beads exporter, which writes ',
          code('.snagboat/beads/'),
          ' for the core here to read. Rebuild or restart the container, then give it a few minutes.',
        ]),
        el('span', {}, ['Links to sessions, commits and branches follow once the repository job and the linker have run.']),
      ]);
    }
    const shown = P.filterTree(P.planTree(view.items), { statuses: plansUi.statuses, query: plansUi.query });
    const hits = view.items.filter((v) => P.matches(v.item, { statuses: plansUi.statuses, query: plansUi.query })).length;
    $('p-count').textContent = hits === view.items.length ? '' : `${hits} of ${view.items.length} shown`;
    if (shown.length === 0) return $('plans-root').replaceChildren(el('p', { class: 'empty', text: 'No items match these filters.' }));
    const r = P.renderers(el, { isOpen: (id) => plansUi.open.has(id) });
    $('plans-root').replaceChildren(r.tree(shown));
  }
  async function renderPlans(timer = false) {
    wirePlans();
    const ws = state.workspace;
    const text = JSON.stringify(await api(`/plans?workspace=${encodeURIComponent(ws)}`));
    if (ws !== state.workspace) return;
    if (timer && text === plansUi.json) return;
    plansUi.json = text;
    plansUi.data = JSON.parse(text);
    drawPlans();
  }
  /** What went wrong fetching the plans, in the view. */
  function plansError(err) {
    plansUi.json = null;
    plansUi.data = null;
    if (err.status === 403) return plansMessage("This page can't read that workspace", [String(err.message), el('span', {}, ['Open the advisor UI again with ', code('snagboat open'), ' for a key that reads every workspace.'])]);
    if (err.status === 404) return plansMessage('Nothing recorded for this workspace yet', [String(err.message), "The core makes a workspace's store with its first events: start an agent session in the project."]);
    if (err instanceof TypeError) return plansMessage('The core is not answering', [el('span', {}, ['Start it with ', code('snagboat core start'), ' (or open this page again with ', code('snagboat open'), ', which starts it), then reload.'])]);
    return plansMessage("Couldn't load the plans", [String(err.message || err)]);
  }

  // --- The page ------------------------------------------------------------------------
  const state = { workspace: null, days: 7, advisors: [], sessionLimit: SESSIONS_PAGE };

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

  /** Draws the view the address names; on the timer, the form and Suggestions are left alone. */
  async function refresh(timer = false) {
    const [view, id] = route();
    if (timer && (view === 'add' || view === 'suggestions')) return;
    if (view !== 'plans') plansUi.json = null;
    try {
      const health = await api('/health');
      setStatus('ok', `core ${health.version}`);
      remember(WORKSPACE_KEY, state.workspace);
      showView(view);
      if (view === 'advisor') await renderAdvisor(id);
      else if (view === 'session') await renderSession(id);
      else if (view === 'sessions') await renderSessions();
      else if (view === 'plans') await renderPlans(timer);
      else if (view === 'add') await renderAdd();
      else if (view === 'suggestions') await renderSuggestions();
      else if (view === 'experiments') await renderExperiments();
      else await renderAdvisors();
    } catch (err) {
      if (err instanceof Unauthorized) return needLink('This page has lost its connection to the core: the core restarted, or the link was already used.');
      if (view === 'plans') plansError(err);
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
        for (const box of ['session-outcomes', 'session-findings']) $(box).replaceChildren();
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
