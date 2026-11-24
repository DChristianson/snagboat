import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BranchRecord,
  CheckoutRecord,
  CommitRecord,
  currentLinks,
  LINK_WITHDRAWN,
  LinkRecord,
  NormalizedEvent,
  PlanItemRecord,
  storeRecordKey,
  TransitionRecord,
} from '@snagboat/schema';
import { ComputedLink, computeLinks, issuePrefix, LinkerInput, linkId, linksToAppend, observeEvent, SessionFacts, withdrawnLink } from '../../core/links';
import { appendStoreRecords, readStoreRecordLines } from '../../core/storeRecordFiles';
import { LinkerJob } from '../../core/service/linkerJob';
import { StoreWriter } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';
import { sessionRecords } from '../../core/sessionRecords';

// The linker (docs/design/export.md, "How records are linked"): each rule on its own, observed
// and inferred, supersession, and that running again appends nothing.

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const WHERE = '/work/project';
const SHA = (c: string) => c.repeat(40).slice(0, 40);
const ME = 'Dave <dave@example.com>';

let n = 0;
const ev = (sessionId: string, at: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId,
  agent: 'claude-code',
  ts: iso(at),
  kind: 'tool_call',
  status: 'success',
  raw: { adapter: 'test', ref: `r${n}` },
  ...extra,
});
const prompt = (sessionId: string, at: number, text?: string) => ev(sessionId, at, { kind: 'user_prompt', ...(text ? { promptText: text } : {}) });
const edit = (sessionId: string, at: number, file: string) => ev(sessionId, at, { toolName: 'Edit', toolCategory: 'file-edit', target: path.join(WHERE, file) });
const bash = (sessionId: string, at: number, command: string | undefined, refs?: NormalizedEvent['refs']) =>
  ev(sessionId, at, { toolName: 'Bash', toolCategory: 'shell', ...(command ? { toolInput: { command } } : {}), ...(refs ? { refs } : {}) });

function commit(sha: string, at: number, extra: Partial<CommitRecord> = {}): CommitRecord {
  return { record: 'commit', version: 1, sha, parents: [], kind: 'commit', authoredAt: iso(at), committedAt: iso(at), author: ME, committer: ME, coAuthors: [], subject: 'work', files: [], onBranches: ['main'], ...extra };
}
const files = (...paths: string[]) => paths.map((p) => ({ path: p, status: 'M' as const, added: 1, deleted: 0 }));
function branch(name: string, extra: Partial<BranchRecord> = {}): BranchRecord {
  const firstSeenAt = extra.firstSeenAt ?? iso(T0 - 60 * MIN);
  return { record: 'branch', version: 1, id: `${name}@${firstSeenAt}`, name, firstSeenAt, head: SHA('f'), ...extra };
}
const checkout = (id: string, at: number, from: string, to: string, where = WHERE): CheckoutRecord => ({ record: 'checkout', version: 1, id, at: iso(at), from, to, commit: SHA('c'), where });
const item = (id: string, extra: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  record: 'item', version: 1, id, kind: 'task', title: id, status: 'open', labels: [], created: iso(T0 - 600 * MIN), updated: iso(T0), source: 'beads', confidence: 'observed', ...extra,
});
const transition = (id: string, itemId: string, at: number, type: TransitionRecord['type'], actor = 'Dave', extra: Partial<TransitionRecord> = {}): TransitionRecord => ({
  record: 'transition', version: 1, id, item: itemId, at: iso(at), type, actor, confidence: 'observed', ...extra,
});

