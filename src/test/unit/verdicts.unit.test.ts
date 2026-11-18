import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Experiment, periodReportSchema } from '@snagboat/schema';
import { experimentVerdicts } from '../../advisor/report';
import { ExperimentStore } from '../../core/experiments';
import { PeriodJob } from '../../core/service/periodJob';
import { StoreWriter } from '../../core/service/storeWriter';

// Verdicts, keep going and overlaps (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.11).

const WS = '/work/snagboat';
const cache = (value: number) => ({ id: 'cache_hit_rate', label: 'Cache hit rate', unit: '%', better: 'higher' as const, value });
const x = (extra: Partial<Experiment>): Experiment => ({
  version: 1, id: 'x', advisor: 'purser', proposal: 'p', title: 'T', change: { kind: 'setting', key: 'k', after: 1 }, scope: 'global',
  baseline: { report: 'r', measure: 'cache_hit_rate', value: 61 }, prediction: { measure: 'cache_hit_rate', text: 'Back above 66%.' },
  startedAt: new Date(2026, 10, 16).toISOString(), reviewAt: new Date(2026, 10, 23).toISOString(), status: 'running', keptGoing: 0, ...extra,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const to = new Date(2026, 10, 23);

  test('too early before the review date; confounded beside another on the same measure; else met or not met', () => {
    const v = experimentVerdicts(
      [
        x({ id: 'early', reviewAt: new Date(2026, 10, 30).toISOString() }),
        x({ id: 'target', prediction: { measure: 'cache_hit_rate', text: 'Above 66%.', target: { direction: 'above', value: 66 } } }),
        x({ id: 'better' }),
        x({ id: 'ws', scope: { workspace: WS } }),
        x({ id: 'a', overlaps: ['b'] }),
        x({ id: 'b', overlaps: ['a'], status: 'ended' }),
        x({ id: 'later', startedAt: new Date(2026, 10, 24).toISOString() }),
        x({ id: 'other-advisor-is-filtered-by-the-caller', advisor: 'bosun' }),
      ],
      [cache(64)],
      [{ workspace: WS, measures: [cache(58)] }],
      to
    );
    const r = Object.fromEntries(v.map((y) => [y.experiment, y.result]));
    assert.deepStrictEqual(r, { early: 'too-early', target: 'not-met', better: 'met', ws: 'not-met', a: 'met', 'other-advisor-is-filtered-by-the-caller': 'met' }, 'b ended, so a is judged alone; later started after the report');
    assert.deepStrictEqual(v.find((y) => y.experiment === 'ws')!, { experiment: 'ws', measure: 'cache_hit_rate', baseline: 61, now: 58, result: 'not-met', text: 'Cache hit rate 61% at the start, 58% now; predicted: Back above 66%.' });
    const both = experimentVerdicts([x({ id: 'a', overlaps: ['b'] }), x({ id: 'b', overlaps: ['a'] })], [cache(64)], [], to);
    assert.deepStrictEqual(both.map((y) => y.result), ['confounded', 'confounded']);
    assert.match(both[0].text, /may be mixed up with b/);
  });

  test("a period report judges the advisor's running experiments, frozen with its measures", async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-verdicts-')));
    await new StoreWriter(home).write([{ eventId: 'e1', sessionId: 's1', agent: 'claude-code', ts: new Date(2026, 10, 18, 10).toISOString(), kind: 'turn_stop', status: 'success', turnId: 't1', tokens: { input: 100, output: 0, cacheRead: 300, cacheCreation: 0 }, raw: { adapter: 'test', ref: 'r1' }, workspace: WS }]);
    const exps = [x({ id: 'purser-x' }), x({ id: 'bosun-x', advisor: 'bosun' })];
    const job = new PeriodJob(home, () => new Date(2026, 10, 24, 9), undefined, () => exps);
    await job.runDue();
    const r = job.get('purser')!;
    assert.deepStrictEqual(r.verdicts!.map((v) => [v.experiment, v.result, v.now]), [['purser-x', 'met', 75]]);
    assert.strictEqual(job.get('navigator')!.verdicts, undefined, 'none of its own experiments');
    const item = (periodReportSchema as { properties: { verdicts: { items: { properties: Record<string, unknown> } } } }).properties.verdicts.items.properties;
    for (const key of Object.keys(r.verdicts![0])) assert.ok(key in item, `${key} is in the schema`);
  });

  test('keep going moves the review a period and counts it; accepting the result ends it with the change kept', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-verdicts-'));
    fs.mkdirSync(path.join(home, 'experiments'));
    fs.writeFileSync(path.join(home, 'experiments', 'k.json'), JSON.stringify(x({ id: 'k' })));
    const store = new ExperimentStore(home, () => new Date(2026, 10, 23, 9));
    const kept = store.keep('k', 'weekly');
    assert.deepStrictEqual([kept.reviewAt, kept.keptGoing], [new Date(2026, 10, 30).toISOString(), 1]);
    assert.strictEqual(store.keep('k', 'weekly').keptGoing, 2);
    const done = store.accept('k');
    assert.deepStrictEqual([done.status, done.ended?.how], ['ended', 'accepted']);
    assert.throws(() => store.keep('k', 'weekly'), /already ended/);
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
