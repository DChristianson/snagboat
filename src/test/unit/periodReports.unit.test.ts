import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { nextPeriod, periodLabel, PeriodReport, periodStart, previousPeriod } from '../../advisor/report';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { PeriodJob } from '../../core/service/periodJob';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// Period reports (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.2): period math, the reports
// the core writes on schedule and on request, chained with no gap, frozen once written.

let n = 0;
const local = (y: number, mo: number, d: number, h = 0) => new Date(y, mo - 1, d, h);
const turn = (workspace: string, at: Date, input: number, cacheRead: number): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId: `s${n}`,
  agent: 'claude-code',
  ts: at.toISOString(),
  kind: 'turn_stop',
  status: 'success',
  turnId: 't1',
  tokens: { input, output: 0, cacheRead, cacheCreation: 0 },
  raw: { adapter: 'test', ref: `r${n}` },
  workspace,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('periods start at local midnight, Monday, or the 1st, and are named by day, ISO week or month', () => {
    const wed = local(2026, 11, 18, 15);
    assert.deepStrictEqual(periodStart('weekly', wed), local(2026, 11, 16));
    assert.deepStrictEqual(periodStart('daily', wed), local(2026, 11, 18));
    assert.deepStrictEqual(periodStart('monthly', wed), local(2026, 11, 1));
    assert.deepStrictEqual(periodStart('weekly', local(2026, 11, 22, 23)), local(2026, 11, 16), 'Sunday is the end of the week');
    assert.strictEqual(periodLabel('weekly', local(2026, 11, 9)), '2026-W46');
    assert.strictEqual(periodLabel('weekly', local(2026, 12, 28)), '2026-W53');
    assert.strictEqual(periodLabel('weekly', local(2024, 12, 30)), '2025-W01');
    assert.strictEqual(periodLabel('daily', local(2026, 11, 9)), '2026-11-09');
    assert.strictEqual(periodLabel('monthly', local(2026, 11, 9)), '2026-11');
    assert.deepStrictEqual(nextPeriod('monthly', local(2026, 12, 1)), local(2027, 1, 1));
    assert.deepStrictEqual(previousPeriod('weekly', local(2026, 11, 16)), local(2026, 11, 9));
  });

  test('the core writes each closed period once, chains reports with no gap, and catches up', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-periods-')));
    const w1 = path.join(home, 'w1');
    const w2 = path.join(home, 'w2');
    fs.mkdirSync(w1);
    fs.mkdirSync(w2);
    // W45: 50% cache hits; W46: 75% in w1, none in w2.
    await new StoreWriter(home).write([
      turn(w1, local(2026, 11, 4, 10), 100, 100),
      turn(w1, local(2026, 11, 11, 10), 100, 300),
      turn(w2, local(2026, 11, 12, 10), 100, 0),
    ]);
    let now = local(2026, 11, 18, 10);
    const job = new PeriodJob(home, () => now);

    const first = await job.runDue();
    assert.deepStrictEqual(first.map((r) => r.advisor), ['purser', 'navigator', 'bosun', 'lookout']);
    const w46 = job.get('purser')!;
    assert.deepStrictEqual([w46.id, w46.label, w46.trigger, w46.from, w46.to], ['2026-W46', '2026-W46', 'schedule', local(2026, 11, 9).toISOString(), local(2026, 11, 16).toISOString()]);
    const cache = w46.measures.find((m) => m.id === 'cache_hit_rate')!;
    assert.deepStrictEqual([cache.value, cache.previous, cache.trend], [60, 50, 'better'], 'all workspaces: 300 of 500 tokens now, 100 of 200 the week before');
    assert.deepStrictEqual(w46.workspaces.map((x) => [x.workspace, x.measures.find((m) => m.id === 'cache_hit_rate')!.value]), [[w1, 75], [w2, 0]]);
    assert.match(w46.summary, /cache hit rate/);
    assert.ok(Array.isArray(w46.rules.saved) && typeof w46.rules.defaults === 'object');
    assert.deepStrictEqual(await job.runDue(), [], 'nothing more is due this week');
    assert.throws(() => fs.writeFileSync(path.join(home, 'advisors', 'purser', 'periods', '2026-W46.json'), '{}', { flag: 'wx' }), /EEXIST/);

    // Two weeks later: W47 and W48, each starting where the last ended; "before" is the last report.
    await new StoreWriter(home).write([turn(w1, local(2026, 11, 18, 12), 100, 100)]);
    now = local(2026, 12, 2, 10);
    const caught = (await job.runDue()).filter((r) => r.advisor === 'purser');
    assert.deepStrictEqual(caught.map((r) => r.id), ['2026-W47', '2026-W48']);
    assert.deepStrictEqual([caught[0].from, caught[0].previous], [w46.to, '2026-W46']);
    assert.strictEqual(caught[1].from, caught[0].to);
    const c47 = caught[0].measures.find((m) => m.id === 'cache_hit_rate')!;
    assert.deepStrictEqual([c47.value, c47.previous, c47.trend], [50, 60, 'worse']);

    // Asked for mid-week: from the last report to now; the scheduled one then covers the rest of the week.
    const asked = await job.request('purser');
    assert.deepStrictEqual([asked.id, asked.trigger, asked.from, asked.to], ['2026-W49-asked-1', 'request', caught[1].to, now.toISOString()]);
    assert.strictEqual((await job.request('purser')).id, '2026-W49-asked-2');
    await assert.rejects(job.request('nobody'), /no advisor nobody/);
    now = local(2026, 12, 8, 10);
    const w49 = (await job.runDue()).find((r) => r.advisor === 'purser')!;
    assert.deepStrictEqual([w49.id, w49.previous, w49.to], ['2026-W49', '2026-W49-asked-2', local(2026, 12, 7).toISOString()]);
    const chain = job.list('purser');
    for (let i = 1; i < chain.length; i++) assert.strictEqual(chain[i].from, chain[i - 1].to, `${chain[i].id} starts where ${chain[i - 1].id} ended`);

    // A long gap: at most MAX_CATCH_UP periods, the earliest covering the rest.
    now = local(2027, 6, 2, 10);
    const late = (await job.runDue()).filter((r) => r.advisor === 'purser');
    assert.strictEqual(late.length, 8);
    assert.strictEqual(late[0].from, w49.to);
  });

  test('a monthly advisor reports monthly', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-periods-')));
    fs.mkdirSync(path.join(home, 'advisors', 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(home, 'advisors', 'ledger', 'persona.md'), '---\nid: ledger\ngoal: g\nperiod: monthly\nmeasures: [cache_hit_rate]\n---\n');
    const job = new PeriodJob(home, () => local(2026, 11, 18));
    await job.runDue();
    const r = job.get('ledger')!;
    assert.deepStrictEqual([r.id, r.period, r.from, r.to], ['2026-10', 'monthly', local(2026, 10, 1).toISOString(), local(2026, 11, 1).toISOString()]);
  });

  test('GET and POST /advisors/:id/report, for tokens that read every workspace', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-periods-')));
    const w = path.join(home, 'w');
    fs.mkdirSync(w);
    await new StoreWriter(home).write([turn(w, local(2026, 11, 11, 10), 100, 300)]);
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false, periodEveryMs: 0, now: () => local(2026, 11, 18, 10) });
    try {
      const info = readCoreFile(home)!;
      assert.strictEqual((await coreRequest(info.port, info.token, 'GET', '/advisors/purser/report')).status, 404);
      const made = await coreRequest(info.port, info.token, 'POST', '/advisors/purser/report');
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.strictEqual((made.body as { report: PeriodReport }).report.id, '2026-W47-asked-1');
      const got = (await coreRequest(info.port, info.token, 'GET', '/advisors/purser/report')).body as { report: PeriodReport; reports: Array<{ id: string }> };
      assert.deepStrictEqual(got.reports.map((r) => r.id), ['2026-W46', '2026-W47-asked-1']);
      assert.strictEqual(got.report.id, '2026-W47-asked-1');
      const byId = (await coreRequest(info.port, info.token, 'GET', '/advisors/purser/report?id=2026-W46')).body as { report: PeriodReport };
      assert.strictEqual(byId.report.measures.find((m) => m.id === 'cache_hit_rate')!.value, 75);
      assert.strictEqual((await coreRequest(info.port, info.token, 'POST', '/advisors/nobody/report')).status, 404);
      const minted = await coreRequest(info.port, info.token, 'POST', '/tokens', { workspaces: [w] });
      const token = (minted.body as { token: string }).token;
      assert.strictEqual((await coreRequest(info.port, token, 'GET', '/advisors/purser/report')).status, 403, 'a workspace token sees only its own workspace');
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
