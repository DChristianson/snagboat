import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { syntheticEvents } from '@snagboat/viz/web';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { runDiscovery } from '../../discovery/discover';
import { DiscoveryData, discoverOffThread, discoveryOptionsOf, WORKER_SCRIPT, workerAvailable } from '../../discovery/offThread';
import { builtInHeuristics } from '../../heuristics/builtIns';
import { parseRule } from '../../heuristics/rule';

// Discovery off the core's event loop (snagboat-79f.6.8): the worker's results are the in-process
// ones for the same input, and the core keeps answering while discovery runs on a long history.

/** The synthetic sessions n times under new ids, each copy an hour (or `step` ms) earlier. */
function history(n: number, step = 3_600_000): NormalizedEvent[] {
  const base = syntheticEvents();
  return Array.from({ length: n }, (_, k) => k).flatMap((k) =>
    base.map((e) => ({ ...e, eventId: `${e.eventId}-${k}`, sessionId: `${e.sessionId}-${k}`, ...(e.turnId ? { turnId: `${e.turnId}-${k}` } : {}), ts: new Date(Date.parse(e.ts) - k * step).toISOString() }))
  );
}

const READ_RULE = {
  id: 'test:many-reads',
  title: 'Many reads',
  scope: 'turn',
  measure: { type: 'count', filter: { kind: ['tool_call'], toolCategory: ['file-read'] } },
  when: { measure: 'value', gte: 3 },
  severity: 'info',
  summary: '{value} reads',
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the worker script is built beside the module that starts it', () => {
    assert.ok(workerAvailable(), WORKER_SCRIPT);
  });

  test("the worker's discovery, tweaks and scores equal the in-process ones", async () => {
    const rule = parseRule(READ_RULE).value!;
    const data: DiscoveryData = {
      builtIns: builtInHeuristics().map((h) => h.id),
      rules: [rule],
      settings: { runawayTurn: { maxModelCalls: 20 } },
      contextLimits: { 'claude-sonnet': 200_000 },
    };
    for (const n of [4, 12]) {
      const events = history(n);
      const local = runDiscovery(events, discoveryOptionsOf(data));
      const remote = await discoverOffThread(events, data);
      try {
        assert.deepStrictEqual(remote.result, local.result, `discovery over ${n} copies`);
        assert.deepStrictEqual(remote.events, local.events);
        const session = local.events[0].sessionId;
        assert.deepStrictEqual(remote.sessionEvents(session), local.sessionEvents(session));
        const scored = [rule, parseRule({ ...READ_RULE, id: 'test:some-reads', when: { measure: 'value', gte: 1 } }).value!];
        assert.deepStrictEqual(await remote.score(scored), local.score(scored));
        const candidate = local.result.candidates[0];
        if (n === 4) assert.ok(candidate, 'four copies have a candidate to tweak');
        if (candidate) {
          for (const t of [1, candidate.threshold * 2]) assert.deepStrictEqual(await remote.tweak(candidate.rule.id, t), local.tweak(candidate.rule.id, t), `tweak to ${t}`);
          assert.strictEqual(await remote.tweak(candidate.rule.id, 0), undefined);
        }
        assert.strictEqual(await remote.tweak('discovery:nothing-like-it', 3), undefined);
      } finally {
        remote.dispose();
      }
    }
  });

  test('a disposed run says so instead of hanging', async () => {
    const run = await discoverOffThread(history(1), { builtIns: [], rules: [], settings: {}, contextLimits: {} });
    run.dispose();
    await assert.rejects(run.score([]), /stopped/);
  });

  test('the core answers /health promptly while discovery runs on a long history', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-worker-')));
    const w = path.join(home, 'w');
    fs.mkdirSync(w);
    // 200 copies, ten minutes apart, ending an hour ago: ~100k events over the last day or two.
    const events = history(200, 600_000);
    const latest = Math.max(...events.map((e) => Date.parse(e.ts)));
    const shift = Date.now() - 3_600_000 - latest;
    const writer = new StoreWriter(home);
    const shifted = events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString(), workspace: w }));
    // In batches: the writer groups a batch by workspace by copying, which is slow for one huge batch.
    for (let i = 0; i < shifted.length; i += 2000) await writer.write(shifted.slice(i, i + 2000));
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
    try {
      const info = readCoreFile(home)!;
      const status = async () => ((await coreRequest(core.port, info.token, 'GET', `/suggestions?workspace=${encodeURIComponent(w)}`, undefined, 60_000)).body as { status: string; turns: number }).status;
      const started = Date.now();
      assert.ok(['idle', 'running'].includes(await status()));
      // The test shares the core's process, so a blocked loop would hold up its own requests too:
      // the longest gap between 10 ms ticks is how long the core couldn't answer anything.
      let lastTick = Date.now();
      let longestGap = 0;
      const ticker = setInterval(() => {
        const now = Date.now();
        longestGap = Math.max(longestGap, now - lastTick);
        lastTick = now;
      }, 10);
      // And /health asked over and over meanwhile.
      const latencies: number[] = [];
      let done = false;
      const pinger = (async () => {
        while (!done) {
          const t = Date.now();
          const health = await coreRequest(core.port, info.token, 'GET', '/health', undefined, 30_000);
          assert.strictEqual(health.status, 200);
          latencies.push(Date.now() - t);
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
      try {
        while ((await status()) === 'running') {
          assert.ok(Date.now() - started < 120_000, 'discovery never finished');
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        done = true;
        clearInterval(ticker);
        await pinger;
      }
      const body = (await coreRequest(core.port, info.token, 'GET', `/suggestions?workspace=${encodeURIComponent(w)}`)).body as { status: string; turns: number };
      assert.strictEqual(body.status, 'ready', JSON.stringify(body).slice(0, 300));
      assert.ok(body.turns > 1000, `discovery saw ${body.turns} turns`);
      const max = Math.max(...latencies);
      console.log(`      discovery took ${Date.now() - started} ms; the loop's longest pause ${longestGap} ms; /health answered ${latencies.length} times, at most in ${max} ms`);
      assert.ok(latencies.length >= 3, `only ${latencies.length} health checks during discovery`);
      assert.ok(max < 500, `/health took ${max} ms during discovery`);
      assert.ok(longestGap < 500, `the core's event loop stopped for ${longestGap} ms during discovery`);
    } finally {
      await core.stop();
      fs.rmSync(home, { recursive: true, force: true });
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
