import * as assert from 'assert';
import * as crypto from 'crypto';
import type { BranchRecord, CheckoutRecord, CommitRecord, FindingRecord, LinkRecord, NormalizedEvent, PlanItemRecord, SessionRecord, TransitionRecord } from '@snagboat/schema';
import { commitsIn, ExportInput, exportRecords, peopleIn } from '../../core/exportFields';
import { Filter, makeContext, RULES } from '../../core/filter';
import { j, run } from './filterHarness';

// The adapter (core/exportFields.ts): which fields go through the filter, which are kept, which
// are dropped, and that an id comes out the same wherever it appears. Ported from the old
// sanitizer's record tests (exportSanitizer.unit.test.ts).

const HOME = j('/home/', 'qz', 'user');
const PROJECT = j(HOME, '/work/', 'acme-app');
const WT = j(PROJECT, '/.claude/worktrees/', 'agent-1');
const PERSON = j('Robin', ' Exampleton');
const EMAIL = j('robin', '@', 'example.org');
const SHA1 = crypto.createHash('sha1').update('commit one').digest('hex');
const SHA2 = crypto.createHash('sha1').update('commit two').digest('hex');
const PATH_ID = j('claude-code:', HOME, '/.claude/projects/s.jsonl:123');

const ev = (o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind'>): NormalizedEvent => ({
  sessionId: 'sess-1', agent: 'claude-code', ts: '2026-11-20T10:00:00.000Z', status: 'unknown', workspace: PROJECT, raw: { adapter: 'claude-code', ref: j(HOME, '/x.jsonl#L4') }, ...o,
});

function fixture(): ExportInput {
  const commit: CommitRecord = {
    record: 'commit', version: 1, sha: SHA2, parents: [SHA1], kind: 'commit', authoredAt: '2026-11-20T09:00:00-05:00', committedAt: '2026-11-20T09:01:00-05:00',
    author: `${PERSON} <${EMAIL}>`, committer: `${PERSON} <${EMAIL}>`, coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>'], subject: `Fix ${PROJECT}/src/app.ts (#12)`,
    body: `Reverts ${SHA1.slice(0, 7)}.`, files: [{ path: 'src/app.ts', status: 'M', added: 3, deleted: 1 }], pr: 12, reverts: SHA1, onBranches: ['qzuser/fix', 'main'],
  };
  const branch: BranchRecord = { record: 'branch', version: 1, id: `${PERSON}/fix@2026-11-20T08:00:00.000Z`, name: `${PERSON}/fix`, firstSeenAt: '2026-11-20T08:00:00.000Z', head: SHA2, from: SHA1 };
  const checkout: CheckoutRecord = { record: 'checkout', version: 1, id: 'checkout-0123456789abcdef', at: '2026-11-20T08:00:00.000Z', from: 'main', to: 'fix', commit: SHA1, where: WT };
  const item: PlanItemRecord = {
    record: 'item', version: 1, id: 'acme-1', kind: 'task', title: `Ask ${EMAIL}`, status: 'done', labels: [], created: '2026-11-19T10:00:00Z', updated: '2026-11-20T10:00:00Z',
    owner: EMAIL, createdBy: 'claude-code', text: { description: `See ${HOME}/spec.md` }, source: 'beads', confidence: 'observed',
  };
  const transition: TransitionRecord = { record: 'transition', version: 1, id: 'ev-1', item: 'acme-1', at: '2026-11-20T10:00:00Z', type: 'closed', actor: PERSON, confidence: 'observed' };
  const link = (o: Partial<LinkRecord>): LinkRecord => ({
    record: 'link', version: 1, id: 'link-00112233aabbccdd', from: { type: 'session', id: 'sess-1' }, to: { type: 'commit', id: SHA2 }, kind: 'made', confidence: 'observed',
    evidence: [{ rule: 'git-commit-call', refs: ['tool:toolu_1', SHA2, 'checkout-0123456789abcdef', PATH_ID, 'acme-1'] }], ...o,
  });
  const finding: FindingRecord = {
    record: 'finding', version: 1, id: 'finding-0011223344556677', heuristicId: 'retry-loop', heuristicVersion: '0.9.0', sessionId: 'sess-1', severity: 'warn',
    summary: `Retried ${PROJECT}/src/app.ts`, firstTs: '2026-11-20T10:00:00Z', lastTs: '2026-11-20T10:05:00Z', eventRefs: ['tool:toolu_1', PATH_ID], earlyWarning: false, response: 'useful',
  };
  const session: SessionRecord = {
    sessionId: 'sess-1', agent: 'claude-code', firstTs: '2026-11-20T10:00:00Z', lastTs: '2026-11-20T11:00:00Z', models: ['claude-opus-5-5'], prompts: 1, modelCalls: 1, toolCalls: 1,
    tokens: 100, subagents: 0, days: ['2026-11-20'], name: `Fix for ${PERSON}`, subagentIds: [], where: WT, branches: ['fix'], commits: [{ sha: SHA2, confidence: 'observed' }],
    planItems: [{ id: 'acme-1', how: 'closed', confidence: 'observed' }],
  };
  return {
    events: [
      ev({ eventId: 'u-1', kind: 'user_prompt', promptText: `mail ${EMAIL}` }),
      ev({ eventId: PATH_ID, kind: 'turn_stop', textExcerpt: 'done', ts: '2026-11-20T15:00:00+05:00' }),
      ev({ eventId: 'tool:toolu_1', kind: 'tool_call', toolCategory: 'version-control', target: `git show ${SHA2}`, toolInput: { command: `git show ${SHA2}`, path: `${PROJECT}/src/app.ts` }, refs: { commit: SHA2.slice(0, 7), planItems: ['acme-1'] } }),
      ev({ eventId: `outcome:milestone:${SHA1}`, kind: 'outcome', outcome: { type: 'milestone', commit: SHA1, refs: [PATH_ID] } }),
    ],
    sessions: [session],
    git: [commit, branch, checkout],
    plan: [item, transition],
    links: [link({}), link({ id: 'link-99887766aabbccdd', to: { type: 'branch', id: branch.id }, kind: 'worked-on' }), link({ id: 'link-dead', supersededBy: 'link-00112233aabbccdd' }), link({ id: 'link-gone', supersededBy: 'withdrawn' })],
    findings: [finding],
  };
}

