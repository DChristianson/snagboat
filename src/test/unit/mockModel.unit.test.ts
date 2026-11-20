import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SetupConversation } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { syntheticEvents } from '../fixtures/synthetic';
import { startMockModel } from '../../scripts/mockModel';

// The mock model for trying the + page's setup chat in a browser (npm run mock:model; snagboat-79f.7.16),
// driven through the real core as the page drives it: every path its script offers ends where the page
// expects, so what you see when you try it by hand is the core's real behaviour.

type View = { setup: SetupConversation; ask?: { state: string; error?: string; approval?: { id: string } }; advisor?: { id: string; name: string } };

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const mock = await startMockModel(0);
  const base = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-mock-model-')));
  // One workspace with a day of sessions: the page approves a report's request on a workspace's Suggestions route.
  const ws = path.join(home, 'proj');
  fs.mkdirSync(ws);
  const events = syntheticEvents();
  const shift = Date.now() - 3_600_000 - Math.max(...events.map((e) => Date.parse(e.ts)));
  await new StoreWriter(home).write(events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString(), workspace: ws })));
  saveConfig(home, {
    version: 1,
    defaults: {
      advisors: [
        { id: 'mock-a', label: 'Mock A', baseUrl: base, model: 'mock-a' },
        { id: 'mock-b', label: 'Mock B', baseUrl: base, model: 'mock-b' },
      ],
    },
    projects: {},
  });
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false, periodEveryMs: 0 });
  const info = readCoreFile(home)!;
  const call = (method: string, p: string, body?: unknown) => coreRequest(core.port, info.token, method, p, body, 30_000);
  const until = async (id: string, ok: (v: View) => boolean, what: string): Promise<View> => {
    for (let i = 0; i < 200; i++) {
      const v = (await call('GET', `/advisor-setups/${id}`)).body as View;
      if (v.ask?.approval) await call('POST', `/advisor-setups/${id}/approval`, { id: v.ask.approval.id, send: true });
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never: ${what}`);
  };
  const answered = (id: string, turns: number) => until(id, (v) => v.setup.turns.length >= turns && !v.ask, `${turns} turns`);
  const start = async (text: string, model = 'mock-a') => ((await call('POST', '/advisor-setups', { model, text })).body as View).setup.id;

  test('a question first, then a proposal from the lists, on a model switch; it revises and is accepted', async () => {
    const id = await start('I keep running out of context.');
    let v = await answered(id, 2);
    assert.match(v.setup.turns[1].text, /What would tell you.*\(mock-a\)/);
    assert.ok(!v.setup.proposal);
    await call('POST', `/advisor-setups/${id}/messages`, { text: 'Fewer compactions.', model: 'mock-b' });
    v = await answered(id, 4);
    assert.deepStrictEqual(v.setup.turns[3].model, { advisor: 'mock-b', model: 'mock-b' });
    assert.deepStrictEqual(v.setup.turns[3].problems ?? [], [], 'nothing dropped');
    const p = v.setup.proposal!;
    assert.strictEqual(p.spec.name, 'Headroom');
    assert.deepStrictEqual(p.spec.rules, ['context-pressure']);
    assert.ok(p.spec.measures.length > 0);
    await call('POST', `/advisor-setups/${id}/proposal`, { action: 'revise', note: 'Report daily instead' });
    v = await answered(id, 6);
    assert.strictEqual(v.setup.proposal!.spec.period, 'daily');
    assert.strictEqual(v.setup.proposal!.spec.status, 'Report daily instead');
    const r = await call('POST', `/advisor-setups/${id}/proposal`, { action: 'accept', turn: v.setup.proposal!.turn });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual((r.body as View).advisor, { id: 'headroom', name: 'Headroom' });
    assert.match(fs.readFileSync(path.join(home, 'advisors', 'headroom', 'persona.md'), 'utf8'), /^model: mock-b$/m);
  });

  type ReportView = { proposals: Array<{ id: string; title: string; status: string; replaces?: string; change: { key?: string; after?: number } }>; review: { rev: number; unmarked: number; state: string }; ask?: { state: string; error?: string; approval?: { id: string } } };
  const report = async (advisor: string, ok: (v: ReportView) => boolean, what: string): Promise<ReportView> => {
    for (let i = 0; i < 200; i++) {
      const v = (await call('GET', `/advisors/${advisor}/report`)).body as ReportView;
      if (v.ask?.approval) await call('POST', '/suggestions', { workspace: ws, action: 'approve', id: v.ask.approval.id, send: true });
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    const last = (await call('GET', `/advisors/${advisor}/report`)).body as ReportView & { revisions?: unknown };
    throw new Error(`never: ${what}: ask ${JSON.stringify(last.ask)} review ${JSON.stringify(last.review)}`);
  };

  test("the advisor it made gets its reports answered by the mock: proposals wait, as VS Code's link counts them", async () => {
    const r = await call('POST', '/advisors/headroom/report');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const v = await report('headroom', (x) => x.review.rev >= 1, 'the first revision');
    assert.ok(v.proposals.length >= 1 && v.proposals.length <= 2, JSON.stringify(v.proposals));
    assert.ok(v.proposals.every((p) => p.status === 'open'));
    assert.strictEqual(v.proposals[0].change.key, 'heuristics.contextPressure.percent', 'a context goal loosens the context setting first');
    const advisors = (await call('GET', '/advisors')).body as { advisors: Array<{ id: string; review?: { unmarked?: number } }> };
    assert.strictEqual(advisors.advisors.find((a) => a.id === 'headroom')!.review!.unmarked, v.proposals.length, 'what the findings view and status bar show');
  });

  test('Revise report: the mock answers the note with a smaller step that replaces it', async () => {
    const before = (await call('GET', '/advisors/headroom/report')).body as ReportView;
    const [first, ...rest] = before.proposals;
    assert.strictEqual((await call('POST', `/proposals/${encodeURIComponent(first.id)}`, { mark: 'revise', note: 'Too big a jump' })).status, 200);
    for (const p of rest) await call('POST', `/proposals/${encodeURIComponent(p.id)}`, { mark: 'discard' });
    const sent = await call('POST', `/advisors/headroom/report/${before.review.rev}`);
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    const v = await report('headroom', (x) => x.review.rev > before.review.rev, 'the revision');
    const replacement = v.proposals.find((p) => p.replaces === first.id);
    assert.ok(replacement, JSON.stringify(v.proposals));
    assert.ok(replacement!.change.after! < first.change.after!, 'a smaller step');
  });

  test('the next advisor on the same topic gets a name not taken', async () => {
    const id = await start('Please propose one for context.');
    const v = await answered(id, 2);
    assert.strictEqual(v.setup.proposal!.spec.name, 'Headroom 2');
    await call('POST', `/advisor-setups/${id}/proposal`, { action: 'discard' });
  });

  test('mock:bad is kept out, goes straight back for repair, and the fix is shown', async () => {
    const id = await start('Spending too much on tokens. propose mock:bad');
    const v = await answered(id, 3);
    assert.deepStrictEqual(v.setup.turns.map((t) => t.from), ['you', 'model', 'model']);
    assert.ok(!v.setup.turns[1].proposal);
    assert.ok(v.setup.turns[1].problems!.some((x) => /made_up_measure/.test(x)), v.setup.turns[1].problems!.join(' | '));
    assert.strictEqual(v.setup.proposal!.spec.name, 'Ledger');
    await call('POST', `/advisor-setups/${id}/proposal`, { action: 'discard' });
  });

  test('mock:text is kept as a reply; mock:error shows the failure', async () => {
    const text = await start('mock:text');
    const v = await answered(text, 2);
    assert.match(v.setup.turns[1].text, /as prose/);
    assert.ok(v.setup.turns[1].problems!.some((x) => /not the JSON/.test(x)));
    await call('POST', `/advisor-setups/${text}/proposal`, { action: 'discard' });
    const failed = await start('mock:error');
    const e = await until(failed, (x) => x.ask?.state === 'failed' || (!x.ask && x.setup.turns.length > 1), 'the failure');
    assert.ok(e.ask?.error || e.setup.turns.length === 1, JSON.stringify(e.ask));
    await call('POST', `/advisor-setups/${failed}/proposal`, { action: 'discard' });
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
  await core.stop({ final: true }).catch(() => undefined);
  mock.close();
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
