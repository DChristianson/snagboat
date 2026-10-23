import * as assert from 'assert';
import { HeuristicsEngine } from '../../heuristics/engine';
import { FindingsRegistry } from '../../heuristics/findingsRegistry';
import { stalledHeuristic } from '../../heuristics/stalled';
import { tokenBudgetHeuristic } from '../../heuristics/tokenBudget';
import { toolChurnHeuristic } from '../../heuristics/toolChurn';
import { backtrackingHeuristic } from '../../heuristics/backtracking';
import { runawayTurnHeuristic } from '../../heuristics/runawayTurn';
import { contextPressureHeuristic } from '../../heuristics/contextPressure';
import { cacheThrashHeuristic } from '../../heuristics/cacheThrash';
import { Heuristic, Finding, HeuristicContext } from '../../heuristics/types';
import { ReadonlyEventStore, TokenTotals } from '../../core/eventStore';
import { NormalizedEvent } from '../../core/types';

const fakeStore: ReadonlyEventStore = {
  query: () => [],
  lastN: () => [],
  latestTs: () => undefined,
  cumulativeTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
};

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

/** A store whose query() returns exactly this fixed list, regardless of filter args (EventStore's own filtering is tested separately). */
function fixedQueryStore(events: NormalizedEvent[]): ReadonlyEventStore {
  return { ...fakeStore, query: () => events };
}

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();

