import * as assert from 'assert';
import * as path from 'path';
import { PlanItemRecord } from '@snagboat/schema';
import type { PlanItemView, PlansView } from '../../core/plansView';

// The advisor UI's Plans page (media/ui/plans.js): its tree, filters and words, and its renderers run
// over a stand-in for the page's el(), on a made-up GET /plans answer.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require(path.join(__dirname, '..', '..', '..', 'media', 'ui', 'plans.js'));

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Array<Node | string>;
}
/** The page's el(): attrs as app.js sets them (text, class, the rest as attributes; null/undefined/false left out). */
function el(tag: string, attrs: Record<string, unknown> = {}, children: Array<Node | string | null | undefined | false> = []): Node {
  const node: Node = { tag, attrs: {}, children: [] };
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.children.push(String(v));
    else node.attrs[k] = String(v);
  }
  for (const c of children) if (c) node.children.push(c);
  return node;
}
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
function all(n: Node | string, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (typeof n === 'string') return out;
  if (pred(n)) out.push(n);
  for (const c of n.children) all(c, pred, out);
  return out;
}
const hasClass = (c: string) => (n: Node) => (n.attrs.class ?? '').split(' ').includes(c);

const at = (h: number) => new Date(Date.UTC(2026, 10, 20, h)).toISOString();
const item = (id: string, extra: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  record: 'item', version: 1, id, kind: 'task', title: `Title of ${id}`, status: 'open', labels: [], created: at(1), updated: at(2), source: 'beads', confidence: 'observed', ...extra,
});
const bare = (i: PlanItemRecord): PlanItemView => ({ item: i, transitions: [], sessions: [], commits: [], branches: [] });
const SHA = 'b'.repeat(40);

