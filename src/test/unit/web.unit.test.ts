import * as assert from 'assert';
import { NormalizedEvent } from '../../core/types';
import { EventSet } from '../../web/eventSet';
import { isNormalizedEvent, parseJsonl } from '../../web/jsonl';
import { buildMarks } from '../../web/marks';
import { SYNTHETIC_DAY, syntheticEvents, syntheticSessionIds } from '../../web/synthetic';

const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 10, min)).toISOString();
let n = 0;
function e(partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  return { eventId: `e${n++}`, sessionId: 'S1', agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 't', ref: 'n/a' }, ...partial };
}
const call = (model: string, context: number, min = 0, extra: Partial<NormalizedEvent> = {}) => e({ kind: 'turn_stop', ts: at(min), model, tokens: { input: 100, cacheRead: context - 200, cacheCreation: 100, output: 50 }, ...extra });
const compaction = (model: string, trigger: 'auto' | 'manual', preTokens: number, min = 0) => e({ kind: 'compaction', ts: at(min), model, compaction: { trigger, preTokens, postTokens: 40_000 } });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the synthetic sessions are the same every time', () => {
    const a = syntheticEvents();
    const b = syntheticEvents();
    assert.ok(a.length > 200, `${a.length} events`);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(new Set(a.map((x) => x.eventId)).size, a.length, 'event ids are unique');
    for (const x of a) assert.ok(isNormalizedEvent(x));
  });

  test('the index lists the synthetic sessions with prompts, calls, a compaction, and a subagent', () => {
    const set = new EventSet(syntheticEvents());
    const list = set.listAll();
    assert.deepStrictEqual(list.sessions.map((s) => s.sessionId).sort(), syntheticSessionIds().sort());
    assert.deepStrictEqual(list.headlines, {});
    for (const s of list.sessions) {
      assert.ok(s.prompts >= 5, `${s.sessionId} has ${s.prompts} prompts`);
      assert.ok(s.modelCalls > s.prompts, 'several calls per prompt');
      assert.ok(s.toolCalls > 0);
      assert.ok(s.tokens > 0);
      assert.strictEqual(s.models.length, 1);
    }
    const byId = new Map(list.sessions.map((s) => [s.sessionId, s]));
    const [long, , copilot, unnamed] = syntheticSessionIds();
    assert.strictEqual(byId.get(long)?.name, 'Explorer carousel');
    assert.strictEqual(byId.get(long)?.subagents, 3);
    assert.strictEqual(byId.get(copilot)?.agent, 'copilot');
    assert.strictEqual(byId.get(unnamed)?.name, undefined);
    const events = syntheticEvents();
    const compactions = events.filter((x) => x.kind === 'compaction');
    assert.ok(compactions.length >= 1, 'at least one compaction');
    assert.ok(compactions.every((x) => x.compaction?.trigger === 'auto' && x.compaction.preTokens! > x.compaction.postTokens!));
    assert.ok(events.some((x) => x.kind === 'user_prompt' && x.promptText && x.turnId));
    assert.ok(events.some((x) => x.kind === 'tool_call' && x.toolCategory && x.agentId), 'a subagent made tool calls');
    // Idle gaps: at least one prompt follows the previous event by more than half an hour.
    const bySession = new Map<string, NormalizedEvent[]>();
    for (const x of events) bySession.set(x.sessionId, [...(bySession.get(x.sessionId) ?? []), x]);
    const gaps = [...bySession.values()].flatMap((list) => list.map((x, i) => (i > 0 && x.kind === 'user_prompt' ? Date.parse(x.ts) - Date.parse(list[i - 1].ts) : 0)));
    assert.ok(Math.max(...gaps) > 30 * 60_000, 'an idle gap');
  });

  test('the JSONL parser keeps valid lines, skips bad ones, and counts duplicates', () => {
    const good = e({ kind: 'tool_call' });
    const text = [JSON.stringify(good), '', 'not json {', JSON.stringify({ eventId: 'x' }), JSON.stringify([1, 2]), 'null', JSON.stringify(good), JSON.stringify({ ...good, eventId: 'other' })].join('\n');
    const parsed = parseJsonl(text);
    assert.deepStrictEqual(parsed.events.map((x) => x.eventId), [good.eventId, 'other']);
    assert.strictEqual(parsed.skipped, 4);
    assert.strictEqual(parsed.duplicates, 1);
    // Ids carry across files.
    const seen = new Set<string>();
    assert.strictEqual(parseJsonl(JSON.stringify(good), seen).events.length, 1);
    assert.strictEqual(parseJsonl(JSON.stringify(good), seen).duplicates, 1);
    // Windows line endings are fine.
    assert.strictEqual(parseJsonl(`${JSON.stringify(good)}\r\n${JSON.stringify({ ...good, eventId: 'b' })}\r\n`).events.length, 2);
  });

  test('an event needs its five identifying strings', () => {
    const good = e({ kind: 'turn_stop' });
    assert.ok(isNormalizedEvent(good));
    for (const key of ['eventId', 'sessionId', 'agent', 'kind', 'ts']) {
      assert.ok(!isNormalizedEvent({ ...good, [key]: undefined }), `${key} missing`);
      assert.ok(!isNormalizedEvent({ ...good, [key]: 5 }), `${key} not a string`);
      assert.ok(!isNormalizedEvent({ ...good, [key]: '' }), `${key} empty`);
    }
    assert.ok(!isNormalizedEvent(null) && !isNormalizedEvent('x') && !isNormalizedEvent([good]));
  });

  test('marks: the largest context always, a limit only from an auto compaction or a reported limit', () => {
    const marks = buildMarks([call('opus', 400_000), call('opus', 964_050, 1), call('opus', 700_000, 2), compaction('opus', 'manual', 300_000, 3), call('sonnet', 100_000, 4), call('<synthetic>', 5_000)]);
    assert.deepStrictEqual(marks.opus, { largestSeen: 964_050, largestSeenAt: at(1) });
    assert.deepStrictEqual(marks.sonnet, { largestSeen: 100_000, largestSeenAt: at(4) });
    assert.ok(!('<synthetic>' in marks));
    const withLimit = buildMarks([call('opus', 400_000), compaction('opus', 'auto', 987_250, 1), compaction('opus', 'auto', 950_000, 2), compaction('opus', 'auto', 990_000, 3)]);
    assert.deepStrictEqual(withLimit.opus, { largestSeen: 400_000, largestSeenAt: at(0), limit: 950_000, limitAt: at(2), limitSource: 'auto-compaction' });
    const reported = buildMarks([call('gpt', 50_000, 0, { contextLimit: 128_000 }), call('gpt', 60_000, 1, { contextLimit: 200_000 })]);
    assert.deepStrictEqual(reported.gpt, { largestSeen: 60_000, largestSeenAt: at(1), limit: 128_000, limitAt: at(0), limitSource: 'reported' });
    assert.deepStrictEqual(buildMarks([]), {});
  });

  test('explorer state over loaded events: views in picked order, a replayed finding, unknown ids named', () => {
    const set = new EventSet(syntheticEvents());
    const [long, short, copilot] = syntheticSessionIds();
    const state = set.explorerState([short, long, 'nope', short]);
    assert.deepStrictEqual(state.sessions.map((v) => v.summary.sessionId), [short, long]);
    assert.deepStrictEqual(state.notLoaded, ['nope']);
    assert.ok(state.catalog.length >= 2 && Object.keys(state.taxonomy).length === 5);
    const view = state.sessions[1];
    assert.ok(view.findings.length >= 1, 'the long session trips a built-in heuristic on replay');
    assert.ok(view.findings.some((f) => f.heuristicId === 'tool-churn'), view.findings.map((f) => f.heuristicId).join());
    assert.ok(view.findings.every((f) => !f.active && f.turnIds.length > 0 && f.startedTs));
    assert.ok(view.tree.children.some((p) => p.findings?.length), 'the tree carries the badge');
    assert.ok(view.compactions.length >= 1 && view.subagents.length === 3 && view.prompts.length === 14);
    const model = view.summary.models[0];
    assert.strictEqual(view.marks[model].limitSource, 'auto-compaction');
    assert.ok(view.marks[model].largestSeen! > 0);
    assert.strictEqual(set.view(copilot)!.marks['gpt-5.2'].limitSource, 'reported');
    assert.strictEqual(set.view('nope'), undefined);
    assert.strictEqual(set.view(long), view, 'built once');
    // The cap applies.
    assert.strictEqual(set.explorerState(Array.from({ length: 12 }, (_, i) => `s${i}`)).notLoaded.length, 8);
  });

  test('loaded events replace the examples: a list from what was read', () => {
    const events = [e({ kind: 'user_prompt', turnId: 'p1', ts: at(0) }), call('opus', 50_000, 1, { turnId: 'p1', endsTurn: true })];
    const set = new EventSet(parseJsonl(events.map((x) => JSON.stringify(x)).join('\n')).events);
    const list = set.listAll();
    assert.strictEqual(list.sessions.length, 1);
    assert.strictEqual(set.explorerState(['S1']).sessions[0].calls.length, 1);
    assert.deepStrictEqual(new EventSet([]).listAll(), { sessions: [], headlines: {} });
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
