import * as assert from 'assert';
import { HeuristicsEngine } from '../../heuristics/engine';
import { FindingsRegistry } from '../../heuristics/findingsRegistry';
import { stalledHeuristic } from '../../heuristics/stalled';
import { tokenBudgetHeuristic } from '../../heuristics/tokenBudget';
import { toolChurnHeuristic } from '../../heuristics/toolChurn';
import { backtrackingHeuristic } from '../../heuristics/backtracking';
import { Heuristic, Finding, HeuristicContext } from '../../heuristics/types';
import { ReadonlyEventStore, TokenTotals } from '../../core/eventStore';
import { NormalizedEvent } from '../../core/types';

const fakeStore: ReadonlyEventStore = {
  query: () => [],
  lastN: () => [],
  latestTs: () => undefined,
  cumulativeTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
};

function storeWithLatestTs(ts: string | undefined): ReadonlyEventStore {
  return { ...fakeStore, latestTs: () => ts };
}

function totals(input: number): TokenTotals {
  return { input, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function fakeEvent(sessionId: string): NormalizedEvent {
  return {
    eventId: `evt-${sessionId}`,
    sessionId,
    agent: 'claude-code',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'turn_stop',
    status: 'unknown',
    raw: { adapter: 'test', ref: 'n/a' },
  };
}

function makeToolCall(eventId: string, target: string | undefined): NormalizedEvent {
  return {
    eventId,
    sessionId: 'session-1',
    agent: 'claude-code',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_call',
    target,
    status: 'unknown',
    raw: { adapter: 'test', ref: 'n/a' },
  };
}

/** A store whose query() returns exactly this fixed list, regardless of filter args (EventStore's own filtering is tested separately). */
function fixedQueryStore(events: NormalizedEvent[]): ReadonlyEventStore {
  return { ...fakeStore, query: () => events };
}

function makeTargetedEvent(
  eventId: string,
  target: string | undefined,
  status: NormalizedEvent['status'],
  ts: string
): NormalizedEvent {
  return {
    eventId,
    sessionId: 'session-1',
    agent: 'claude-code',
    ts,
    kind: 'edit',
    target,
    status,
    raw: { adapter: 'test', ref: 'n/a' },
  };
}

/** A store whose query() lists the given active sessions and whose cumulativeTokens() is driven by lookup tables. */
function tokenBudgetStore(
  activeSessionIds: string[],
  sessionTotals: Record<string, number>,
  dayTotal: number
): ReadonlyEventStore {
  return {
    ...fakeStore,
    query: () => activeSessionIds.map(fakeEvent),
    cumulativeTokens: (scope) => {
      if (scope.sessionId !== undefined) return totals(sessionTotals[scope.sessionId] ?? 0);
      if (scope.day !== undefined) return totals(dayTotal);
      return totals(0);
    },
  };
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

  test('token-budget: no findings when neither budget setting is configured', () => {
    const store = tokenBudgetStore(['s1'], { s1: 1000 }, 1000);
    const findings = tokenBudgetHeuristic.evaluate({ now: '2026-01-01T00:00:00.000Z', store, settings: {} });
    assert.deepStrictEqual(findings, []);
  });

  test('token-budget: only sessions over the session budget produce findings', () => {
    const store = tokenBudgetStore(['under', 'over'], { under: 50, over: 150 }, 0);
    const findings = tokenBudgetHeuristic.evaluate({
      now: '2026-01-01T00:00:00.000Z',
      store,
      settings: { session: 100 },
    });
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].summary.includes('over'));
    assert.ok(findings[0].summary.includes('150'));
  });

  test('token-budget: day total over the day budget produces a project-level finding', () => {
    const store = tokenBudgetStore([], {}, 5000);
    const findings = tokenBudgetHeuristic.evaluate({
      now: '2026-01-01T00:00:00.000Z',
      store,
      settings: { day: 4000 },
    });
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].summary.includes('5000'));
  });

  test('token-budget: both session and day can fire together, and invalid settings are ignored', () => {
    const store = tokenBudgetStore(['s1'], { s1: 200 }, 5000);
    const withBoth = tokenBudgetHeuristic.evaluate({
      now: '2026-01-01T00:00:00.000Z',
      store,
      settings: { session: 100, day: 4000 },
    });
    assert.strictEqual(withBoth.length, 2, 'both a session and a day finding should fire');

    const withInvalid = tokenBudgetHeuristic.evaluate({
      now: '2026-01-01T00:00:00.000Z',
      store,
      settings: { session: 'not-a-number', day: -5 },
    });
    assert.deepStrictEqual(withInvalid, [], 'non-numeric or non-positive settings must be treated as unset, not as a threshold of 0/NaN');
  });

  test('tool-churn: fewer calls than minCalls produces no finding', () => {
    const calls = [makeToolCall('a', 'x.ts'), makeToolCall('b', 'x.ts')];
    const findings = toolChurnHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(calls),
      settings: { minCalls: 8 },
    });
    assert.deepStrictEqual(findings, []);
  });

  test('tool-churn: enough calls but spread across too many targets produces no finding', () => {
    const calls = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => makeToolCall(id, `file-${i}.ts`));
    const findings = toolChurnHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(calls),
      settings: { minCalls: 8, maxDistinctTargets: 2 },
    });
    assert.deepStrictEqual(findings, [], 'each call hit a different file, so this is not churn against a narrow target set');
  });

  test('tool-churn: enough calls against few targets produces a warn finding referencing every call', () => {
    const calls = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => makeToolCall(id, 'x.ts'));
    const findings = toolChurnHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(calls),
      settings: { minCalls: 8, maxDistinctTargets: 2 },
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'warn');
    assert.deepStrictEqual(findings[0].eventRefs.sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  test('tool-churn: missing target values are grouped together rather than crashing', () => {
    const calls = Array.from({ length: 8 }, (_, i) => makeToolCall(`e${i}`, undefined));
    const findings = toolChurnHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(calls),
      settings: { minCalls: 8, maxDistinctTargets: 2 },
    });
    assert.strictEqual(findings.length, 1);
  });

  test('backtracking: fewer touches than minRepeats produces no finding', () => {
    const events = [
      makeTargetedEvent('a', 'x.ts', 'unknown', '2026-01-01T00:00:00.000Z'),
      makeTargetedEvent('b', 'x.ts', 'unknown', '2026-01-01T00:01:00.000Z'),
    ];
    const findings = backtrackingHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(events),
      settings: { minRepeats: 3 },
    });
    assert.deepStrictEqual(findings, []);
  });

  test('backtracking: enough touches with no intervening success produces a warn finding', () => {
    const events = [
      makeTargetedEvent('a', 'x.ts', 'unknown', '2026-01-01T00:00:00.000Z'),
      makeTargetedEvent('b', 'x.ts', 'failure', '2026-01-01T00:01:00.000Z'),
      makeTargetedEvent('c', 'x.ts', 'unknown', '2026-01-01T00:02:00.000Z'),
    ];
    const findings = backtrackingHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(events),
      settings: { minRepeats: 3 },
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'warn');
    assert.deepStrictEqual(findings[0].eventRefs, ['a', 'b', 'c']);
  });

  test('backtracking: an intervening success between the first and last touch suppresses the finding', () => {
    const events = [
      makeTargetedEvent('a', 'x.ts', 'unknown', '2026-01-01T00:00:00.000Z'),
      makeTargetedEvent('b', 'x.ts', 'success', '2026-01-01T00:01:00.000Z'), // strictly between a and c
      makeTargetedEvent('c', 'x.ts', 'unknown', '2026-01-01T00:02:00.000Z'),
    ];
    const findings = backtrackingHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(events),
      settings: { minRepeats: 3 },
    });
    assert.deepStrictEqual(findings, [], 'a success in between looks like legitimate iteration, not looping');
  });

  test('backtracking: a success only at the first or last touch does NOT suppress the finding', () => {
    const events = [
      makeTargetedEvent('a', 'x.ts', 'success', '2026-01-01T00:00:00.000Z'), // endpoint, not "in between"
      makeTargetedEvent('b', 'x.ts', 'unknown', '2026-01-01T00:01:00.000Z'),
      makeTargetedEvent('c', 'x.ts', 'success', '2026-01-01T00:02:00.000Z'), // endpoint, not "in between"
    ];
    const findings = backtrackingHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(events),
      settings: { minRepeats: 3 },
    });
    assert.strictEqual(findings.length, 1, 'success only at the endpoints must still count as looping');
  });

  test('backtracking: events without a target are ignored, and only qualifying targets are reported', () => {
    const events = [
      makeTargetedEvent('a', undefined, 'unknown', '2026-01-01T00:00:00.000Z'),
      makeTargetedEvent('b', undefined, 'unknown', '2026-01-01T00:01:00.000Z'),
      makeTargetedEvent('c', undefined, 'unknown', '2026-01-01T00:02:00.000Z'),
      makeTargetedEvent('d', 'y.ts', 'unknown', '2026-01-01T00:00:00.000Z'),
      makeTargetedEvent('e', 'y.ts', 'unknown', '2026-01-01T00:01:00.000Z'),
      makeTargetedEvent('f', 'y.ts', 'unknown', '2026-01-01T00:02:00.000Z'),
    ];
    const findings = backtrackingHeuristic.evaluate({
      now: '2026-01-01T00:05:00.000Z',
      store: fixedQueryStore(events),
      settings: { minRepeats: 3 },
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0].eventRefs, ['d', 'e', 'f']);
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
