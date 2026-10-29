import * as assert from 'assert';
import { nudgeLine } from '../../advisor/nudge';
import { EventStore } from '../../core/eventStore';
import { NormalizedEvent } from '../../core/types';
import { contextPressureHeuristic } from '../../heuristics/contextPressure';
import { parseRule } from '../../heuristics/rule';
import { ruleHeuristic } from '../../heuristics/ruleHeuristic';
import { runawayTurnHeuristic } from '../../heuristics/runawayTurn';
import { Finding, Progress } from '../../heuristics/types';
import { Nudger, NudgeSettings } from '../../nudges/nudger';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();
let seq = 0;
function ev(turnId: string, min: number, overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  seq += 1;
  return { eventId: `e${seq}`, sessionId: 's1', turnId, agent: 'claude-code', ts: at(min), status: 'success', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}
function store(events: NormalizedEvent[]): EventStore {
  const s = new EventStore({ windowMs: 24 * 60 * 60_000, maxEvents: 10_000 });
  for (const e of events) s.ingest(e);
  return s;
}

const finding = (heuristicId: string, severity: 'info' | 'warn', ref: string): Finding => ({ heuristicId, severity, summary: `${heuristicId} fired`, eventRefs: [ref], detectedAt: at(0) });
const progress = (heuristicId: string, ref: string): Progress => ({ heuristicId, share: 0.85, summary: `Heading for ${heuristicId}`, eventRefs: [ref] });
/** Refs name their turn: "s1/t1/x" is in session s1, turn t1. */
const locate = (refs: string[]) => {
  const [sessionId, turnId] = refs[0].split('/');
  return { sessionId, ...(turnId ? { turnId } : {}) };
};
const on = (notify: NudgeSettings['notify'] = 'warnings', extra: Partial<NudgeSettings> = {}): NudgeSettings => ({ notify, quiet: [], muted: [], ...extra });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a warning nudges once per episode; infos only when all are on', () => {
    const n = new Nudger(locate);
    const active = new Map([['backtracking', [finding('backtracking', 'warn', 's1/t1/a')]], ['verbal-hedge', [finding('verbal-hedge', 'info', 's1/t2/b')]]]);
    assert.deepStrictEqual(n.update(active, [], on()).map((x) => [x.heuristicId, x.sessionId, x.turnId]), [['backtracking', 's1', 't1']]);
    assert.deepStrictEqual(n.update(active, [], on()), [], 'still the same episode');
    n.update(new Map(), [], on());
    assert.strictEqual(n.update(new Map([['backtracking', [finding('backtracking', 'warn', 's1/t3/c')]]]), [], on()).length, 1, 'a new episode in a new turn');
    assert.deepStrictEqual(new Nudger(locate).update(active, [], on('all')).map((x) => x.heuristicId), ['backtracking', 'verbal-hedge']);
  });

  test('off, quiet, and muted never notify, and an episode already under way when notifications turn on stays quiet', () => {
    const active = new Map([['backtracking', [finding('backtracking', 'warn', 's1/t1/a')]]]);
    assert.deepStrictEqual(new Nudger(locate).update(active, [progress('runaway-turn', 's1/t9/x')], on('off')), []);
    assert.deepStrictEqual(new Nudger(locate).update(active, [], on('all', { quiet: ['backtracking'] })), []);
    assert.deepStrictEqual(new Nudger(locate).update(active, [], on('all', { muted: ['backtracking'] })), []);
    const n = new Nudger(locate);
    n.update(active, [], on('off'));
    assert.deepStrictEqual(n.update(active, [], on()), []);
  });

  test('one nudge per turn, whatever fires, and one early warning per heuristic and turn', () => {
    const n = new Nudger(locate);
    const first = n.update(new Map([['backtracking', [finding('backtracking', 'warn', 's1/t1/a')]]]), [progress('runaway-turn', 's1/t1/p')], on());
    assert.deepStrictEqual(first.map((x) => [x.heuristicId, x.early]), [['backtracking', false]]);
    assert.deepStrictEqual(n.update(new Map([['backtracking', [finding('backtracking', 'warn', 's1/t1/a')]], ['stalled', [finding('stalled', 'warn', 's1/t1/b')]]]), [], on()), [], 'the turn has had its nudge');
    const early = n.update(new Map(), [progress('runaway-turn', 's1/t2/p')], on());
    assert.deepStrictEqual(early.map((x) => [x.heuristicId, x.early, x.severity]), [['runaway-turn', true, 'info']]);
    assert.deepStrictEqual(n.update(new Map(), [progress('runaway-turn', 's1/t2/p')], on()), []);
    assert.deepStrictEqual(n.update(new Map([['runaway-turn', [finding('runaway-turn', 'warn', 's1/t5/x')]]]), [progress('runaway-turn', 's1/t6/p')], on()).map((x) => x.early), [false], 'no early warning for a heuristic already firing');
  });

  test('runaway-turn warns early at 80% of its threshold, in an open turn, and not once it fires', () => {
    const events = [ev('t1', 0, { kind: 'user_prompt' })];
    for (let i = 0; i < 8; i++) events.push(ev('t1', 1, { kind: 'turn_stop', model: 'm', tokens: { input: 1, output: 1 } }));
    const ctx = (settings: Record<string, unknown>, list = events) => ({ now: at(2), store: store(list), settings: { maxModelCalls: 10, maxToolCalls: 10, ...settings } });
    assert.deepStrictEqual(runawayTurnHeuristic.progress!(ctx({})).map((p) => [p.share, p.summary]), [[0.8, 'Heading for a runaway turn: 8 of 10 model calls']]);
    assert.deepStrictEqual(runawayTurnHeuristic.progress!(ctx({ earlyWarning: 0 })), [], '0 turns it off');
    assert.deepStrictEqual(runawayTurnHeuristic.progress!(ctx({ earlyWarning: 0.9 })), []);
    const ended = [...events, ev('t1', 3, { kind: 'turn_stop', endsTurn: true })];
    assert.deepStrictEqual(runawayTurnHeuristic.progress!(ctx({}, ended)), [], 'a finished turn is past warning');
    const fired = [...events, ev('t1', 2, { kind: 'turn_stop', model: 'm', tokens: { input: 1, output: 1 } }), ev('t1', 2, { kind: 'turn_stop', model: 'm', tokens: { input: 1, output: 1 } })];
    assert.deepStrictEqual(runawayTurnHeuristic.progress!(ctx({}, fired)), []);
  });

  test('context-pressure warns early as the context nears its threshold', () => {
    const events = [ev('t1', 0, { kind: 'user_prompt' }), ev('t1', 1, { kind: 'turn_stop', model: 'm', tokens: { input: 7500, output: 1 }, contextLimit: 10000 })];
    const [p] = contextPressureHeuristic.progress!({ now: at(2), store: store(events), settings: { percent: 90 } });
    assert.strictEqual(p.summary, 'Heading for compaction: context is at 75% of the limit');
    assert.deepStrictEqual(contextPressureHeuristic.progress!({ now: at(2), store: store(events), settings: { percent: 90, earlyWarning: 0.9 } }), []);
  });

  test('a rule with earlyWarning reports progress toward its gte thresholds, and validates the share', () => {
    const doc = { id: 'user:reads', title: 'Many reads', scope: 'turn', measure: { type: 'count', filter: { kind: 'tool_call' } }, when: { gte: 10 }, severity: 'info', summary: '{value} reads', earlyWarning: 0.7 };
    const events = [ev('t1', 0, { kind: 'user_prompt' }), ...Array.from({ length: 8 }, () => ev('t1', 1, { kind: 'tool_call', toolName: 'Read', target: 'a.ts' }))];
    const h = ruleHeuristic(parseRule(doc).value!);
    assert.deepStrictEqual(h.progress!({ now: at(2), store: store(events), settings: {} }).map((p) => [p.share, p.summary]), [[0.8, 'Heading for "Many reads": 8 reads']]);
    assert.strictEqual(ruleHeuristic(parseRule({ ...doc, earlyWarning: undefined }).value!).progress, undefined);
    assert.ok(parseRule({ ...doc, earlyWarning: 1.5 }).errors[0].includes('between 0 and 1'));
    const both = { ...doc, measures: { a: { type: 'count' }, b: { type: 'count', filter: { kind: 'tool_call' } } }, measure: undefined, when: { all: [{ measure: 'a', gte: 10 }, { measure: 'b', gte: 100 }] }, summary: '{a}' };
    assert.deepStrictEqual(ruleHeuristic(parseRule(both).value!).progress!({ now: at(2), store: store(events), settings: {} }), [], 'all: the furthest-off condition decides');
  });

  test('the advisor\'s answer becomes one line, or nothing when it had nothing specific', () => {
    assert.strictEqual(nudgeLine('  "Ask the agent to run the failing test alone."\n'), 'Ask the agent to run the failing test alone.');
    assert.strictEqual(nudgeLine('Nothing specific.'), undefined);
    assert.strictEqual(nudgeLine('x'.repeat(300))!.length, 240);
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
