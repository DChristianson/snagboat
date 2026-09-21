import * as assert from 'assert';
import { HeuristicsEngine } from '../../heuristics/engine';
import { FindingsRegistry } from '../../heuristics/findingsRegistry';
import { stalledHeuristic } from '../../heuristics/stalled';
import { Heuristic, Finding, HeuristicContext } from '../../heuristics/types';
import { ReadonlyEventStore } from '../../core/eventStore';

const fakeStore: ReadonlyEventStore = {
  query: () => [],
  lastN: () => [],
  latestTs: () => undefined,
  cumulativeTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
};

function storeWithLatestTs(ts: string | undefined): ReadonlyEventStore {
  return { ...fakeStore, latestTs: () => ts };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    heuristicId: 'fake',
    severity: 'warn',
    summary: 'something happened',
    eventRefs: [],
    detectedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A heuristic whose behavior is controlled by the test, to drive the engine deterministically. */
function fakeHeuristic(id: string, appliesTo: Heuristic['appliesTo'], respond: (ctx: HeuristicContext) => Finding[]): Heuristic {
  return { id, appliesTo, evaluate: respond };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('HeuristicsEngine.tick runs every heuristic regardless of kind', () => {
    const calls: string[] = [];
    const engine = new HeuristicsEngine(
      [
        fakeHeuristic('a', ['edit'], () => { calls.push('a'); return []; }),
        fakeHeuristic('b', ['tool_call'], () => { calls.push('b'); return []; }),
      ],
      fakeStore,
      () => ({})
    );
    engine.tick('2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(calls.sort(), ['a', 'b']);
  });

  test('HeuristicsEngine.tickFor only runs heuristics whose appliesTo includes the kind', () => {
    const calls: string[] = [];
    const engine = new HeuristicsEngine(
      [
        fakeHeuristic('a', ['edit'], () => { calls.push('a'); return []; }),
        fakeHeuristic('b', ['tool_call'], () => { calls.push('b'); return []; }),
        fakeHeuristic('c', ['edit', 'tool_call'], () => { calls.push('c'); return []; }),
      ],
      fakeStore,
      () => ({})
    );
    engine.tickFor('edit', '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(calls.sort(), ['a', 'c']);
  });

  test('HeuristicsEngine passes the right now/store/settings into each evaluate() call', () => {
    let seen: HeuristicContext | undefined;
    const settingsFor = (id: string) => ({ id, threshold: 42 });
    const engine = new HeuristicsEngine(
      [fakeHeuristic('a', ['edit'], (ctx) => { seen = ctx; return []; })],
      fakeStore,
      settingsFor
    );
    engine.tick('2026-06-01T12:00:00.000Z');
    assert.strictEqual(seen?.now, '2026-06-01T12:00:00.000Z');
    assert.strictEqual(seen?.store, fakeStore);
    assert.deepStrictEqual(seen?.settings, { id: 'a', threshold: 42 });
  });

  test('FindingsRegistry replaces the whole set per heuristic and clears on empty', () => {
    const registry = new FindingsRegistry();
    registry.report('backtracking', [makeFinding({ heuristicId: 'backtracking', summary: 'file A' })]);
    registry.report('stalled', [makeFinding({ heuristicId: 'stalled', summary: 'idle' })]);
    assert.strictEqual(registry.list().length, 2);

    registry.report('backtracking', [makeFinding({ heuristicId: 'backtracking', summary: 'file B' })]);
    assert.strictEqual(registry.list().length, 2, 'replacing, not appending, per heuristic');
    assert.ok(registry.list().some((f) => f.summary === 'file B'));
    assert.ok(!registry.list().some((f) => f.summary === 'file A'));

    registry.report('stalled', []);
    assert.strictEqual(registry.list().length, 1, 'reporting an empty array clears that heuristic entirely');
  });

  test('FindingsRegistry.onChange only notifies on a real change', () => {
    const registry = new FindingsRegistry();
    let notifications = 0;
    registry.onChange(() => (notifications += 1));

    const finding = makeFinding();
    registry.report('a', [finding]);
    assert.strictEqual(notifications, 1);

    registry.report('a', [finding]);
    assert.strictEqual(notifications, 1, 'reporting the identical set again must not notify');

    registry.report('a', []);
    assert.strictEqual(notifications, 2);

    registry.report('a', []);
    assert.strictEqual(notifications, 2, 'clearing an already-empty heuristic must not notify');
  });

  test('FindingsRegistry.worst ranks warn over info, then most recent detectedAt', () => {
    const registry = new FindingsRegistry();
    registry.report('info-new', [makeFinding({ heuristicId: 'info-new', severity: 'info', detectedAt: '2026-01-01T00:00:03.000Z' })]);
    registry.report('warn-old', [makeFinding({ heuristicId: 'warn-old', severity: 'warn', detectedAt: '2026-01-01T00:00:01.000Z' })]);
    registry.report('warn-new', [makeFinding({ heuristicId: 'warn-new', severity: 'warn', detectedAt: '2026-01-01T00:00:02.000Z' })]);

    assert.strictEqual(registry.worst()?.heuristicId, 'warn-new', 'warn must outrank a more recent info, and among warns the most recent wins');

    const empty = new FindingsRegistry();
    assert.strictEqual(empty.worst(), undefined);
  });

  test('stalled: no events at all produces no finding', () => {
    const ctx: HeuristicContext = { now: '2026-01-01T00:20:00.000Z', store: storeWithLatestTs(undefined), settings: {} };
    assert.deepStrictEqual(stalledHeuristic.evaluate(ctx), []);
  });

  test('stalled: recent activity within the threshold produces no finding', () => {
    const ctx: HeuristicContext = {
      now: '2026-01-01T00:10:00.000Z',
      store: storeWithLatestTs('2026-01-01T00:00:00.000Z'), // 10 minutes ago, under the default 15
      settings: {},
    };
    assert.deepStrictEqual(stalledHeuristic.evaluate(ctx), []);
  });

  test('stalled: activity older than the threshold produces a warn finding', () => {
    const ctx: HeuristicContext = {
      now: '2026-01-01T00:20:00.000Z',
      store: storeWithLatestTs('2026-01-01T00:00:00.000Z'), // 20 minutes ago, over the default 15
      settings: {},
    };
    const [finding] = stalledHeuristic.evaluate(ctx);
    assert.ok(finding);
    assert.strictEqual(finding.heuristicId, 'stalled');
    assert.strictEqual(finding.severity, 'warn');
    assert.strictEqual(finding.detectedAt, ctx.now);
    assert.ok(finding.summary.includes('20'), finding.summary);
  });

  test('stalled: a custom minutes setting is respected, including falling back to the default when invalid', () => {
    const latestTs = '2026-01-01T00:00:00.000Z';
    const fiveMinutesLater = '2026-01-01T00:05:00.000Z';

    assert.strictEqual(
      stalledHeuristic.evaluate({ now: fiveMinutesLater, store: storeWithLatestTs(latestTs), settings: { minutes: 3 } }).length,
      1,
      'a tighter custom threshold should fire sooner than the default'
    );
    assert.strictEqual(
      stalledHeuristic
        .evaluate({ now: fiveMinutesLater, store: storeWithLatestTs(latestTs), settings: { minutes: 'not-a-number' } })
        .length,
      0,
      'an invalid setting value should fall back to the 15-minute default, under which 5 minutes elapsed is fine'
    );
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
  if (failures > 0) process.exit(1);
}

main();