/** The fixture through every rule, rewriting everything. */
function rewriteAll(input: ExportInput, text: 'redacted' | 'none' = 'redacted') {
  const actions = Object.fromEntries(RULES.map((r) => [r.id, 'rewrite' as const]));
  const ctx = makeContext({ projectRoot: PROJECT, worktrees: [WT], people: peopleIn(input), commits: commitsIn(input.git ?? []) });
  const f = new Filter(RULES, ctx, actions);
  exportRecords(input, (s) => (f.scan(s), s), { text });
  f.settle();
  return exportRecords(input, (s) => f.apply(s), { text });
}

run([
  ['workspace and raw are dropped; times are UTC', () => {
    const out = rewriteAll(fixture());
    for (const e of out.events) assert.ok(!('workspace' in e) && !('raw' in e));
    assert.strictEqual(out.events[1].ts, '2026-11-20T10:00:00.000Z');
    assert.strictEqual(out.commits[0].authoredAt, '2026-11-20T14:00:00.000Z');
  }],
  ['every field the filter should see goes through it: text, paths, people, SHAs', () => {
    const out = rewriteAll(fixture());
    const c = out.commits[0];
    assert.strictEqual(c.author, '[person-1]');
    assert.strictEqual(c.committer, '[person-1]');
    assert.deepStrictEqual(c.coAuthors, ['Claude Opus 5.5'], 'an agent keeps its name, without the email');
    assert.strictEqual(c.subject, 'Fix ./src/app.ts (#12)');
    assert.strictEqual(out.planItems[0].owner, '[person-1]', 'a bare email owner is the ident with that email');
    assert.strictEqual(out.planItems[0].createdBy, 'claude-code');
    assert.strictEqual(out.planItems[0].text!.description, 'See ~/spec.md');
    assert.strictEqual(out.transitions[0].actor, '[person-1]');
    assert.strictEqual(out.sessions[0].where, '[worktree-1]');
    assert.strictEqual(out.checkouts[0].where, '[worktree-1]');
    assert.strictEqual(out.sessions[0].name, 'Fix for [person-1]');
    assert.strictEqual(out.events[2].toolInput!.path, './src/app.ts');
  }],
  ['a SHA is the same placeholder everywhere: sha, parents, reverts, text, refs, links, branches, checkouts, sessions', () => {
    const out = rewriteAll(fixture());
    const c = out.commits[0];
    const [two, one] = [c.sha, c.parents[0]];
    assert.match(two, /^\[commit-\d+\]$/);
    assert.notStrictEqual(one, two);
    assert.strictEqual(c.reverts, one);
    assert.strictEqual(c.body, `Reverts ${one}.`);
    assert.strictEqual(out.events[2].toolInput!.command, `git show ${two}`);
    assert.strictEqual(out.events[2].refs!.commit, two, 'a short SHA is its commit');
    assert.strictEqual(out.events[3].eventId, `outcome:milestone:${one}`);
    assert.strictEqual(out.events[3].outcome!.commit, one);
    assert.strictEqual(out.branches[0].head, two);
    assert.strictEqual(out.checkouts[0].commit, one);
    assert.strictEqual(out.sessions[0].commits[0].sha, two);
    assert.strictEqual(out.links[0].to.id, two);
    assert.ok(out.links[0].evidence[0].refs.includes(two));
  }],
  ['ids: one with a path is filtered the same wherever it appears; checkout, link, bead and transition ids kept; superseded links dropped', () => {
    const out = rewriteAll(fixture());
    const id = out.events[1].eventId;
    assert.strictEqual(id, 'claude-code:~/.claude/projects/s.jsonl:123');
    assert.deepStrictEqual(out.events[3].outcome!.refs, [id]);
    assert.ok(out.findings[0].eventRefs.includes(id));
    assert.ok(out.links[0].evidence[0].refs.includes(id));
    assert.strictEqual(out.checkouts[0].id, 'checkout-0123456789abcdef');
    assert.ok(out.links[0].evidence[0].refs.includes('checkout-0123456789abcdef') && out.links[0].evidence[0].refs.includes('acme-1'));
    assert.deepStrictEqual(out.links.map((l) => l.id), ['link-00112233aabbccdd', 'link-99887766aabbccdd']);
    assert.ok(!('supersededBy' in out.links[0]));
    assert.strictEqual(out.links[1].to.id, out.branches[0].id, 'a branch link joins its branch');
    assert.strictEqual(out.branches[0].id, '[person-1]/fix@2026-11-20T08:00:00.000Z');
  }],
  ['--text none keeps structure only', () => {
    const out = rewriteAll(fixture(), 'none');
    assert.strictEqual(out.events[0].promptText, undefined);
    assert.strictEqual(out.events[1].textExcerpt, undefined);
    assert.strictEqual(out.events[2].target, undefined);
    assert.deepStrictEqual(out.events[2].toolInput, { path: './src/app.ts' });
    assert.strictEqual(out.commits[0].subject, '');
    assert.strictEqual(out.commits[0].body, undefined);
    assert.strictEqual(out.commits[0].files[0].path, 'src/app.ts');
    assert.strictEqual(out.planItems[0].title, '');
    assert.strictEqual(out.planItems[0].text, undefined);
    assert.strictEqual(out.sessions[0].name, undefined);
    assert.strictEqual(out.findings[0].summary, undefined);
    assert.strictEqual(out.links.length, 2);
  }],
  ['peopleIn and commitsIn: who and what the records name', () => {
    const input = fixture();
    const people = peopleIn(input);
    assert.ok(people.includes(`${PERSON} <${EMAIL}>`) && people.includes(EMAIL) && people.includes(PERSON) && people.includes('claude-code'));
    assert.deepStrictEqual(commitsIn(input.git!).sort(), [SHA1, SHA2].sort());
  }],
]);
