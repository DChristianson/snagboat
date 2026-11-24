// The advisor UI's Plans page (#view=plans): a workspace's plan items from GET /plans, as a tree
// (epics with their children), each opening to its lifecycle and the sessions, commits and branches
// linked to it, every link marked observed or inferred with its evidence. Read-only.
//
// Plain script, loaded before app.js. The pure helpers (tree, filter, text) and the renderers are
// here; app.js fetches, keeps the filters and which items are open, and handles errors. Renderers
// take the page's el(tag, attrs, children) so they run in node against a stand-in (the unit test).
// Every value from the core goes in as text, never as markup. Sets window.snagboatPlans, or
// module.exports under node.
(function (root) {
  'use strict';

  const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped'];
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };

  /** What each linker rule means (docs/design/export.md, "How records are linked"). */
  const RULES = {
    'tool-call-commit': 'A tool call in the session printed this commit (git commit output).',
    'git-commit-call': 'A tool call in the session ran git commit, and a commit by the same committer landed within 60 seconds.',
    'git-outcomes': 'The commit landed while the session was active (up to 30 minutes after) and touches a file the session edited.',
    checkout: 'A checkout during the session moved HEAD in its working tree to this branch.',
    'tool-call-branch': 'A tool call in the session ran git checkout, git switch or git worktree add for this branch.',
    'branch-at-start': 'The branch was checked out in the working tree when the session started.',
    'bd-call': 'A tool call in the session ran bd on the item, and its transition at that time matches.',
    'text-mention': "The item's id appears in a prompt or reply of the session.",
    'commit-references': 'A commit the session made references the item.',
    'active-session-touched': 'The session had activity within 5 minutes of it and touched the item (bd, its id in a prompt or reply, or a commit it made), by its person, and no other session did both.',
    'active-session-bd': 'The session had activity and ran bd within 5 minutes of it, by its person, and no other session qualified.',
    'active-session': 'Retired rule: it happened while the session was active, by its person, with no other session active then.',
    'commit-message': "The commit's subject or body names the item's id.",
    'branch-name': "The commit is on a branch whose name names the item.",
    'pull-request': 'The commit merged a pull request whose branch names the item.',
  };
  const KIND_TEXT = { made: 'made', 'worked-on': 'worked on', touched: 'touched', references: 'references', merged: 'merged', 'made-in': 'made in' };

  // --- Pure helpers ---------------------------------------------------------------------------------

  /** Compares ids so 93b.10.2 comes before 93b.10.10. */
  function naturalCompare(a, b) {
    const pa = String(a).split(/(\d+)/);
    const pb = String(b).split(/(\d+)/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? '';
      const y = pb[i] ?? '';
      if (x === y) continue;
      if (i % 2 === 1 && x !== '' && y !== '') return Number(x) - Number(y);
      return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * The items as a tree: each item under its parent when the parent is among them, else a root.
   * Roots keep the core's order (most recently updated first); children are in id order.
   */
  function planTree(items) {
    const byId = new Map(items.map((v) => [v.item.id, { view: v, children: [] }]));
    const roots = [];
    for (const v of items) {
      const node = byId.get(v.item.id);
      const parent = v.item.parent && v.item.parent !== v.item.id ? byId.get(v.item.parent) : undefined;
      // Guard against a parent cycle: only attach when the parent isn't below this node.
      if (parent && !below(node, parent)) parent.children.push(node);
      else roots.push(node);
    }
    const sort = (nodes) => {
      for (const n of nodes) {
        n.children.sort((a, b) => naturalCompare(a.view.item.id, b.view.item.id));
        sort(n.children);
      }
    };
    sort(roots);
    return roots;
  }
  function below(node, other) {
    for (const c of node.children) if (c === other || below(c, other)) return true;
    return false;
  }

  /** Whether an item passes the filters: its status is picked and the query is in its id or title. */
  function matches(item, filter) {
    if (filter.statuses && !filter.statuses.has(item.status)) return false;
    const q = (filter.query || '').trim().toLowerCase();
    if (!q) return true;
    return item.id.toLowerCase().includes(q) || (item.title || '').toLowerCase().includes(q);
  }

  /**
   * The tree with only what passes the filters, and the parents above it (marked context: shown,
   * dimmed, so a child keeps its place under its epic).
   */
  function filterTree(nodes, filter) {
    const out = [];
    for (const n of nodes) {
      const children = filterTree(n.children, filter);
      const hit = matches(n.view.item, filter);
      if (hit || children.length) out.push({ view: n.view, children, context: !hit });
    }
    return out;
  }

  /** How many items of each status. */
  function statusCounts(items) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const v of items) counts[v.item.status] = (counts[v.item.status] || 0) + 1;
    return counts;
  }

  /** How many items a tree shows (context parents included). */
  function countNodes(nodes) {
    return nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);
  }

  /** A link's evidence in words: one line per rule, with what it means and the record ids that show it. */
  function evidenceLines(link) {
    return (link.evidence || []).map((e) => ({ rule: e.rule, meaning: RULES[e.rule] || '', refs: e.refs || [] }));
  }
  function evidenceTitle(link) {
    const head = `${link.confidence}: ${KIND_TEXT[link.kind] || link.kind}${link.how ? ` (${link.how})` : ''}`;
    return [head, ...evidenceLines(link).map((l) => `${l.rule}: ${l.meaning}${l.refs.length ? ` [${l.refs.map(shortRef).join(', ')}]` : ''}`)].join('\n');
  }
  /** A ref as shown: a SHA's first 7, anything else up to 24 characters. */
  function shortRef(ref) {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref.slice(0, 7);
    return ref.length > 24 ? `${ref.slice(0, 23)}…` : ref;
  }

  /** How a session touched the item, from its links: the ways (claimed, closed…) and how many transitions it made. */
  function sessionTouches(session) {
    const touched = session.links.filter((l) => l.kind === 'touched');
    const madeIn = session.links.filter((l) => l.kind === 'made-in');
    return { touched, madeIn };
  }

  /** A transition in words: "status open → in progress", "updated notes", "dependency added X". */
  function transitionText(t) {
    const st = (s) => STATUS_TEXT[s] || s;
    switch (t.type) {
      case 'created':
        return 'created';
      case 'claimed':
        return 'claimed';
      case 'status_changed':
        return `status ${st(t.from || '?')} → ${st(t.to || '?')}`;
      case 'updated':
        return t.fields && t.fields.length ? `updated ${t.fields.join(', ')}` : 'updated';
      case 'closed':
        return 'closed';
      case 'reopened':
        return 'reopened';
      case 'dependency_added':
        return `depends on ${t.to || '?'}`;
      case 'dependency_removed':
        return `no longer depends on ${t.to || '?'}`;
      case 'commented':
        return 'commented';
      case 'label_added':
        return `label ${t.to || ''} added`.replace('  ', ' ');
      case 'label_removed':
        return `label ${t.to || ''} removed`.replace('  ', ' ');
      default:
        return t.type;
    }
  }

  /** A name from "Name <email>". */
  function authorName(author) {
    const m = /^(.*?)\s*<[^>]*>\s*$/.exec(author || '');
    return (m ? m[1] : author || '') || author || '';
  }

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  function day(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function span(fromTs, toTs) {
    const min = Math.round((Date.parse(toTs) - Date.parse(fromTs)) / 60_000);
    if (!(min >= 1)) return 'under a minute';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
    return `${Math.round(h / 24)} days`;
  }
  function compact(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    return Number(n || 0).toLocaleString('en-US');
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const AGENTS = { 'claude-code': 'Claude Code', copilot: 'Copilot', 'copilot-cli': 'Copilot CLI' };

  // --- Rendering -----------------------------------------------------------------------------------

  /**
   * The renderers, over the page's el(). opts: sessionHref(sessionId) for a session's link;
   * isOpen(id) for whether an item's details start open.
   */
  function renderers(el, opts = {}) {
    const sessionHref = opts.sessionHref || ((id) => `#session=${encodeURIComponent(id)}`);
    const isOpen = opts.isOpen || (() => false);

    /** A link's confidence as a badge (observed solid, inferred dashed) that opens to its evidence. */
    function linkBadge(link, label) {
      const text = label || `${KIND_TEXT[link.kind] || link.kind}${link.how ? ` · ${link.how}` : ''}`;
      return el('details', { class: `lk ${link.confidence}`, title: evidenceTitle(link) }, [
        el('summary', {}, [el('b', { text: link.confidence }), ` ${text}`]),
        el(
          'ul',
          { class: 'ev' },
          evidenceLines(link).map((l) =>
            el('li', {}, [el('code', { text: l.rule }), l.meaning ? ` ${l.meaning}` : '', l.refs.length ? el('span', { class: 'mono muted', text: ` ${l.refs.map(shortRef).join(' · ')}` }) : null])
          )
        ),
      ]);
    }
    function badges(links) {
      return el('span', { class: 'lks' }, links.map((l) => linkBadge(l)));
    }

    function statusPill(status) {
      return el('span', { class: `st st-${status}`, text: STATUS_TEXT[status] || status });
    }
    function confidencePill(item) {
      const from = item.source === 'markdown' && item.from ? `${item.from.file}${item.from.heading ? ` › ${item.from.heading}` : ''}` : '';
      return el('span', { class: `conf ${item.confidence}`, title: item.confidence === 'observed' ? 'From beads: recorded by bd' : `Inferred from markdown${from ? `: ${from}` : ''}` }, [item.source, ' · ', item.confidence]);
    }

    function lifecycle(v) {
      const workspaceOf = (id) => (v.sessions.find((s) => s.sessionId === id) || {}).workspace;
      if (!v.transitions.length) return el('p', { class: 'empty', text: v.item.source === 'markdown' ? 'No transitions yet: markdown items get them from the plan job\'s first run on.' : 'No transitions recorded.' });
      return el(
        'ol',
        { class: 'life' },
        v.transitions.map((t) =>
          el('li', {}, [
            el('span', { class: 'mono small muted nowrap', text: when(t.transition.at) }),
            el('span', {}, [el('b', { text: transitionText(t.transition) }), el('span', { class: 'muted', text: ` by ${t.transition.actor}` }), t.transition.confidence === 'inferred' ? el('span', { class: 'conf inferred small', text: 'inferred', title: 'Time and actor from the commit that changed the line' }) : null]),
            t.sessions.length
              ? el(
                  'span',
                  { class: 'made-in' },
                  t.sessions.map((s) => el('span', { class: 'mi' }, ['in ', el('a', { href: sessionHref(s.sessionId), 'data-session': s.sessionId, 'data-workspace': workspaceOf(s.sessionId), text: shortSession(s.sessionId) }), ' ', linkBadge(s.link, 'made in')]))
                )
              : null,
          ])
        )
      );
    }
    /** A UUID-like session id's first 8 characters; any other id as it is. */
    function shortSession(id) {
      return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id) ? id.slice(0, 8) : id;
    }

    function sessionsList(v) {
      if (!v.sessions.length) return el('p', { class: 'empty', text: 'No sessions linked.' });
      return el(
        'ul',
        { class: 'rows' },
        v.sessions.map((s) => {
          const r = s.session;
          const { touched, madeIn } = sessionTouches(s);
          const title = r && r.name ? r.name : `${r ? AGENTS[r.agent] || r.agent : 'Session'} ${shortSession(s.sessionId)}`;
          return el('li', { class: 'row' }, [
            el('div', { class: 'row-head' }, [el('a', { href: sessionHref(s.sessionId), 'data-session': s.sessionId, 'data-workspace': s.workspace, text: title }), el('span', { class: 'mono small muted', text: s.sessionId })]),
            r
              ? el('div', { class: 'small muted', text: [AGENTS[r.agent] || r.agent, `${when(r.firstTs)} · ${span(r.firstTs, r.lastTs)}`, plural(r.prompts, 'prompt'), plural(r.toolCalls, 'tool call'), `${compact(r.tokens)} tokens`].join(' · ') })
              : el('div', { class: 'small muted', text: 'Its events are past retention: only the links remain.' }),
            el('div', { class: 'lks' }, [...touched.map((l) => linkBadge(l)), madeIn.length ? el('span', { class: 'small muted', text: `made ${madeIn.length} of its transitions:` }) : null, ...madeIn.map((l) => linkBadge(l, 'made in'))]),
          ]);
        })
      );
    }

    function commitsList(v) {
      if (!v.commits.length) return el('p', { class: 'empty', text: 'No commits linked.' });
      return el(
        'ul',
        { class: 'rows' },
        v.commits.map((c) => {
          const k = c.commit;
          const branches = k && k.onBranches ? k.onBranches : [];
          const shown = branches.slice(0, 4);
          return el('li', { class: 'row' }, [
            el('div', { class: 'row-head' }, [el('code', { class: 'sha', text: c.sha.slice(0, 7), title: c.sha }), el('span', { class: 'subj', text: k ? k.subject : 'Not in git.jsonl (past retention, or another repository)' })]),
            k
              ? el('div', { class: 'small muted' }, [
                  [authorName(k.author), when(k.committedAt), k.kind, k.pr !== undefined ? `PR #${k.pr}` : null].filter(Boolean).join(' · '),
                  branches.length ? el('span', { class: 'mono', text: ` · on ${shown.join(', ')}${branches.length > shown.length ? ` +${branches.length - shown.length}` : ''}`, title: branches.join(', ') }) : null,
                ])
              : null,
            badges(c.links),
          ]);
        })
      );
    }

    function branchesList(v) {
      if (!v.branches.length) return el('p', { class: 'empty', text: 'No branches linked.' });
      return el(
        'ul',
        { class: 'rows' },
        v.branches.map((b) => {
          const r = b.branch;
          const facts = [];
          if (r) {
            facts.push(`head ${r.head.slice(0, 7)}`);
            if (r.merged) facts.push(`merged into ${r.merged.into} by ${r.merged.via}${r.merged.pr !== undefined ? ` (PR #${r.merged.pr})` : ''} ${day(r.merged.at)}`);
            if (r.deletedAt) facts.push(`deleted ${day(r.deletedAt)}`);
            if (!r.merged && !r.deletedAt) facts.push(`first seen ${day(r.createdAt || r.firstSeenAt)}`);
          } else facts.push('Not in git.jsonl');
          return el('li', { class: 'row' }, [el('div', { class: 'row-head' }, [el('code', { text: b.name })]), el('div', { class: 'small muted', text: facts.join(' · ') }), badges(b.links)]);
        })
      );
    }

    function facts(item) {
      const rows = [
        ['Kind', item.kind],
        ['Status', STATUS_TEXT[item.status] || item.status],
        item.priority !== undefined ? ['Priority', `P${item.priority}`] : null,
        ['Created', when(item.created)],
        item.started ? ['Started', when(item.started)] : null,
        ['Updated', when(item.updated)],
        item.closed ? ['Closed', `${when(item.closed)}${item.closeReason ? ` · ${item.closeReason}` : ''}`] : null,
        ['Source', `${item.source}${item.from ? ` · ${item.from.file}${item.from.heading ? ` › ${item.from.heading}` : ''}` : ''} (${item.confidence})`],
        item.parent ? ['Parent', item.parent] : null,
        item.blockedBy && item.blockedBy.length ? ['Blocked by', item.blockedBy.join(', ')] : null,
        item.assignee ? ['Assignee', item.assignee] : null,
        item.labels && item.labels.length ? ['Labels', item.labels.join(', ')] : null,
      ].filter(Boolean);
      return el('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    }

    function itemDetail(v) {
      const section = (title, n, body) => el('section', { class: 'pd' }, [el('h3', {}, [title, n !== undefined ? el('span', { class: 'muted small', text: ` ${n}` }) : null]), body]);
      return el('div', { class: 'plan-detail' }, [
        facts(v.item),
        section('Lifecycle', v.transitions.length, lifecycle(v)),
        section('Sessions', v.sessions.length, sessionsList(v)),
        section('Commits', v.commits.length, commitsList(v)),
        section('Branches', v.branches.length, branchesList(v)),
      ]);
    }

    /** One item's summary line: id, title, kind, status, priority, source and confidence, what's linked, and when. */
    function itemSummary(v) {
      const i = v.item;
      const n = (count, one, many) => (count ? el('span', { class: 'cnt', title: `linked to this item`, text: plural(count, one, many) }) : null);
      return el('summary', { class: 'plan-sum' }, [
        el('code', { class: 'pid', text: i.id }),
        el('span', { class: 'ptitle', text: i.title }),
        el('span', { class: 'pmeta' }, [
          el('span', { class: 'kind', text: i.kind }),
          statusPill(i.status),
          i.priority !== undefined ? el('span', { class: 'prio', text: `P${i.priority}` }) : null,
          confidencePill(i),
          i.blockedBy && i.blockedBy.length ? el('span', { class: 'small muted', text: `blocked by ${i.blockedBy.join(', ')}` }) : null,
          n(v.sessions.length, 'session'),
          n(v.commits.length, 'commit'),
          n(v.branches.length, 'branch', 'branches'),
          el('span', { class: 'small muted nowrap', title: `updated ${when(i.updated)}`, text: day(i.updated) }),
        ]),
      ]);
    }

    function node(n) {
      const v = n.view;
      return el('li', { class: `pn${n.context ? ' context' : ''}` }, [
        el('details', { class: `pi s-${v.item.status}`, 'data-item': v.item.id, open: isOpen(v.item.id) ? 'open' : null }, [itemSummary(v), itemDetail(v)]),
        n.children.length ? el('ul', { class: 'ptree' }, n.children.map(node)) : null,
      ]);
    }

    /** The tree as nested lists. */
    function tree(nodes) {
      return el('ul', { class: 'ptree top' }, nodes.map(node));
    }

    return { tree, node, itemSummary, itemDetail, linkBadge, lifecycle, sessionsList, commitsList, branchesList };
  }

  const api = { STATUSES, STATUS_TEXT, RULES, naturalCompare, planTree, filterTree, matches, statusCounts, countNodes, evidenceLines, evidenceTitle, shortRef, transitionText, authorName, renderers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.snagboatPlans = api;
})(typeof window !== 'undefined' ? window : this);
