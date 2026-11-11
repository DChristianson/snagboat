import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { Aggregate } from '../../core/aggregate';
import { EventLog } from '../../core/eventLog';
import { EventStore } from '../../core/eventStore';
import { CoreClient } from '../../core/service/client';
import { CoreInfo, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { workspaceStoreDir } from '../../core/userStore';
import { commandOf, OUTCOMES_ADAPTER, TestsGreen } from '../../outcomes/testsGreen';

// Outcome capture (RFC step 4, 4a): tests going green worked out from tool calls, in a window
// writing its own folder and in the core; outcome events are measures, not activity.

let n = 0;
const run = (status: NormalizedEvent['status'], opts: { session?: string; category?: NormalizedEvent['toolCategory']; at?: number; command?: string } = {}): NormalizedEvent => ({
  eventId: `t${(n += 1)}`,
  sessionId: opts.session ?? 's1',
  agent: 'claude-code',
  ts: new Date(opts.at ?? Date.now()).toISOString(),
  kind: 'tool_call',
  status,
  toolName: 'Bash',
  target: opts.command ?? 'npm test',
  toolCategory: opts.category ?? 'tests-builds',
  raw: { adapter: 'test', ref: `r${n}` },
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a test run passing after failures in the same session is one tests_green outcome', () => {
    const green = new TestsGreen();
    const t0 = Date.parse('2026-11-11T10:00:00Z');
    const f1 = run('failure', { at: t0 });
    const f2 = run('failure', { at: t0 + 60_000 });
    const other = run('failure', { session: 's2', at: t0 });
    const notTests = run('success', { category: 'shell', at: t0 + 90_000 });
    const unknown = run('unknown', { at: t0 + 100_000 });
    const pass = run('success', { at: t0 + 120_000 });
    const out = green.observe([f1, f2, other, notTests, unknown, pass]);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].outcome, { type: 'tests_green', refs: [f1.eventId, pass.eventId], failures: 2, afterMs: 120_000 });
    assert.deepStrictEqual([out[0].kind, out[0].sessionId, out[0].ts, out[0].eventId, out[0].raw.adapter], ['outcome', 's1', pass.ts, `outcome:tests_green:${pass.eventId}`, OUTCOMES_ADAPTER]);
    assert.deepStrictEqual(green.observe([run('success')]), [], 'green again: nothing new');
    assert.strictEqual(green.observe([run('success', { session: 's2' })]).length, 1, 'the other session goes green on its own');
  });

  test('only the same command passing turns it green: a build or typecheck passing leaves failing tests red', () => {
    assert.deepStrictEqual(
      ['npm test', 'npm test -- -t login', 'npx tsc --noEmit', 'cargo test --release', 'pytest tests/test_a.py', 'cd app && npm run build'].map((c) => commandOf(run('success', { command: c }))),
      ['npm test', 'npm test', 'npx tsc', 'cargo test', 'pytest', 'npm run']
    );
    const green = new TestsGreen();
    assert.deepStrictEqual(green.observe([run('failure', { command: 'npm test' }), run('success', { command: 'npx tsc --noEmit' })]), []);
    const [out] = green.observe([run('success', { command: 'npm test -- -t login' })]);
    assert.strictEqual(out?.outcome?.type, 'tests_green', 'the same runner and subcommand');
    green.observe([run('failure', { command: 'npm test' })]);
    green.reset();
    assert.deepStrictEqual(green.observe([run('success', { command: 'npm test' })]), [], 'forgotten after a reset (the log was cleared)');
  });

  test('outcome events are measures, not activity: totals and heuristics leave them out', () => {
    const [outcome] = new TestsGreen().observe([run('failure'), run('success')]);
    const agg = new Aggregate();
    agg.apply(outcome);
    assert.strictEqual(agg.snapshot().perAgent['claude-code'], undefined);
    const store = new EventStore({ windowMs: 86_400_000, maxEvents: 100 });
    store.ingest(outcome);
    assert.deepStrictEqual(store.query(), []);
  });

  test('the core records tests going green for what it writes, and sends it on the workspace\'s stream', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-outcomes-')));
    const home = path.join(root, '.snagboat');
    const workspace = path.join(root, 'w');
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, collect: false });
    const got: NormalizedEvent[] = [];
    const client = await CoreClient.connect({ home, cliPath: '/nowhere', workspace, ensure: async (): Promise<CoreInfo> => readCoreFile(home)! });
    client.follow({ onEvents: (events) => got.push(...events) }, new Date().toISOString());
    try {
      await client.post([run('failure')]);
      await client.post([run('success')]);
      await waitFor(() => got.some((e) => e.kind === 'outcome'));
      const stored = (await new EventLog(workspaceStoreDir(home, workspace)).readAll()).filter((e) => e.kind === 'outcome');
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0].outcome?.type, 'tests_green');
      assert.strictEqual(stored[0].workspace, workspace);
    } finally {
      client.close();
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