function facts(events: NormalizedEvent[]): Map<string, SessionFacts> {
  const map = new Map<string, SessionFacts>();
  for (const e of events) observeEvent(map, e);
  return map;
}
function link(input: Partial<LinkerInput> & { events?: NormalizedEvent[] }): ComputedLink[] {
  return computeLinks({
    workspaces: [{ workspace: WHERE, where: WHERE, sessions: facts(input.events ?? []).values() }],
    commits: input.commits ?? [],
    branches: input.branches ?? [],
    checkouts: input.checkouts ?? [],
    items: input.items ?? [],
    transitions: input.transitions ?? [],
    prefix: input.prefix ?? 'snagboat',
  });
}
const pick = (links: ComputedLink[], kind: LinkRecord['kind']) => links.map((l) => l.link).filter((l) => l.kind === kind);
const brief = (l: LinkRecord) => `${l.from.id}>${l.to.id}${l.how ? `:${l.how}` : ''}:${l.confidence}:${l.evidence.map((e) => e.rule).join('+')}`;

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // ---- session made commit

  test('made, observed: a tool call whose refs name the commit (a short SHA)', () => {
    const c = commit(SHA('a'), T0 + 5 * MIN);
    const call = bash('s1', T0 + 5 * MIN, 'git commit -m x', { commit: SHA('a').slice(0, 7) });
    const made = pick(link({ events: [prompt('s1', T0), call], commits: [c] }), 'made');
    assert.deepStrictEqual(made.map(brief), [`s1>${SHA('a')}:observed:tool-call-commit`]);
    assert.deepStrictEqual(made[0].evidence[0].refs.sort(), [call.eventId, SHA('a')].sort());
    assert.strictEqual(made[0].id, linkId({ type: 'session', id: 's1' }, { type: 'commit', id: SHA('a') }, 'made'));
  });

  test('made, observed: a git commit call and a commit landing within 60 seconds; not 90 seconds later', () => {
    const call = bash('s1', T0 + 5 * MIN, 'git add -A && git commit -m "work"');
    const soon = pick(link({ events: [prompt('s1', T0), call], commits: [commit(SHA('a'), T0 + 5 * MIN + 20_000)] }), 'made');
    assert.deepStrictEqual(soon.map(brief), [`s1>${SHA('a')}:observed:git-commit-call`]);
    const late = pick(link({ events: [prompt('s1', T0), call], commits: [commit(SHA('a'), T0 + 5 * MIN + 90_000)] }), 'made');
    assert.deepStrictEqual(late, []);
    // Same committer as its other commits: another person's commit in the window isn't it.
    const mine = commit(SHA('b'), T0 + 2 * MIN);
    const theirs = commit(SHA('c'), T0 + 5 * MIN + 5_000, { committer: 'Other <o@example.com>' });
    const both = pick(link({ events: [prompt('s1', T0), bash('s1', T0 + 2 * MIN, 'git commit', { commit: SHA('b').slice(0, 8) }), call], commits: [mine, theirs] }), 'made');
    assert.deepStrictEqual(both.map((l) => l.to.id), [SHA('b')]);
  });

  test('made, inferred: the git outcomes rule (a commit after the session started, within 30 minutes of its end, touching a file it edited)', () => {
    const events = [prompt('s1', T0), edit('s1', T0 + MIN, 'src/a.ts')];
    const inside = pick(link({ events, commits: [commit(SHA('a'), T0 + 20 * MIN, { files: files('src/a.ts', 'b.ts') })] }), 'made');
    assert.deepStrictEqual(inside.map(brief), [`s1>${SHA('a')}:inferred:git-outcomes`]);
    assert.ok(inside[0].evidence[0].refs.includes(events[1].eventId), 'the edit is evidence');
    assert.deepStrictEqual(pick(link({ events, commits: [commit(SHA('a'), T0 + 40 * MIN, { files: files('src/a.ts') })] }), 'made'), [], 'too late');
    assert.deepStrictEqual(pick(link({ events, commits: [commit(SHA('a'), T0 + 5 * MIN, { files: files('other.ts') })] }), 'made'), [], 'not its file');
    assert.deepStrictEqual(pick(link({ events, commits: [commit(SHA('a'), T0 + 5 * MIN, { files: files('src/a.ts'), kind: 'merge', parents: ['x', 'y'] })] }), 'made'), [], 'a merge');
  });

  test('made: an observed link takes the commit from an inferred one in another session', () => {
    const events = [prompt('s1', T0), edit('s1', T0 + MIN, 'src/a.ts'), prompt('s2', T0 + 2 * MIN), bash('s2', T0 + 10 * MIN, 'git commit -am x', { commit: SHA('a').slice(0, 7) })];
    const made = pick(link({ events, commits: [commit(SHA('a'), T0 + 10 * MIN, { files: files('src/a.ts') })] }), 'made');
    assert.deepStrictEqual(made.map(brief), [`s2>${SHA('a')}:observed:tool-call-commit`]);
  });

  // ---- session worked-on branch

  test('worked-on, observed: a checkout in its working tree while it was active, or a call\'s refs.branch; another tree\'s checkout doesn\'t count', () => {
    const b = branch('feature');
    const events = [prompt('s1', T0), bash('s1', T0 + 30 * MIN, 'ls')];
    const viaCheckout = pick(link({ events, branches: [b], checkouts: [checkout('checkout-1', T0 + 10 * MIN, 'main', 'feature')] }), 'worked-on');
    assert.deepStrictEqual(viaCheckout.map(brief), [`s1>${b.id}:observed:checkout`]);
    assert.deepStrictEqual(pick(link({ events, branches: [b], checkouts: [checkout('checkout-1', T0 + 10 * MIN, 'main', 'feature', '/elsewhere')] }), 'worked-on'), []);
    const viaRefs = pick(link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, 'git switch -c feature', { branch: 'feature' })], branches: [b] }), 'worked-on');
    assert.deepStrictEqual(viaRefs.map(brief), [`s1>${b.id}:observed:tool-call-branch`]);
  });

  test('worked-on, inferred: the branch checked out in its working tree when it started', () => {
    const main = branch('main');
    const feature = branch('feature');
    const out = pick(
      link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, 'ls')], branches: [main, feature], checkouts: [checkout('checkout-1', T0 - 50 * MIN, 'main', 'feature'), checkout('checkout-2', T0 - 30 * MIN, 'feature', 'main')] }),
      'worked-on'
    );
    assert.deepStrictEqual(out.map(brief), [`s1>${main.id}:inferred:branch-at-start`]);
    assert.deepStrictEqual(out[0].evidence[0].refs, ['checkout-2']);
  });

  // ---- session touched plan item, transition made-in session

  test('touched and made-in, observed: bd update --claim and the claimed transition it made', () => {
    const call = bash('s1', T0 + MIN, 'bd update snagboat-koh --claim', { planItems: ['snagboat-koh'] });
    const t = transition('bd-1', 'snagboat-koh', T0 + MIN + 800, 'claimed', 'Dave', { to: 'in_progress' });
    const out = link({ events: [prompt('s1', T0), call], items: [item('snagboat-koh')], transitions: [t] });
    assert.deepStrictEqual(pick(out, 'touched').map(brief), ['s1>snagboat-koh:claimed:observed:bd-call']);
    assert.deepStrictEqual(pick(out, 'touched')[0].evidence[0].refs.sort(), [call.eventId, 'bd-1'].sort());
    assert.deepStrictEqual(pick(out, 'made-in').map(brief), ['bd-1>s1:observed:bd-call']);
    // Without its command line (captureContent off), how comes from the transition.
    const bare = link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, undefined, { planItems: ['snagboat-koh'] })], items: [item('snagboat-koh')], transitions: [t] });
    assert.deepStrictEqual(pick(bare, 'touched').map(brief), ['s1>snagboat-koh:claimed:observed:bd-call']);
    // A close made a closed transition; a create, created.
    const closed = link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, 'bd close snagboat-koh --reason done', { planItems: ['snagboat-koh'] })], items: [item('snagboat-koh')], transitions: [transition('bd-2', 'snagboat-koh', T0 + MIN + 500, 'closed')] });
    assert.deepStrictEqual(pick(closed, 'touched').map(brief), ['s1>snagboat-koh:closed:observed:bd-call']);
    const created = link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, 'bd create --title "x" --type task', { planItems: ['snagboat-new'] })], items: [item('snagboat-new')], transitions: [transition('bd-3', 'snagboat-new', T0 + MIN + 500, 'created')] });
    assert.deepStrictEqual(pick(created, 'touched').map(brief), ['s1>snagboat-new:created:observed:bd-call']);
  });

  test('touched: a bd show is observed as mentioned; a claim whose transition isn\'t recorded yet is inferred, the same link', () => {
    const shown = link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, 'bd show snagboat-koh', { planItems: ['snagboat-koh'] })], items: [item('snagboat-koh')] });
    assert.deepStrictEqual(pick(shown, 'touched').map(brief), ['s1>snagboat-koh:mentioned:observed:bd-call']);
    const claim = bash('s1', T0 + MIN, 'bd update snagboat-koh --claim', { planItems: ['snagboat-koh'] });
    const waiting = pick(link({ events: [prompt('s1', T0), claim], items: [item('snagboat-koh')] }), 'touched');
    assert.deepStrictEqual(waiting.map(brief), ['s1>snagboat-koh:claimed:inferred:bd-call']);
    const later = pick(link({ events: [prompt('s1', T0), claim], items: [item('snagboat-koh')], transitions: [transition('bd-1', 'snagboat-koh', T0 + MIN + 900, 'claimed')] }), 'touched');
    assert.strictEqual(later[0].id, waiting[0].id, 'turned observed: same id');
    assert.strictEqual(later[0].confidence, 'observed');
    // A transition far from the call isn't its.
    const far = pick(link({ events: [prompt('s1', T0), claim], items: [item('snagboat-koh')], transitions: [transition('bd-1', 'snagboat-koh', T0 + 30 * MIN, 'claimed')] }), 'touched');
    assert.strictEqual(far[0].confidence, 'inferred');
  });

  test('touched, inferred: the id in a prompt or reply (by the project\'s prefix, and only items the store has), or a commit the session made references it', () => {
    const events = [prompt('s1', T0, 'please pick up snagboat-koh, not other-abc or snagboat-zzz'), ev('s1', T0 + MIN, { kind: 'turn_stop', textExcerpt: 'Working on snagboat-93b.10.5 now.' })];
    const out = pick(link({ events, items: [item('snagboat-koh'), item('snagboat-93b.10.5'), item('other-abc')] }), 'touched');
    assert.deepStrictEqual(out.map(brief).sort(), ['s1>snagboat-93b.10.5:mentioned:inferred:text-mention', 's1>snagboat-koh:mentioned:inferred:text-mention']);
    const viaCommit = pick(
      link({ events: [prompt('s1', T0), bash('s1', T0 + MIN, 'git commit', { commit: SHA('a').slice(0, 7) })], commits: [commit(SHA('a'), T0 + MIN, { subject: 'Fix it (snagboat-koh)' })], items: [item('snagboat-koh')] }),
      'touched'
    );
    assert.deepStrictEqual(viaCommit.map(brief), ['s1>snagboat-koh:mentioned:inferred:commit-references']);
  });

  test('made-in, inferred: a session spanning the transition with no activity near it gets nothing (the over-attachment: 17 transitions on one long session)', () => {
    // A long session touched snagboat-koh early, then sat idle for hours while transitions happened elsewhere.
    const events = [prompt('s1', T0, 'pick up snagboat-koh'), bash('s1', T0 + MIN, 'ls'), bash('s1', T0 + 300 * MIN, 'ls')];
    const transitions = Array.from({ length: 17 }, (_, i) => transition(`bd-${i + 20}`, 'snagboat-koh', T0 + (30 + i * 10) * MIN, 'updated'));
    const out = link({ events, items: [item('snagboat-koh')], transitions });
    assert.deepStrictEqual(pick(out, 'made-in'), [], 'none of the 17');
  });

  test('made-in, inferred: activity near it but no sign of the item, no link', () => {
    const t = transition('bd-9', 'snagboat-koh', T0 + 5 * MIN, 'updated', 'Dave', { fields: ['notes'] });
    const out = link({ events: [prompt('s1', T0, 'work on snagboat-zzz'), bash('s1', T0 + 4 * MIN, 'ls'), bash('s1', T0 + 10 * MIN, 'ls')], items: [item('snagboat-koh'), item('snagboat-zzz')], transitions: [t] });
    assert.deepStrictEqual(pick(out, 'made-in'), []);
  });

  test('made-in, inferred: activity near it and the session touched the item: active-session-touched, the touched link in its evidence', () => {
    const t = transition('bd-9', 'snagboat-koh', T0 + 5 * MIN, 'updated', 'Dave', { fields: ['notes'] });
    const out = link({ events: [prompt('s1', T0, 'please pick up snagboat-koh'), bash('s1', T0 + 3 * MIN, 'ls'), bash('s1', T0 + 60 * MIN, 'ls')], items: [item('snagboat-koh')], transitions: [t] });
    const madeIn = pick(out, 'made-in');
    assert.deepStrictEqual(madeIn.map(brief), ['bd-9>s1:inferred:active-session-touched']);
    const touched = pick(out, 'touched')[0];
    assert.deepStrictEqual(madeIn[0].evidence, [{ rule: 'active-session-touched', refs: ['bd-9', touched.id].sort() }]);
    // Activity just outside the window: nothing.
    const far = link({ events: [prompt('s1', T0, 'please pick up snagboat-koh'), bash('s1', T0 + 60 * MIN, 'ls')], items: [item('snagboat-koh')], transitions: [transition('bd-9', 'snagboat-koh', T0 + 20 * MIN, 'updated')] });
    assert.deepStrictEqual(pick(far, 'made-in'), []);
  });

  test('made-in, inferred: activity near it and a bd call then: active-session-bd, the call in its evidence', () => {
    // bd ran on another item (a bd call is a sign of bd work), and the transition landed after the observed window.
    const call = bash('s1', T0 + 2 * MIN, 'bd ready');
    const t = transition('bd-9', 'snagboat-koh', T0 + 5 * MIN, 'updated');
    const out = link({ events: [prompt('s1', T0), call, bash('s1', T0 + 90 * MIN, 'ls')], items: [item('snagboat-koh')], transitions: [t] });
    const madeIn = pick(out, 'made-in');
    assert.deepStrictEqual(madeIn.map(brief), ['bd-9>s1:inferred:active-session-bd']);
    assert.deepStrictEqual(madeIn[0].evidence[0].refs, [call.eventId, 'bd-9'].sort());
    // A bd update --claim whose transition came 4 minutes later: touched (inferred bd-call) and the bd call, both rules.
    const claim = bash('s1', T0 + MIN, 'bd update snagboat-koh --claim', { planItems: ['snagboat-koh'] });
    const both = pick(link({ events: [prompt('s1', T0), claim], items: [item('snagboat-koh')], transitions: [transition('bd-9', 'snagboat-koh', T0 + 5 * MIN, 'claimed')] }), 'made-in');
    assert.deepStrictEqual(both.map(brief), ['bd-9>s1:inferred:active-session-bd+active-session-touched']);
  });

  test('made-in, inferred: two sessions qualifying, no link; only one qualifying of two active, its link; by its person', () => {
    const t = transition('bd-9', 'snagboat-koh', T0 + 5 * MIN, 'updated', 'Dave', { fields: ['notes'] });
    const items = [item('snagboat-koh')];
    const two = link({ events: [prompt('s1', T0, 'snagboat-koh'), bash('s1', T0 + 4 * MIN, 'ls'), prompt('s2', T0 + MIN, 'snagboat-koh too'), bash('s2', T0 + 6 * MIN, 'ls')], items, transitions: [t] });
    assert.deepStrictEqual(pick(two, 'made-in'), []);
    const one = link({ events: [prompt('s1', T0, 'snagboat-koh'), bash('s1', T0 + 4 * MIN, 'ls'), prompt('s2', T0 + MIN, 'something else'), bash('s2', T0 + 6 * MIN, 'ls')], items, transitions: [t] });
    assert.deepStrictEqual(pick(one, 'made-in').map(brief), ['bd-9>s1:inferred:active-session-touched']);
    // Its person: the actor of what it observably did. Someone else's transition isn't its.
    const other = transition('bd-10', 'snagboat-koh', T0 + 6 * MIN, 'updated', 'Someone');
    const person = link({
      events: [prompt('s1', T0), bash('s1', T0 + MIN, 'bd update snagboat-koh --claim', { planItems: ['snagboat-koh'] }), bash('s1', T0 + 10 * MIN, 'ls')],
      items,
      transitions: [transition('bd-1', 'snagboat-koh', T0 + MIN + 500, 'claimed', 'Dave'), t, other],
    });
    assert.deepStrictEqual(pick(person, 'made-in').map(brief).sort(), ['bd-1>s1:observed:bd-call', 'bd-9>s1:inferred:active-session-bd+active-session-touched']);
  });

  test('made-in, withdrawn: a stored over-attached link the rules no longer give is appended again with supersededBy withdrawn; again, nothing', () => {
    const t = transition('bd-9', 'snagboat-koh', T0 + 60 * MIN, 'updated');
    const old: LinkRecord = {
      record: 'link', version: 1, id: linkId({ type: 'transition', id: 'bd-9' }, { type: 'session', id: 's1' }, 'made-in'),
      from: { type: 'transition', id: 'bd-9' }, to: { type: 'session', id: 's1' }, kind: 'made-in', confidence: 'inferred', evidence: [{ rule: 'active-session', refs: ['bd-9'] }], at: iso(T0 + 60 * MIN),
    };
    const stored = new Map<string, LinkRecord>([[storeRecordKey(old), old]]);
    const now = link({ events: [prompt('s1', T0), bash('s1', T0 + 300 * MIN, 'ls')], items: [item('snagboat-koh')], transitions: [t] });
    assert.deepStrictEqual(pick(now, 'made-in'), []);
    const appended = linksToAppend(stored, now, now, new Set(['s1']));
    assert.deepStrictEqual(appended.map((l) => [l.id, l.supersededBy]), [[old.id, LINK_WITHDRAWN]]);
    appended.forEach((r) => stored.set(storeRecordKey(r), r));
    assert.deepStrictEqual(currentLinks(stored.values()), []);
    assert.deepStrictEqual(linksToAppend(stored, now, now, new Set(['s1'])), [], 'idempotent');
    // The retired rule's links go whether or not the session is still read; the new rules' only when it is.
    assert.ok(withdrawnLink(old));
    const fresh: LinkRecord = { ...old, evidence: [{ rule: 'active-session-touched', refs: ['bd-9', 'link-x'] }] };
    assert.ok(!withdrawnLink(fresh), 'its session past retention: stays');
    assert.ok(withdrawnLink(fresh, new Set(['s1'])));
    assert.ok(!withdrawnLink({ ...fresh, confidence: 'observed', evidence: [{ rule: 'bd-call', refs: ['e1'] }] }, new Set(['s1'])), 'observed: never');
    // The rules give it again later (the session touches the item near it): current again, with the new evidence.
    const again = link({ events: [prompt('s1', T0), prompt('s1', T0 + 58 * MIN, 'snagboat-koh'), bash('s1', T0 + 300 * MIN, 'ls')], items: [item('snagboat-koh')], transitions: [t] });
    const back = linksToAppend(stored, again, again, new Set(['s1'])).find((l) => l.id === old.id)!;
    assert.strictEqual(back.supersededBy, undefined);
    assert.deepStrictEqual(back.evidence.map((e) => e.rule), ['active-session-touched']);
  });

  // ---- commit references plan item

  test('references, observed: the subject or body names the id by the project\'s prefix', () => {
    const out = pick(link({ commits: [commit(SHA('a'), T0, { subject: 'Linker (snagboat-93b.10.5)', body: 'Also other-abc and snagboat-koh.' })], items: [item('snagboat-93b.10.5'), item('snagboat-koh'), item('other-abc')] }), 'references');
    assert.deepStrictEqual(out.map(brief).sort(), [`${SHA('a')}>snagboat-93b.10.5:observed:commit-message`, `${SHA('a')}>snagboat-koh:observed:commit-message`]);
  });

  test('references, inferred: the branch\'s name, or its squash commit (the pull request), names the item', () => {
    const b = branch('snagboat-koh-volume', { createdAt: iso(T0 - 10 * MIN) });
    const own = commit(SHA('a'), T0, { onBranches: ['snagboat-koh-volume'], subject: 'wip' });
    const before = commit(SHA('b'), T0 - 20 * MIN, { onBranches: ['main', 'snagboat-koh-volume'] });
    const viaName = pick(link({ commits: [own, before], branches: [b], items: [item('snagboat-koh')] }), 'references');
    assert.deepStrictEqual(viaName.map(brief), [`${SHA('a')}>snagboat-koh:inferred:branch-name`], 'only its own commits');
    const squash = commit(SHA('s'), T0 + 60 * MIN, { kind: 'squash', subject: 'Dev container: node_modules volume (snagboat-xyz) (#157)', pr: 157 });
    const feature = branch('volume', { createdAt: iso(T0 - 10 * MIN), merged: { into: 'main', at: iso(T0 + 60 * MIN), via: 'squash', commit: SHA('s'), pr: 157 } });
    const viaPr = pick(link({ commits: [commit(SHA('a'), T0, { onBranches: ['volume'] }), squash], branches: [feature, branch('main')], items: [item('snagboat-xyz')] }), 'references');
    assert.deepStrictEqual(viaPr.map(brief).sort(), [`${SHA('a')}>snagboat-xyz:inferred:pull-request`, `${SHA('s')}>snagboat-xyz:observed:commit-message`]);
  });

  // ---- branch merged into branch

  test('merged: observed for a merge or squash commit, inferred when it was rebased or fast-forwarded', () => {
    const main = branch('main');
    const squashed = branch('a', { merged: { into: 'main', at: iso(T0), via: 'squash', commit: SHA('s'), pr: 3 } });
    const forwarded = branch('b', { merged: { into: 'main', at: iso(T0), via: 'fast-forward', commit: SHA('t') } });
    const out = pick(link({ branches: [main, squashed, forwarded] }), 'merged');
    assert.deepStrictEqual(out.map(brief).sort(), [`${squashed.id}>${main.id}:observed:squash-commit`, `${forwarded.id}>${main.id}:inferred:reachable`].sort());
  });

  // ---- supersession and idempotence

  test('superseded: an inferred link replaced by an observed one in its slot is appended again with supersededBy; again, nothing', () => {
    const c = commit(SHA('a'), T0 + 10 * MIN, { files: files('src/a.ts') });
    const first = [prompt('s1', T0), edit('s1', T0 + MIN, 'src/a.ts'), prompt('s2', T0 + 2 * MIN)];
    const before = link({ events: first, commits: [c] });
    const stored = new Map<string, LinkRecord>();
    const apply = (records: LinkRecord[]) => records.forEach((r) => stored.set(storeRecordKey(r), r));
    apply(linksToAppend(stored, before));
    assert.deepStrictEqual([...stored.values()].map(brief), [`s1>${SHA('a')}:inferred:git-outcomes`]);
    const after = link({ events: [...first, bash('s2', T0 + 10 * MIN, 'git commit', { commit: SHA('a').slice(0, 7) })], commits: [c] });
    const appended = linksToAppend(stored, after);
    const observed = appended.find((l) => l.from.id === 's2')!;
    assert.ok(observed && observed.confidence === 'observed');
    const old = appended.find((l) => l.from.id === 's1')!;
    assert.strictEqual(old.supersededBy, observed.id);
    apply(appended);
    assert.deepStrictEqual(currentLinks(stored.values()).map(brief), [`s2>${SHA('a')}:observed:tool-call-commit`]);
    assert.deepStrictEqual(linksToAppend(stored, after), [], 'idempotent');
    // A link without a replacement stays (its evidence may only have aged out).
    assert.deepStrictEqual(linksToAppend(stored, []), []);
  });

  test('the bead prefix: bd\'s issue-prefix in .beads/config.yaml, else the most common among beads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-prefix-'));
    const beads = [item('snagboat-a1'), item('snagboat-b2'), item('fc-c3'), item('md-0123456789ab', { source: 'markdown' })];
    assert.strictEqual(issuePrefix([dir], beads), 'snagboat');
    fs.mkdirSync(path.join(dir, '.beads'));
    fs.writeFileSync(path.join(dir, '.beads', 'config.yaml'), '# issue-prefix: "nope"\nissue-prefix: "fc"\n');
    assert.strictEqual(issuePrefix([dir], beads), 'fc');
  });

  test('the job: links a workspace from its store, appends nothing the second time, supersedes on new evidence, and builds session records', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-linker-')));
    const home = path.join(root, '.snagboat');
    const folder = path.join(root, 'project');
    fs.mkdirSync(folder);
    const now = Date.now();
    const t0 = now - 60 * MIN;
    const writer = new StoreWriter(home);
    const job = new LinkerJob(home, writer, { debounceMs: 0 });
    const w = (e: NormalizedEvent) => ({ ...e, workspace: folder });
    const sha = SHA('a');
    await writer.write([prompt('s1', t0, 'start snagboat-koh'), w(ev('s1', t0 + MIN, { toolName: 'Edit', toolCategory: 'file-edit', target: path.join(folder, 'a.ts') })), prompt('s2', t0 + 2 * MIN)].map(w));
    const dir = workspaceStoreDir(home, folder);
    await appendStoreRecords(path.join(dir, 'git.jsonl'), [commit(sha, t0 + 10 * MIN, { files: files('a.ts'), subject: 'Work (snagboat-koh)' })]);
    await appendStoreRecords(path.join(dir, 'plan.jsonl'), [item('snagboat-koh', { updated: iso(t0) })]);
    const first = await job.run();
    assert.ok(first.appended >= 3, `appended ${first.appended}`);
    const linksFile = path.join(dir, 'links.jsonl');
    const lines = () => readStoreRecordLines<LinkRecord>(linksFile);
    assert.deepStrictEqual(currentLinks(lines()).map(brief).sort(), [
      `${sha}>snagboat-koh:observed:commit-message`,
      `s1>${sha}:inferred:git-outcomes`,
      's1>snagboat-koh:mentioned:inferred:commit-references+text-mention',
    ]);
    assert.ok(lines().every((l) => l.at && l.at >= iso(t0)), 'each has its time');
    const count = lines().length;
    job.schedule(folder);
    assert.strictEqual((await job.run()).appended, 0, 'nothing new');
    assert.strictEqual(lines().length, count);
    // s2 commits it, observably: written events reach the job through the writer.
    await writer.write([w(bash('s2', t0 + 10 * MIN, 'git commit -m x', { commit: sha.slice(0, 7) }))]);
    const second = await job.run();
    assert.ok(second.appended >= 2);
    const current = currentLinks(lines()).map(brief).sort();
    assert.ok(current.includes(`s2>${sha}:observed:tool-call-commit`), current.join('\n'));
    assert.ok(!current.some((l) => l.startsWith(`s1>${sha}`)));
    assert.ok(lines().some((l) => l.from.id === 's1' && l.kind === 'made' && l.supersededBy));
    // A full pass, reading the events again: nothing new.
    assert.strictEqual((await job.run({ full: true })).appended, 0);
    job.dispose();

    // Session records from the store: commits, plan items, where.
    const events = [];
    for (const f of fs.readdirSync(path.join(dir, 'events'))) for (const line of fs.readFileSync(path.join(dir, 'events', f), 'utf8').split('\n')) if (line) events.push(JSON.parse(line));
    const records = sessionRecords({ events, links: lines(), git: readStoreRecordLines(path.join(dir, 'git.jsonl')), where: folder });
    const s2 = records.find((r) => r.sessionId === 's2')!;
    assert.deepStrictEqual(s2.commits, [{ sha, confidence: 'observed' }]);
    assert.deepStrictEqual(s2.planItems, [{ id: 'snagboat-koh', how: 'mentioned', confidence: 'inferred' }]);
    assert.strictEqual(s2.where, folder);
    assert.deepStrictEqual(records.find((r) => r.sessionId === 's1')!.commits, []);
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