function ev(overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind'>): NormalizedEvent {
  return { sessionId: 'session-1', agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}
const prompt = (turnId: string, min: number, eventId = `prompt-${turnId}`) => ev({ eventId, kind: 'user_prompt', ts: at(min), turnId });
const call = (eventId: string, min: number, extra: Partial<NormalizedEvent> = {}) =>
  ev({ eventId, kind: 'turn_stop', ts: at(min), model: 'm', tokens: { input: 10, cacheRead: 1000, output: 5 }, ...extra });
const tool = (eventId: string, min: number, target: string | undefined, extra: Partial<NormalizedEvent> = {}) =>
  ev({ eventId, kind: 'tool_call', ts: at(min), target, ...extra });

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

  test('stalled: an open turn quiet past the threshold fires; a finished turn never does', () => {
    const open = [prompt('p', 0), call('c1', 1, { turnId: 'p' })];
    const [finding] = stalledHeuristic.evaluate({ now: at(21), store: fixedQueryStore(open), settings: {} });
    assert.strictEqual(finding?.severity, 'warn');
    assert.ok(finding.summary.includes('20 minutes'), finding.summary);
    assert.deepStrictEqual(finding.eventRefs, ['prompt-p']);

    const finished = [...open, call('c2', 2, { turnId: 'p', endsTurn: true })];
    assert.deepStrictEqual(stalledHeuristic.evaluate({ now: at(60), store: fixedQueryStore(finished), settings: {} }), [], 'you being away is not a stall');
  });

  test('stalled: respects minutes and maxMinutes, and ignores events with no prompt', () => {
    const open = [prompt('p', 0), call('c1', 1, { turnId: 'p' })];
    assert.deepStrictEqual(stalledHeuristic.evaluate({ now: at(10), store: fixedQueryStore(open), settings: {} }), [], 'under the default 15');
    assert.strictEqual(stalledHeuristic.evaluate({ now: at(5), store: fixedQueryStore(open), settings: { minutes: 3 } }).length, 1);
    assert.deepStrictEqual(stalledHeuristic.evaluate({ now: at(200), store: fixedQueryStore(open), settings: {} }), [], 'past maxMinutes the turn is abandoned');
    assert.deepStrictEqual(stalledHeuristic.evaluate({ now: at(30), store: fixedQueryStore([call('c1', 1)]), settings: {} }), []);
  });

  test("stalled: skips sessions that never recorded a turn end across several turns (logged before ends were kept)", () => {
    const legacy = [prompt('p', 0), call('c1', 1, { turnId: 'p' }), prompt('q', 5), call('c2', 6, { turnId: 'q' })];
    assert.deepStrictEqual(stalledHeuristic.evaluate({ now: at(30), store: fixedQueryStore(legacy), settings: {} }), []);
    const recorded = [prompt('p', 0), call('c1', 1, { turnId: 'p', endsTurn: true }), prompt('q', 5), call('c2', 6, { turnId: 'q' })];
    assert.strictEqual(stalledHeuristic.evaluate({ now: at(30), store: fixedQueryStore(recorded), settings: {} }).length, 1);
  });

  test('stalled: a later prompt message in the same turn reopens it', () => {
    const events = [prompt('p', 0), call('c1', 1, { turnId: 'p', endsTurn: true }), prompt('p', 2, 'prompt-p2'), call('c2', 3, { turnId: 'p' })];
    assert.strictEqual(stalledHeuristic.evaluate({ now: at(30), store: fixedQueryStore(events), settings: {} }).length, 1);
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

  test('runaway-turn: fires once the current turn passes either cap, and clears on the next prompt', () => {
    const turn = [prompt('p', 0), ...Array.from({ length: 5 }, (_, i) => call(`c${i}`, 1, { turnId: 'p' }))];
    assert.deepStrictEqual(runawayTurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(turn), settings: { maxModelCalls: 6 } }), []);
    const [finding] = runawayTurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(turn), settings: { maxModelCalls: 5 } });
    assert.ok(finding.summary.includes('5 model calls'), finding.summary);
    assert.strictEqual(finding.eventRefs[0], 'prompt-p');
    const tools = [prompt('p', 0), ...Array.from({ length: 3 }, (_, i) => tool(`t${i}`, 1, 'a.ts', { turnId: 'p' }))];
    assert.strictEqual(runawayTurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(tools), settings: { maxToolCalls: 3 } }).length, 1);
    assert.deepStrictEqual(runawayTurnHeuristic.evaluate({ now: at(3), store: fixedQueryStore([...turn, prompt('q', 3)]), settings: { maxModelCalls: 5 } }), []);
  });

  test('context-pressure: info near the limit (reported or learned), warn on an auto-compaction', () => {
    const near = [prompt('p', 0), call('c1', 1, { turnId: 'p', model: 'm', tokens: { input: 10, cacheRead: 920_000 } })];
    assert.deepStrictEqual(contextPressureHeuristic.evaluate({ now: at(2), store: fixedQueryStore(near), settings: {} }), [], 'no limit known yet');
    const [info] = contextPressureHeuristic.evaluate({ now: at(2), store: fixedQueryStore(near), settings: {}, contextLimit: (m) => (m === 'm' ? 1_000_000 : undefined) });
    assert.strictEqual(info.severity, 'info');
    assert.ok(info.summary.includes('92%'), info.summary);
    const reported = [prompt('p', 0), call('c1', 1, { turnId: 'p', tokens: { input: 85 }, contextLimit: 100 })];
    assert.strictEqual(contextPressureHeuristic.evaluate({ now: at(2), store: fixedQueryStore(reported), settings: { percent: 80 } }).length, 1);
    const subagentOnly = [prompt('p', 0), call('c1', 1, { turnId: 'p', agentId: 'a', tokens: { input: 99 }, contextLimit: 100 })];
    assert.deepStrictEqual(contextPressureHeuristic.evaluate({ now: at(2), store: fixedQueryStore(subagentOnly), settings: {} }), [], 'subagents have their own context');

    const compacted = [...near, ev({ eventId: 'k', kind: 'compaction', ts: at(2), turnId: 'p', compaction: { trigger: 'auto', preTokens: 987_250, postTokens: 60_000 } })];
    const [warn] = contextPressureHeuristic.evaluate({ now: at(3), store: fixedQueryStore(compacted), settings: {} });
    assert.strictEqual(warn.severity, 'warn');
    assert.ok(warn.summary.includes('987K to 60K'), warn.summary);
    const manual = [prompt('p', 0), ev({ eventId: 'k', kind: 'compaction', ts: at(2), turnId: 'p', compaction: { trigger: 'manual' } })];
    assert.deepStrictEqual(contextPressureHeuristic.evaluate({ now: at(3), store: fixedQueryStore(manual), settings: {} }), [], 'a /compact you ran is not a warning');
  });

  test('cache-thrash: repeated cache rewrites in one turn fire; expiry and compaction rebuilds do not count', () => {
    const rebuild = (id: string, min: number) => call(id, min, { turnId: 'p', tokens: { input: 5, cacheRead: 1_000, cacheCreation: 80_000 } });
    const thrash = [prompt('p', 0), call('c0', 1, { turnId: 'p' }), rebuild('r1', 2), rebuild('r2', 3)];
    const [finding] = cacheThrashHeuristic.evaluate({ now: at(4), store: fixedQueryStore(thrash), settings: {} });
    assert.deepStrictEqual(finding.eventRefs, ['prompt-p', 'r1', 'r2']);
    const afterPause = [prompt('p', 0), call('c0', 1, { turnId: 'p' }), rebuild('r1', 2), rebuild('r2', 10)];
    assert.deepStrictEqual(cacheThrashHeuristic.evaluate({ now: at(11), store: fixedQueryStore(afterPause), settings: {} }), [], 'r2 follows an 8-minute pause: the cache expired');
    const afterCompaction = [...thrash.slice(0, 3), ev({ eventId: 'k', kind: 'compaction', ts: at(2.5), turnId: 'p', compaction: { trigger: 'auto' } }), rebuild('r2', 3)];
    assert.deepStrictEqual(cacheThrashHeuristic.evaluate({ now: at(4), store: fixedQueryStore(afterCompaction), settings: {} }), []);
  });

  test('backtracking: repeated failures or edits on one target within the turn, successes in between included', () => {
    const fails = [prompt('p', 0), tool('a', 1, 'npm test', { turnId: 'p', status: 'failure' }), tool('b', 2, 'npm test', { turnId: 'p', status: 'success' }), tool('c', 3, 'npm test', { turnId: 'p', status: 'failure' })];
    assert.deepStrictEqual(backtrackingHeuristic.evaluate({ now: at(4), store: fixedQueryStore(fails), settings: {} }), [], 'two failures');
    const third = [...fails, tool('d', 4, 'npm test', { turnId: 'p', status: 'failure' })];
    const [finding] = backtrackingHeuristic.evaluate({ now: at(5), store: fixedQueryStore(third), settings: {} });
    assert.deepStrictEqual(finding.eventRefs, ['a', 'c', 'd']);
    assert.ok(finding.summary.includes('failed 3 times'), finding.summary);

    const edits = [prompt('p', 0), ...Array.from({ length: 4 }, (_, i) => tool(`e${i}`, 1 + i, 'x.ts', { turnId: 'p', status: 'success', toolCategory: 'file-edit' }))];
    assert.strictEqual(backtrackingHeuristic.evaluate({ now: at(6), store: fixedQueryStore(edits), settings: { minEdits: 4 } }).length, 1);
    assert.deepStrictEqual(backtrackingHeuristic.evaluate({ now: at(7), store: fixedQueryStore([...third, prompt('q', 6)]), settings: {} }), [], 'a new prompt starts over');
  });

  test('tool-churn: per session, fires when two targets take most of a busy window, ignoring calls without targets', () => {
    const churn = Array.from({ length: 8 }, (_, i) => tool(`a${i}`, 1, i < 7 ? 'x.ts' : 'y.ts'));
    const [finding] = toolChurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(churn), settings: {} });
    assert.ok(finding.summary.includes('8 of 8'), finding.summary);
    const spread = Array.from({ length: 8 }, (_, i) => tool(`b${i}`, 1, i < 6 ? 'x.ts' : `f${i}.ts`));
    assert.deepStrictEqual(toolChurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(spread), settings: {} }), [], 'top two take 7 of 8, under 90%');
    assert.strictEqual(toolChurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(spread), settings: { minShare: 0.85 } }).length, 1);
    const twoSessions = [...churn.slice(0, 4), ...churn.slice(4).map((e) => ({ ...e, sessionId: 'other' }))];
    assert.deepStrictEqual(toolChurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(twoSessions), settings: {} }), [], 'each session has only 4 calls');
    const untargeted = Array.from({ length: 8 }, (_, i) => tool(`d${i}`, 1, undefined));
    assert.deepStrictEqual(toolChurnHeuristic.evaluate({ now: at(2), store: fixedQueryStore(untargeted), settings: {} }), []);
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
