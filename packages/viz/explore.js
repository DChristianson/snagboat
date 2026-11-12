// Snagboat Explore tab (experimental): a session picker, a carousel with one
// slide per visualizer in the catalog, and a puck that names the current
// visualizer and filters the carousel by its tags. See
// docs/design/visualization-explorer.md. Nothing here knows about VS Code:
// the tab sees only ctx (the visualization kit and the tooltip) and a source
// object, so the web demo mounts the same file over a source of its own.
// Plain DOM; all data is written with textContent, never innerHTML.
//
//   window.factoryClockExplore.mount(root, source, ctx) -> { shown(), destroy() }
//   window.factoryClockExplore.shown()  forwards to the mounted tab (for the page's tab switch)
//   window.factoryClockExplore.hidden() the tab was hidden: every slide stops (setActive(false))
//
// source, a plain object:
//   listSessions()       ask for every session, newest start first; answered through onSessions
//   loadSessions(ids)    load these sessions for the explorer, in this order; answered through onExplorer
//   closeExplorer()      unload them; answered through onExplorer with null
//   getState()           the tab's saved state, {} the first time
//   setState(partial)    merge these keys into the saved state
//   onSessions(cb)       cb({ sessions, headlines }) on each list push
//   onExplorer(cb)       cb(ExplorerState | null) on each explorer push (packages/viz/src/explorerModel.ts)
//   openSessionId()      the session open in the Sessions tab, or null (pre-checked the first time)
//
// ctx: the helpers from vizkit.js plus tooltip, showTip(evt, rows), hideTip(). The tab adds
// select(selection) for each visualizer it mounts (see packages/viz/viz/registry.js).
//
// Saved state: { picked: string[], current: visualizer id, filters: { facet: [values] }, replay: { speed, loop },
// collapsed: boolean, corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
// selection: { sessionId?, turnId?, range?, focusId? } | null }.
(function () {
  // The most sessions the picker allows; matches EXPLORE_SESSION_CAP in packages/viz/src/catalog.ts.
  const CAP = 8;
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  // The strip never gets shorter than this; in a window too short for it, the page scrolls and the nav sticks to the window's bottom.
  const MIN_STRIP_HEIGHT = 320;
  // Below the nav: the body's bottom padding, and a little air.
  const BELOW_NAV = 16;
  const DRAG_THRESHOLD = 4; // px of movement before a press on the puck's head counts as a drag
  let mounted = null;

  function mount(root, source, ctx) {
    const viz = window.factoryClock;
    const { el, compact, fmt, clip, short, duration, agentName, modelShort, ms } = ctx;
    const saved = source.getState() || {};
    const st = {
      picked: Array.isArray(saved.picked) ? saved.picked.slice(0, CAP) : null, // null until the first show pre-checks the open session
      currentId: typeof saved.current === 'string' ? saved.current : null,
      filters: saved.filters && typeof saved.filters === 'object' ? saved.filters : {},
      collapsed: saved.collapsed !== false, // starts collapsed
      corner: CORNERS.includes(saved.corner) ? saved.corner : 'bottom-right',
      selection: saved.selection && typeof saved.selection === 'object' ? saved.selection : null,
      list: null, // { sessions, headlines }
      taxonomy: null,
      catalog: [],
      sessions: [], // SessionView[] loaded, in picked order
      notLoaded: [],
      requested: false, // whether this page already asked for the picked sessions
    };
    const save = (partial) => source.setState(partial);
    // The hero views' playback settings (speed, loop) are shared by every replay and remembered with the tab.
    if (saved.replay && typeof ctx.setReplayPrefs === 'function') ctx.setReplayPrefs(saved.replay);
    const stopReplayPrefs = typeof ctx.onReplayPrefs === 'function' ? ctx.onReplayPrefs((prefs) => save({ replay: prefs })) : () => {};
    const isLive = (s) => Date.now() - ms(s.lastTs) < 10 * 60 * 1000;
    const sessionLabel = (s) => (s.name ? clip(s.name, 48) : short(s.sessionId));

    // ---------- layout ----------
    const pickNote = el('span', { class: 'muted small' });
    const loadBtn = el('button', { text: 'Load', title: 'Load the picked sessions into the explorer' });
    loadBtn.addEventListener('click', () => {
      if (!st.picked || !st.picked.length) return;
      st.requested = true;
      source.loadSessions(st.picked);
    });
    const unloadBtn = el('button', { text: 'Unload', title: 'Drop the loaded sessions', hidden: true });
    unloadBtn.addEventListener('click', () => {
      st.requested = true;
      source.closeExplorer();
    });
    const listHost = el('div', { class: 'session-list' });
    const loadedNote = el('p', { class: 'muted small' });
    const picker = el('section', { class: 'picker', 'aria-label': 'Pick sessions' }, [
      el('div', { class: 'controls' }, [el('span', { class: 'muted small', text: 'Sessions, newest first' }), el('span', { class: 'spacer' }), pickNote, loadBtn, unloadBtn]),
      listHost,
      loadedNote,
    ]);

    const strip = el('div', { class: 'strip', tabindex: 0, role: 'group', 'aria-label': 'Visualizers; the arrow keys move between them' });
    const prevBtn = el('button', { text: '‹ Previous', 'aria-label': 'Previous visualizer' });
    const nextBtn = el('button', { text: 'Next ›', 'aria-label': 'Next visualizer' });
    const dots = el('div', { class: 'dots', role: 'group', 'aria-label': 'Go to a visualizer' });
    const navNote = el('span', { class: 'muted small', 'aria-live': 'polite' });
    const toPicker = el('button', { class: 'link to-picker', text: 'Sessions ↓', title: 'Pick and load sessions, below the carousel' });
    toPicker.addEventListener('click', () => picker.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const nav = el('div', { class: 'nav' }, [prevBtn, dots, nextBtn, navNote, toPicker]);
    const carousel = el('section', { class: 'carousel', 'aria-label': 'Visualizers' }, [strip, nav]);
    prevBtn.addEventListener('click', () => step(-1));
    nextBtn.addEventListener('click', () => step(1));
    strip.addEventListener('keydown', (e) => {
      if (e.target !== strip) return; // a visualizer's own focusable parts keep their keys
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    });

    const puckTitle = el('strong', { text: 'Explore' });
    const puckPos = el('span', { class: 'muted small' });
    const collapseBtn = el('button', { class: 'link puck-toggle', 'aria-expanded': String(!st.collapsed) });
    collapseBtn.addEventListener('click', () => {
      st.collapsed = !st.collapsed;
      save({ collapsed: st.collapsed });
      renderCollapsed();
    });
    const puckDesc = el('p', { class: 'muted small puck-desc' });
    const facets = el('div');
    const filterNote = el('span', { class: 'muted small' });
    const clearBtn = el('button', { class: 'link', text: 'Clear' });
    clearBtn.addEventListener('click', () => {
      st.filters = {};
      save({ filters: st.filters });
      applyFilters('smooth');
    });
    const mismatchNote = el('p', { class: 'muted small', hidden: true });
    const puckBody = el('div', { class: 'puck-body' }, [puckDesc, facets, el('div', { class: 'puck-foot' }, [filterNote, el('span', { class: 'spacer' }), clearBtn]), mismatchNote]);
    const puckHead = el('div', { class: 'puck-head' }, [puckTitle, puckPos, collapseBtn]);
    const puck = el('aside', { class: 'puck', 'aria-label': 'Current visualizer and tag filters' }, [puckHead, puckBody]);
    function renderCollapsed() {
      puck.classList.toggle('collapsed', st.collapsed);
      const label = st.collapsed ? 'Expand' : 'Collapse';
      collapseBtn.textContent = label;
      collapseBtn.title = `${label}. Drag, or press an arrow key, to move the puck to another corner.`;
      collapseBtn.setAttribute('aria-expanded', String(!st.collapsed));
    }
    renderCollapsed();

    // The puck sits in one of the window's corners. The carousel hears which, so its nav can stand clear.
    function placePuck(corner) {
      st.corner = corner;
      puck.dataset.corner = corner;
      carousel.dataset.puck = corner;
    }
    function movePuck(corner) {
      placePuck(corner);
      save({ corner });
    }
    placePuck(st.corner);

    // Dragging by the head (the whole circle when collapsed) drops the puck in the corner of the quadrant it's let go in.
    // Move and up are heard on the window: a quick drag leaves the head before the threshold is crossed.
    let drag = null; // { id, x, y, moved } while pressed
    let dragged = false; // the press that just ended was a drag, so its click isn't a click on the toggle
    const onDragMove = (e) => {
      if (e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        puckHead.setPointerCapture(e.pointerId); // so a release outside the window still ends the drag
        puck.classList.add('dragging');
      }
      puck.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const endDrag = (e, drop) => {
      if (e.pointerId !== drag.id) return;
      const { moved } = drag;
      stopDragging();
      if (!moved) return;
      dragged = true;
      if (drop) movePuck(`${e.clientY < window.innerHeight / 2 ? 'top' : 'bottom'}-${e.clientX < window.innerWidth / 2 ? 'left' : 'right'}`);
    };
    const onDragUp = (e) => endDrag(e, true);
    const onDragCancel = (e) => endDrag(e, false);
    function stopDragging() {
      drag = null;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      window.removeEventListener('pointercancel', onDragCancel);
      puck.classList.remove('dragging');
      puck.style.transform = '';
    }
    puckHead.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      dragged = false;
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
      window.addEventListener('pointercancel', onDragCancel);
    });
    puckHead.addEventListener(
      'click',
      (e) => {
        if (dragged) e.stopPropagation();
        dragged = false;
      },
      true
    );
    // The keyboard's way to the same place: an arrow key crosses to that side, keeping the other axis.
    puckHead.addEventListener('keydown', (e) => {
      const [v, h] = st.corner.split('-');
      const to = { ArrowUp: `top-${h}`, ArrowDown: `bottom-${h}`, ArrowLeft: `${v}-left`, ArrowRight: `${v}-right` }[e.key];
      if (!to) return;
      e.preventDefault();
      movePuck(to);
    });

    // The carousel takes the window; picking and loading sessions sit below it, a scroll (or the nav's button) away.
    root.append(
      carousel,
      el('div', { class: 'below-carousel' }, [el('p', { class: 'muted small', text: 'Experimental: every visualizer draws the same loaded sessions its own way. The puck names the one in view and filters by its tags.' }), picker]),
      puck
    );

    // ---------- pane height ----------
    // The strip takes the height left in the window, so the nav under it stays
    // in view and a drawing taller than that scrolls inside its slide. The
    // height doesn't follow the slide, so the nav stays put between slides.
    function fitStrip() {
      if (!carousel.offsetParent) return; // the tab is hidden; shown() fits it
      const top = strip.getBoundingClientRect().top + window.scrollY;
      strip.style.height = `${Math.max(MIN_STRIP_HEIGHT, window.innerHeight - top - nav.offsetHeight - BELOW_NAV)}px`;
    }

    // ---------- session picker ----------
    function renderPicker() {
      const picked = st.picked || [];
      pickNote.textContent = `${picked.length} of ${CAP} picked`;
      loadBtn.disabled = picked.length === 0;
      const list = st.list;
      if (!list) {
        listHost.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
        return;
      }
      if (list.sessions.length === 0) {
        listHost.replaceChildren(el('p', { class: 'muted', text: 'No agent sessions yet.' }));
        return;
      }
      const rows = list.sessions.map((s) => {
        const on = picked.includes(s.sessionId);
        const box = el('input', { type: 'checkbox', 'aria-label': `Pick ${s.name ? `${s.name} (${short(s.sessionId)})` : s.sessionId}` });
        box.checked = on;
        box.disabled = !on && picked.length >= CAP;
        const toggle = () => {
          const now = st.picked || [];
          if (now.includes(s.sessionId)) st.picked = now.filter((id) => id !== s.sessionId);
          else if (now.length < CAP) st.picked = [...now, s.sessionId];
          else return;
          save({ picked: st.picked });
          renderPicker();
        };
        box.addEventListener('change', toggle);
        const tr = el('tr', { class: on ? 'selected' : undefined, tabindex: 0, 'aria-selected': String(on) }, [
          el('td', { class: 'pick' }, [box]),
          el('td', { text: `${isLive(s) ? '● ' : ''}${new Date(s.firstTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` }),
          el('td', { text: agentName(s.agent) }),
          el('td', { text: s.models.map(modelShort).join(', ') || '—' }),
          el('td', { class: 'num', text: fmt(s.prompts) }),
          el('td', { class: 'num', text: fmt(s.modelCalls) }),
          el('td', { class: 'num', text: compact(s.tokens) }),
          el('td', { class: 'num', text: duration(s.firstTs, s.lastTs) }),
          el('td', { title: s.name ? `${s.name} (${s.sessionId})` : s.sessionId }, [
            ...(s.name ? [el('span', { text: clip(s.name, 48) }), el('span', { class: 'muted', text: ` ${short(s.sessionId)}` })] : [el('span', { class: 'muted', text: short(s.sessionId) })]),
            list.headlines && list.headlines[s.sessionId] ? el('div', { class: 'muted small', text: clip(list.headlines[s.sessionId], 90), title: `Headline by the advisor (model output): ${list.headlines[s.sessionId]}` }) : null,
          ]),
        ]);
        // The row is the checkbox's hit target; the checkbox itself already toggled.
        tr.addEventListener('click', (e) => e.target !== box && toggle());
        tr.addEventListener('keydown', (e) => e.key === 'Enter' && toggle());
        return tr;
      });
      // The list is rebuilt on every pick and push, and can be long now: keep its scroll position.
      const scrolled = listHost.querySelector('.list-wrap');
      const scrollTop = scrolled ? scrolled.scrollTop : 0;
      const wrap = el('div', { class: 'list-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, ['', 'Started', 'Agent', 'Models', 'Prompts', 'Model calls', 'Tokens', 'Span', 'Session'].map((h, i) => el('th', { class: i === 0 ? 'pick' : i >= 4 && i <= 7 ? 'num' : undefined, text: h })))]),
          el('tbody', {}, rows),
        ]),
      ]);
      listHost.replaceChildren(wrap);
      wrap.scrollTop = scrollTop;
    }

    function renderLoaded() {
      unloadBtn.hidden = st.sessions.length === 0;
      if (!st.sessions.length && !st.notLoaded.length) {
        loadedNote.textContent = st.picked && st.picked.length ? 'Nothing loaded yet: press Load to draw the picked sessions.' : 'Nothing loaded: pick sessions here and press Load.';
        return;
      }
      const names = st.sessions.map((v) => sessionLabel(v.summary)).join(', ');
      const missing = st.notLoaded.map(short).join(', ');
      loadedNote.textContent = `Loaded ${st.sessions.length} session${st.sessions.length === 1 ? '' : 's'}: ${names || '—'}.${missing ? ` Not loaded (unknown, or no longer retained): ${missing}.` : ''}`;
    }

    // ---------- carousel ----------
    const slides = []; // [{ entry, slide, host, parts: [{ host, instance, sessionIds }] }] in catalog order
    let io = null;
    let settling = null; // a timer while a programmatic scroll is in flight
    const ratios = new Map(); // slide element -> last intersection ratio

    function matches(entry) {
      return Object.entries(st.filters).every(([facet, vals]) => !vals.length || vals.some((v) => (entry.tags[facet] || []).includes(v)));
    }
    const visible = () => slides.filter((s) => !s.slide.hidden);
    const current = () => slides.find((s) => s.entry.id === st.currentId) || null;

    function buildSlides() {
      for (const s of slides) destroyParts(s);
      slides.length = 0;
      ratios.clear();
      strip.replaceChildren();
      st.catalog.forEach((entry, i) => {
        const host = el('div', { class: 'slide-host' });
        const slide = el('article', { class: 'slide', 'aria-label': entry.title, 'aria-roledescription': 'slide' }, [
          el('div', { class: 'slide-head' }, [el('span', { class: 'muted small', text: `${i + 1}/${st.catalog.length}` }), el('strong', { text: entry.title }), el('span', { class: 'muted small', text: entry.description })]),
          host,
        ]);
        slides.push({ entry, slide, host, parts: [] });
        strip.append(slide);
      });
      if (!current()) st.currentId = st.catalog.length ? st.catalog[0].id : null;
      observe();
      applyFilters('auto');
    }

    // The slide most in view becomes current, except while a scroll we started settles.
    function observe() {
      if (io) io.disconnect();
      io = null;
      if (typeof IntersectionObserver !== 'function') return;
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) ratios.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
          if (!settling) syncCurrent();
        },
        { root: strip, threshold: [0.25, 0.5, 0.75, 1] }
      );
      for (const s of slides) io.observe(s.slide);
    }
    function syncCurrent() {
      let best = null;
      let bestRatio = 0.5;
      for (const s of visible()) {
        const r = ratios.get(s.slide) || 0;
        if (r > bestRatio) {
          best = s;
          bestRatio = r;
        }
      }
      if (best && best.entry.id !== st.currentId) setCurrent(best.entry.id);
    }

    function setCurrent(id) {
      st.currentId = id;
      save({ current: id });
      renderDots();
      renderPuck();
      mountAround();
    }

    function applyFilters(behavior) {
      const vis = slides.filter((s) => matches(s.entry));
      for (const s of slides) s.slide.hidden = !vis.includes(s);
      for (const s of slides) if (s.slide.hidden) destroyParts(s);
      if (!vis.length) {
        renderDots();
        renderPuck();
        return;
      }
      const cur = current();
      if (!cur || cur.slide.hidden) {
        // The nearest slide that stays, by catalog distance.
        const at = cur ? slides.indexOf(cur) : 0;
        const nearest = vis.reduce((best, s) => (Math.abs(slides.indexOf(s) - at) < Math.abs(slides.indexOf(best) - at) ? s : best), vis[0]);
        st.currentId = nearest.entry.id;
        save({ current: st.currentId });
      }
      goTo(st.currentId, behavior);
    }

    function goTo(id, behavior) {
      const s = slides.find((x) => x.entry.id === id);
      if (!s || s.slide.hidden) return;
      st.currentId = id;
      save({ current: id });
      const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      clearTimeout(settling);
      settling = setTimeout(() => {
        settling = null;
        syncCurrent();
      }, 600);
      strip.scrollTo({ left: s.slide.offsetLeft, behavior: reduce || behavior === 'auto' ? 'auto' : 'smooth' });
      renderDots();
      renderPuck();
      mountAround();
    }

    function step(dir) {
      const vis = visible();
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      const next = vis[pos + dir];
      if (next) goTo(next.entry.id, 'smooth');
    }

    function renderDots() {
      const vis = visible();
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      dots.replaceChildren(
        ...vis.map((s) => {
          const d = el('button', { class: 'dot', title: s.entry.title, 'aria-label': s.entry.title, 'aria-current': String(s.entry.id === st.currentId) });
          d.addEventListener('click', () => goTo(s.entry.id, 'smooth'));
          return d;
        })
      );
      const out = slides.length - vis.length;
      navNote.textContent = !slides.length ? '' : vis.length ? `${pos + 1} of ${vis.length}${out ? ` (${out} filtered out)` : ''}` : 'No visualizer has every picked tag.';
      prevBtn.disabled = pos <= 0;
      nextBtn.disabled = pos < 0 || pos >= vis.length - 1;
    }

    // Only the current slide and its two neighbors (in the visible order) are mounted.
    function mountAround() {
      const vis = visible();
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      for (const s of slides) {
        const i = vis.indexOf(s);
        const near = pos >= 0 && i >= 0 && Math.abs(i - pos) <= 1;
        if (near) updateSlide(s);
        else destroyParts(s);
      }
      activate();
    }

    // Only the current slide runs: a visualizer that animates stops while it's a neighbor or the tab is hidden.
    let tabVisible = true;
    function activate() {
      for (const s of slides) {
        const on = tabVisible && s.entry.id === st.currentId && !s.slide.hidden;
        for (const p of s.parts) if (typeof p.instance.setActive === 'function') p.instance.setActive(on);
      }
    }

    function destroyParts(s) {
      for (const p of s.parts) p.instance.destroy();
      s.parts = [];
      s.host.replaceChildren();
    }

    // A session-level visualizer gets one instance per loaded session, stacked
    // under the session's name; any other gets one instance with the whole list.
    function updateSlide(s) {
      const sessions = st.sessions;
      if (!sessions.length) {
        destroyParts(s);
        s.host.replaceChildren(el('p', { class: 'muted', text: 'No sessions loaded. Pick sessions below (Sessions ↓) and press Load.' }));
        return;
      }
      const def = viz.get(s.entry.id);
      if (!def) {
        destroyParts(s);
        s.host.replaceChildren(el('p', { class: 'muted', text: `No renderer is registered for “${s.entry.id}”.` }));
        return;
      }
      const stacked = !(s.entry.tags.level || []).includes('project');
      const groups = stacked ? sessions.map((v) => [v]) : [sessions];
      const wantedIds = groups.map((g) => g.map((v) => v.summary.sessionId).join('\n'));
      const haveIds = s.parts.map((p) => p.sessionIds);
      if (wantedIds.join('\u0000') !== haveIds.join('\u0000')) {
        destroyParts(s);
        s.parts = groups.map((g, i) => {
          const host = el('div', { class: 'viz-host' });
          const part = stacked
            ? el('div', { class: 'stacked' }, [el('div', { class: 'stack-head' }, [el('strong', { text: sessionLabel(g[0].summary) }), el('span', { class: 'muted small', text: ` ${agentName(g[0].summary.agent)} · ${fmt(g[0].summary.prompts)} prompts · ${compact(g[0].summary.tokens)} tokens` })]), host])
            : host;
          s.host.append(part);
          return { host, sessionIds: wantedIds[i], instance: def.mount(host, { ...ctx, select }) };
        });
      }
      s.parts.forEach((p, i) => p.instance.update(groups[i], st.selection, {}));
    }

    // ---------- shared selection ----------
    function select(selection) {
      st.selection = selection || null;
      save({ selection: st.selection });
      for (const s of slides) if (s.parts.length) updateSlide(s);
    }

    // ---------- puck ----------
    function renderPuck() {
      const cur = current();
      const entry = cur && !cur.slide.hidden ? cur.entry : null;
      puckTitle.textContent = entry ? entry.title : st.catalog.length ? 'Nothing matches' : 'Explore';
      puckPos.textContent = entry ? `${slides.indexOf(cur) + 1}/${slides.length}` : '';
      puckDesc.textContent = entry ? entry.description : st.catalog.length ? 'Clear a filter to see visualizers again.' : 'Waiting for the catalog…';
      const tax = st.taxonomy || {};
      facets.replaceChildren(
        ...Object.entries(tax).map(([facet, def]) =>
          el('div', { class: 'facet' }, [
            el('span', { class: 'fname', text: def.label }),
            el(
              'div',
              { class: 'chips' },
              Object.entries(def.values).map(([v, meaning]) => {
                const has = !!entry && (entry.tags[facet] || []).includes(v);
                const on = (st.filters[facet] || []).includes(v);
                const chip = el('button', {
                  class: `tag${has ? ' has' : ''}${on ? ' on' : ''}`,
                  text: v,
                  'aria-pressed': String(on),
                  title: `${meaning}${on ? ' (filtering)' : has ? ` (${entry.title} is tagged; click to filter)` : ' (click to filter)'}`,
                });
                chip.addEventListener('click', () => {
                  const f = st.filters[facet] || [];
                  st.filters = { ...st.filters, [facet]: on ? f.filter((x) => x !== v) : [...f, v] };
                  save({ filters: st.filters });
                  applyFilters('smooth');
                });
                return chip;
              })
            ),
          ])
        )
      );
      const n = Object.values(st.filters).reduce((a, v) => a + v.length, 0);
      filterNote.textContent = n ? `${n} filter${n > 1 ? 's' : ''}: OR within a facet, AND across` : 'No filters. Outlined chips are this visualizer’s tags.';
      clearBtn.hidden = n === 0;
      // Catalog and registry out of step: say so here rather than drawing nothing silently.
      const registered = new Set(viz.ids());
      const unregistered = st.catalog.filter((e) => !registered.has(e.id)).map((e) => e.id);
      const uncataloged = viz.ids().filter((id) => !st.catalog.some((e) => e.id === id));
      const problems = [...(unregistered.length ? [`no renderer registered for ${unregistered.join(', ')}`] : []), ...(uncataloged.length ? [`registered but not in the catalog: ${uncataloged.join(', ')}`] : [])];
      mismatchNote.hidden = problems.length === 0;
      mismatchNote.textContent = problems.length ? `Catalog mismatch: ${problems.join('; ')}.` : '';
    }

    // ---------- wiring ----------
    source.onSessions((list) => {
      st.list = list;
      renderPicker();
    });
    source.onExplorer((state) => {
      if (state) {
        const catalogChanged = state.catalog.map((e) => e.id).join() !== st.catalog.map((e) => e.id).join();
        st.taxonomy = state.taxonomy;
        st.catalog = state.catalog;
        st.sessions = state.sessions;
        st.notLoaded = state.notLoaded;
        if (catalogChanged) buildSlides();
      } else {
        st.sessions = [];
        st.notLoaded = [];
      }
      renderLoaded();
      mountAround();
      renderPuck();
    });
    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitStrip();
        for (const s of slides) for (const p of s.parts) p.instance.resize();
        const cur = current();
        if (cur && !cur.slide.hidden) strip.scrollTo({ left: cur.slide.offsetLeft, behavior: 'auto' });
      }, 150);
    };
    window.addEventListener('resize', onResize);
    // What's above the strip changes height too (the picker's list, the notes, the web demo's header).
    const pageObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(fitStrip) : null;
    if (pageObserver) pageObserver.observe(document.body);

    renderPicker();
    renderLoaded();
    renderPuck();
    renderDots();

    const tab = {
      /** The tab was just made visible: ask for what it hasn't got, and lay out at its real width. */
      shown() {
        tabVisible = true;
        source.listSessions();
        if (!st.picked) {
          const open = source.openSessionId();
          st.picked = open ? [open] : [];
          save({ picked: st.picked });
          renderPicker();
        }
        if (st.picked.length && !st.requested && !st.sessions.length) {
          st.requested = true;
          source.loadSessions(st.picked);
        }
        fitStrip();
        for (const s of slides) for (const p of s.parts) p.instance.resize();
        const cur = current();
        if (cur && !cur.slide.hidden) strip.scrollTo({ left: cur.slide.offsetLeft, behavior: 'auto' });
        activate();
      },
      /** The tab was hidden: stop every slide. */
      hidden() {
        tabVisible = false;
        activate();
      },
      destroy() {
        stopReplayPrefs();
        window.removeEventListener('resize', onResize);
        if (pageObserver) pageObserver.disconnect();
        if (drag) stopDragging();
        if (io) io.disconnect();
        for (const s of slides) destroyParts(s);
        root.replaceChildren();
        if (mounted === tab) mounted = null;
      },
    };
    mounted = tab;
    return tab;
  }

  window.factoryClockExplore = {
    mount,
    shown() {
      if (mounted) mounted.shown();
    },
    hidden() {
      if (mounted) mounted.hidden();
    },
  };
})();