function koh(): PlanItemView {
  return {
    item: item('snagboat-koh', { title: 'Dev container: node_modules', status: 'done', priority: 2, parent: 'snagboat-93b', started: at(3), closed: at(6), closeReason: 'Merged (#157)', updated: at(6) }),
    transitions: [
      { transition: { record: 'transition', version: 1, id: 't1', item: 'snagboat-koh', at: at(1), type: 'created', actor: 'Dave', confidence: 'observed' }, sessions: [] },
      {
        transition: { record: 'transition', version: 1, id: 't2', item: 'snagboat-koh', at: at(3), type: 'status_changed', from: 'open', to: 'in_progress', actor: 'Dave', confidence: 'observed' },
        sessions: [{ sessionId: 'session-one-long-id', link: { id: 'l1', kind: 'made-in', confidence: 'observed', evidence: [{ rule: 'bd-call', refs: ['e3'] }] } }],
      },
    ],
    sessions: [
      {
        sessionId: 'session-one-long-id',
        workspace: '/w/other-worktree',
        session: { sessionId: 'session-one-long-id', agent: 'claude-code', firstTs: at(3), lastTs: at(5), models: ['m'], prompts: 4, modelCalls: 9, toolCalls: 31, tokens: 1_234_567, subagents: 0, days: ['2026-11-20'], name: 'Volume work', subagentIds: [], where: '.', branches: ['koh'], commits: [], planItems: [] },
        links: [
          { id: 'l2', kind: 'touched', how: 'claimed', confidence: 'observed', evidence: [{ rule: 'bd-call', refs: ['t2', 'e3'] }] },
          { id: 'l3', kind: 'touched', how: 'mentioned', confidence: 'inferred', evidence: [{ rule: 'text-mention', refs: ['e1'] }] },
          { id: 'l1', kind: 'made-in', confidence: 'observed', evidence: [{ rule: 'bd-call', refs: ['e3'] }] },
        ],
      },
      { sessionId: 's-gone', workspace: '/w', links: [{ id: 'l4', kind: 'touched', how: 'mentioned', confidence: 'inferred', evidence: [{ rule: 'text-mention', refs: ['e9'] }] }] },
    ],
    commits: [
      {
        sha: SHA,
        commit: { subject: 'Volume (snagboat-koh) (#157)', committedAt: at(5), author: 'Dave <d@example.com>', kind: 'squash', onBranches: ['main', 'a', 'b', 'c', 'd', 'e'], pr: 157 },
        links: [
          { id: 'l5', kind: 'references', confidence: 'observed', evidence: [{ rule: 'commit-message', refs: [SHA] }] },
          { id: 'l6', kind: 'made', confidence: 'inferred', evidence: [{ rule: 'git-outcomes', refs: [SHA, 'e4'] }], sessionId: 'session-one-long-id' },
        ],
      },
    ],
    branches: [
      { id: `koh@${at(2)}`, name: 'koh', branch: { head: SHA, firstSeenAt: at(2), merged: { into: 'main', at: at(5), via: 'squash', commit: SHA, pr: 157 }, deletedAt: at(6) }, links: [{ id: 'l7', kind: 'worked-on', confidence: 'inferred', evidence: [{ rule: 'branch-at-start', refs: ['c1'] }], sessionId: 'session-one-long-id' }] },
    ],
  };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('ids sort naturally: .2 before .10', () => {
    const ids = ['x-1.10', 'x-1.2', 'x-1', 'x-1.1', 'x-a'];
    assert.deepStrictEqual([...ids].sort(P.naturalCompare), ['x-1', 'x-1.1', 'x-1.2', 'x-1.10', 'x-a']);
  });

  test('the tree: children under their parent in id order, roots in the core\'s order, an unknown parent or a cycle leaves a root', () => {
    const items = [
      bare(item('e-2', { kind: 'epic', updated: at(9) })),
      bare(item('e-1.10', { parent: 'e-1' })),
      bare(item('e-1', { kind: 'epic' })),
      bare(item('e-1.2', { parent: 'e-1' })),
      bare(item('e-1.2.1', { parent: 'e-1.2' })),
      bare(item('orphan', { parent: 'gone' })),
      bare(item('c-a', { parent: 'c-b' })),
      bare(item('c-b', { parent: 'c-a' })),
    ];
    const tree = P.planTree(items);
    const shape = (nodes: Array<{ view: PlanItemView; children: unknown[] }>): unknown => nodes.map((n) => (n.children.length ? { [n.view.item.id]: shape(n.children as never) } : n.view.item.id));
    assert.deepStrictEqual(shape(tree), ['e-2', { 'e-1': [{ 'e-1.2': ['e-1.2.1'] }, 'e-1.10'] }, 'orphan', { 'c-b': ['c-a'] }]);
    assert.strictEqual(P.countNodes(tree), items.length, 'every item once');
  });

  test('filters: status and a query on id or title; a matching child keeps its parents, marked as context', () => {
    const items = [bare(item('e-1', { kind: 'epic', status: 'open' })), bare(item('e-1.1', { parent: 'e-1', status: 'done', title: 'Wire the volume' })), bare(item('e-1.2', { parent: 'e-1', status: 'open' }))];
    const tree = P.planTree(items);
    const done = P.filterTree(tree, { statuses: new Set(['done']), query: '' });
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0].context, true, 'the open epic is shown for its done child');
    assert.deepStrictEqual(done[0].children.map((c: { view: PlanItemView; context: boolean }) => [c.view.item.id, c.context]), [['e-1.1', false]]);
    assert.deepStrictEqual(P.filterTree(tree, { statuses: new Set(P.STATUSES), query: 'VOLUME' })[0].children.map((c: { view: PlanItemView }) => c.view.item.id), ['e-1.1']);
    assert.deepStrictEqual(P.filterTree(tree, { statuses: new Set(P.STATUSES), query: 'e-1.2' })[0].children.map((c: { view: PlanItemView }) => c.view.item.id), ['e-1.2']);
    assert.strictEqual(P.filterTree(tree, { statuses: new Set(), query: '' }).length, 0);
    assert.deepStrictEqual(P.statusCounts(items), { open: 2, in_progress: 0, blocked: 0, done: 1, deferred: 0, dropped: 0 });
  });

  test('words: transitions, authors, refs and evidence', () => {
    assert.strictEqual(P.transitionText({ type: 'status_changed', from: 'open', to: 'in_progress' }), 'status open → in progress');
    assert.strictEqual(P.transitionText({ type: 'updated', fields: ['notes', 'design'] }), 'updated notes, design');
    assert.strictEqual(P.transitionText({ type: 'dependency_added', to: 'x-2' }), 'depends on x-2');
    assert.strictEqual(P.authorName('Dave C <d@example.com>'), 'Dave C');
    assert.strictEqual(P.authorName('bot'), 'bot');
    assert.strictEqual(P.shortRef(SHA), 'bbbbbbb');
    const title = P.evidenceTitle({ kind: 'touched', how: 'claimed', confidence: 'observed', evidence: [{ rule: 'bd-call', refs: ['t2', SHA] }] });
    assert.match(title, /^observed: touched \(claimed\)\nbd-call: A tool call in the session ran bd on the item.*\[t2, bbbbbbb\]$/);
    for (const rule of ['tool-call-commit', 'git-commit-call', 'git-outcomes', 'checkout', 'tool-call-branch', 'branch-at-start', 'bd-call', 'text-mention', 'commit-references', 'active-session-touched', 'active-session-bd', 'active-session', 'commit-message', 'branch-name', 'pull-request']) assert.ok(P.RULES[rule], `${rule} is explained`);
  });

  test('an item: its summary line, and opened, its lifecycle, sessions, commits and branches, each link observed or inferred with its evidence', () => {
    const r = P.renderers(el, { isOpen: (id: string) => id === 'snagboat-koh' });
    const tree: Node = r.tree(P.planTree([koh()]));
    const details = all(tree, (n) => n.tag === 'details' && hasClass('pi')(n));
    assert.strictEqual(details.length, 1);
    assert.strictEqual(details[0].attrs['data-item'], 'snagboat-koh');
    assert.strictEqual(details[0].attrs.class, 'pi s-done', "not the page's .done class, which colors everything in it");
    assert.strictEqual(details[0].attrs.open, 'open', 'kept open across redraws');
    const summary = text(all(tree, hasClass('plan-sum'))[0]);
    for (const s of ['snagboat-koh', 'Dev container: node_modules', 'task', 'done', 'P2', 'beads · observed', '2 sessions', '1 commit', '1 branch']) assert.ok(summary.includes(s), `summary has ${s}: ${summary}`);

    const life = text(all(tree, hasClass('life'))[0]);
    assert.ok(life.indexOf('created') < life.indexOf('status open → in progress'), 'oldest first');
    assert.match(life, /by Dave/);
    const madeIn = all(all(tree, hasClass('life'))[0], (n) => n.tag === 'a')[0];
    assert.strictEqual(madeIn.attrs.href, '#session=session-one-long-id');
    assert.strictEqual(madeIn.attrs['data-workspace'], '/w/other-worktree', 'the session view switches to its workspace');

    const sections = all(tree, hasClass('pd'));
    const [sessions, commits, branches] = sections.slice(1).map(text);
    assert.match(sessions, /Volume work/);
    assert.match(sessions, /Claude Code · .* · 2 h · 4 prompts · 31 tool calls · 1\.2M tokens/);
    assert.match(sessions, /made 1 of its transitions/);
    assert.match(sessions, /past retention/, 'a session with no record left says why');
    assert.match(commits, /bbbbbbb.*Volume \(snagboat-koh\) \(#157\)/);
    assert.match(commits, /Dave · .* · squash · PR #157 · on main, a, b, c \+2/);
    assert.match(branches, /koh.*head bbbbbbb · merged into main by squash \(PR #157\) .* · deleted/);

    const badges = all(tree, hasClass('lk'));
    const kinds = badges.map((b) => `${b.attrs.class}:${text(all(b, (n) => n.tag === 'summary')[0])}`);
    assert.ok(kinds.includes('lk observed:observed touched · claimed'), kinds.join(' | '));
    assert.ok(kinds.includes('lk inferred:inferred touched · mentioned'));
    assert.ok(kinds.includes('lk observed:observed references'));
    assert.ok(kinds.includes('lk inferred:inferred made'));
    assert.ok(kinds.includes('lk inferred:inferred worked on'));
    const ev = badges.find((b) => b.attrs.class === 'lk inferred' && text(b).includes('branch-at-start'))!;
    assert.match(ev.attrs.title, /checked out in the working tree when the session started/, 'evidence on hover');
    assert.match(text(ev), /branch-at-start The branch was checked out .* c1/, 'and when opened');
  });

  test('an item with nothing linked, and a markdown item, say so', () => {
    const r = P.renderers(el);
    const md = bare(item('md-1', { source: 'markdown', confidence: 'inferred', kind: 'step', from: { file: 'docs/roadmap.md', heading: 'Export' } }));
    const tree: Node = r.tree(P.planTree([md]));
    const t = text(tree);
    assert.match(t, /markdown · inferred/);
    assert.match(t, /docs\/roadmap\.md › Export/);
    for (const s of ['No transitions yet', 'No sessions linked.', 'No commits linked.', 'No branches linked.']) assert.ok(t.includes(s), s);
    assert.strictEqual(all(tree, hasClass('pi'))[0].attrs.open, undefined, 'closed by default');
  });

  test('values go in as text: markup in a title stays text', () => {
    const r = P.renderers(el);
    const view: PlansView = { workspace: '/w', workspaces: ['/w'], items: [bare(item('x-1', { title: '<img src=x onerror=alert(1)>' }))] };
    const tree: Node = r.tree(P.planTree(view.items));
    assert.ok(all(tree, (n) => n.tag === 'img').length === 0);
    assert.match(text(tree), /<img src=x/);
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures += 1;
      console.log(`  FAIL ${name}`);
      console.log(err);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

main();
