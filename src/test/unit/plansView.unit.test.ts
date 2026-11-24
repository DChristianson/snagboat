import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommitRecord, currentLinks, LINK_WITHDRAWN, LinkRecord, NormalizedEvent, PlanItemRecord, TransitionRecord } from '@snagboat/schema';
import { linkId } from '../../core/links';
import { appendStoreRecords, readStoreRecordLines } from '../../core/storeRecordFiles';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { LinkerJob } from '../../core/service/linkerJob';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';
import { PlansView, plansView } from '../../core/plansView';

// GET /plans (plansView.ts): a workspace's plan items with their transitions and linked
// sessions, commits and branches, each link with its confidence and evidence, on a made-up store.

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SHA = 'a'.repeat(40);

let n = 0;
const ev = (sessionId: string, at: number, workspace: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: `e${(n += 1)}`, sessionId, agent: 'claude-code', ts: iso(at), kind: 'tool_call', status: 'success', raw: { adapter: 'test', ref: `r${n}` }, workspace, ...extra,
});

async function madeUpStore() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-plans-')));
  const home = path.join(root, '.snagboat');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const t0 = Date.now() - 60 * MIN;
  const writer = new StoreWriter(home);
  await writer.write([
    ev('s1', t0, a, { kind: 'user_prompt' }),
    ev('s1', t0 + MIN, a, { toolName: 'Bash', toolCategory: 'shell', toolInput: { command: 'bd update snagboat-koh --claim' }, refs: { planItems: ['snagboat-koh'] } }),
    ev('s1', t0 + 5 * MIN, a, { toolName: 'Bash', toolCategory: 'shell', toolInput: { command: 'git commit -m "x"' }, refs: { commit: SHA.slice(0, 7) } }),
    ev('s1', t0 + 6 * MIN, a, { kind: 'turn_stop', model: 'claude-sonnet-5', tokens: { input: 10, output: 5 } }),
    ev('s9', t0, b, { kind: 'user_prompt', promptText: 'what about snagboat-koh?' }),
  ]);
  const dir = workspaceStoreDir(home, a);
  const item: PlanItemRecord = { record: 'item', version: 1, id: 'snagboat-koh', kind: 'task', title: 'Volume', status: 'in_progress', labels: [], created: iso(t0 - 60 * MIN), updated: iso(t0 + MIN), source: 'beads', confidence: 'observed' };
  const other: PlanItemRecord = { ...item, id: 'snagboat-zzz', title: 'Other', status: 'open', updated: iso(t0 - 30 * MIN) };
  const claimed: TransitionRecord = { record: 'transition', version: 1, id: 'bd-1', item: 'snagboat-koh', at: iso(t0 + MIN + 500), type: 'claimed', from: 'open', to: 'in_progress', actor: 'Dave', confidence: 'observed' };
  const commit: CommitRecord = { record: 'commit', version: 1, sha: SHA, parents: [], kind: 'commit', authoredAt: iso(t0 + 5 * MIN), committedAt: iso(t0 + 5 * MIN), author: 'Dave <d@example.com>', committer: 'Dave <d@example.com>', coAuthors: [], subject: 'Volume (snagboat-koh)', files: [], onBranches: ['main'] };
  await appendStoreRecords(path.join(dir, 'plan.jsonl'), [item, other, claimed]);
  await appendStoreRecords(path.join(dir, 'git.jsonl'), [commit, { record: 'branch', version: 1, id: `main@${iso(t0 - 600 * MIN)}`, name: 'main', firstSeenAt: iso(t0 - 600 * MIN), head: SHA }]);
  const linker = new LinkerJob(home, writer, { debounceMs: 0 });
  await linker.run();
  linker.dispose();
  return { home, a, b, t0, writer };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the view: items newest first, each with transitions (made in), sessions (with their records), commits and links', async () => {
    const { home, a } = await madeUpStore();
    const view = await plansView({ home, workspace: a });
    assert.strictEqual(view.workspace, a);
    assert.deepStrictEqual(view.workspaces, [a]);
    assert.strictEqual(view.prefix, 'snagboat');
    assert.deepStrictEqual(view.items.map((i) => i.item.id), ['snagboat-koh', 'snagboat-zzz']);
    const koh = view.items[0];
    assert.deepStrictEqual(koh.transitions.map((t) => [t.transition.id, t.sessions.map((s) => `${s.sessionId}:${s.link.confidence}`)]), [['bd-1', ['s1:observed']]]);
    assert.deepStrictEqual(koh.sessions.map((s) => s.sessionId), ['s1']);
    const s1 = koh.sessions[0];
    assert.deepStrictEqual(s1.links.map((l) => `${l.kind}:${l.how ?? ''}:${l.confidence}:${l.evidence.map((e) => e.rule).join('+')}`).sort(), ['made-in::observed:bd-call', 'touched:claimed:observed:bd-call', 'touched:mentioned:inferred:commit-references'].sort());
    assert.strictEqual(s1.session?.sessionId, 's1');
    assert.strictEqual(s1.session?.where, a);
    assert.deepStrictEqual(s1.session?.commits, [{ sha: SHA, confidence: 'observed' }]);
    assert.deepStrictEqual(koh.commits.map((c) => [c.sha, c.commit?.subject, c.links.map((l) => `${l.kind}:${l.confidence}:${l.sessionId ?? ''}`).sort()]), [[SHA, 'Volume (snagboat-koh)', ['made:observed:s1', 'references:observed:']]]);
    assert.deepStrictEqual(koh.branches, [], 'no branch links in this store');
    assert.deepStrictEqual(view.items[1].sessions, []);
  });

  test('a stored over-attached made-in link (the retired active-session rule) is withdrawn on the next pass: gone from the links, the view and GET /plans', async () => {
    const { home, a, t0, writer } = await madeUpStore();
    const dir = workspaceStoreDir(home, a);
    // A transition half an hour after s1's last event, which the old rule gave to s1.
    const late: TransitionRecord = { record: 'transition', version: 1, id: 'bd-2', item: 'snagboat-koh', at: iso(t0 + 40 * MIN), type: 'updated', actor: 'Dave', confidence: 'observed', fields: ['notes'] };
    const from = { type: 'transition' as const, id: 'bd-2' };
    const to = { type: 'session' as const, id: 's1' };
    const stale: LinkRecord = { record: 'link', version: 1, id: linkId(from, to, 'made-in'), from, to, kind: 'made-in', confidence: 'inferred', evidence: [{ rule: 'active-session', refs: ['bd-2'] }], at: late.at };
    await appendStoreRecords(path.join(dir, 'plan.jsonl'), [late]);
    await appendStoreRecords(path.join(dir, 'links.jsonl'), [stale]);
    const linker = new LinkerJob(home, writer, { debounceMs: 0 });
    await linker.run({ full: true });
    const lines = readStoreRecordLines<LinkRecord>(path.join(dir, 'links.jsonl'));
    assert.strictEqual(lines.filter((l) => l.id === stale.id).at(-1)?.supersededBy, LINK_WITHDRAWN);
    assert.ok(!currentLinks(lines).some((l) => l.id === stale.id));
    assert.strictEqual((await linker.run({ full: true })).appended, 0, 'withdrawn once');
    linker.dispose();
    const view = await plansView({ home, workspace: a });
    const bd2 = view.items[0].transitions.find((t) => t.transition.id === 'bd-2')!;
    assert.deepStrictEqual(bd2.sessions, [], 'not made in s1');
    assert.ok(!view.items[0].sessions.some((s) => s.links.some((l) => l.id === stale.id)));
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, collect: false });
    try {
      const info = readCoreFile(home)!;
      const got = (await coreRequest(core.port, info.token, 'GET', `/plans?workspace=${encodeURIComponent(a)}`)).body as PlansView;
      assert.ok(!JSON.stringify(got).includes(stale.id), 'GET /plans has no trace of it');
    } finally {
      await core.stop();
    }
  });

  test('GET /plans: token auth like the other routes; a workspace token reads only its own workspace', async () => {
    const { home, a, b } = await madeUpStore();
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, collect: false });
    try {
      const info = readCoreFile(home)!;
      assert.strictEqual((await coreRequest(core.port, 'nope', 'GET', `/plans?workspace=${encodeURIComponent(a)}`)).status, 401);
      assert.strictEqual((await coreRequest(core.port, info.token, 'GET', '/plans')).status, 400, 'the admin token names one');
      const admin = await coreRequest(core.port, info.token, 'GET', `/plans?workspace=${encodeURIComponent(a)}`);
      assert.strictEqual(admin.status, 200);
      assert.deepStrictEqual((admin.body as PlansView).items.map((i) => i.item.id), ['snagboat-koh', 'snagboat-zzz']);
      const minted = (await coreRequest(core.port, info.token, 'POST', '/tokens', { workspaces: [b] })).body as { token: string };
      assert.strictEqual((await coreRequest(core.port, minted.token, 'GET', `/plans?workspace=${encodeURIComponent(a)}`)).status, 403);
      const own = await coreRequest(core.port, minted.token, 'GET', '/plans');
      assert.strictEqual(own.status, 200);
      assert.deepStrictEqual((own.body as PlansView).items, [], 'b has no plan');
    } finally {
      await core.stop();
    }
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
