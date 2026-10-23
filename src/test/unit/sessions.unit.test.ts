import * as assert from 'assert';
import * as path from 'path';
import { SessionIndex } from '../../core/sessions';
import { NormalizedEvent } from '../../core/types';
import { buildSessionView, callContext } from '../../ui/sessionModel';
import { sessionEvents } from '../../scripts/replayHeuristics';

const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 10, min)).toISOString();
let n = 0;
function e(partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  return { eventId: `e${n++}`, sessionId: 'S1', agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 't', ref: 'n/a' }, ...partial };
}
const call = (min: number, turnId: string | undefined, tokens: number, extra: Partial<NormalizedEvent> = {}) =>
  e({ kind: 'turn_stop', ts: at(min), turnId, model: 'opus', tokens: { input: 10, cacheRead: tokens - 10 - 5, output: 5 }, ...extra });

function sampleSession(): NormalizedEvent[] {
  return [
    e({ kind: 'user_prompt', ts: at(0), turnId: 'p1' }),
    call(1, 'p1', 1000),
    e({ kind: 'tool_call', ts: at(1), turnId: 'p1', toolCategory: 'script' }),
    e({ kind: 'tool_call', ts: at(2), turnId: 'p1', toolCategory: 'script' }),
    e({ kind: 'tool_call', ts: at(2), turnId: 'p1', toolCategory: 'file-edit' }),
    e({ kind: 'user_prompt', ts: at(3), turnId: 'p1' }), // a second message in the same turn
    call(4, 'p1', 2000),
    call(5, 'p1', 600, { agentId: 'agent-abcdef123' }),
    e({ kind: 'user_prompt', ts: at(10), turnId: 'p2' }),
    call(11, 'p2', 400),
    e({ kind: 'compaction', ts: at(12), turnId: 'p2', compaction: { trigger: 'auto', preTokens: 987_000, postTokens: 60_000 } }),
  ];
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the index summarizes sessions and counts turns, not prompt messages', () => {
    const idx = new SessionIndex();
    sampleSession().forEach((ev) => idx.ingest(ev));
    const [s] = idx.list();
    assert.strictEqual(s.prompts, 2, 'two turns, three prompt messages');
    assert.strictEqual(s.modelCalls, 4);
    assert.strictEqual(s.toolCalls, 3);
    assert.strictEqual(s.tokens, 4000);
    assert.strictEqual(s.subagents, 1);
    assert.deepStrictEqual(s.models, ['opus']);
    assert.deepStrictEqual(s.days, ['2026-10-22']);
  });

  test('editor-feature calls, file saves, and sessions without prompts or calls are left out', () => {
    const idx = new SessionIndex();
    idx.ingest(call(1, undefined, 100, { sessionId: 'inline', channel: 'inline', agent: 'copilot' }));
    idx.ingest(e({ kind: 'edit', sessionId: 'saves', agent: 'generic-fs' }));
    idx.ingest(e({ kind: 'tool_call', sessionId: 'hooks-only' }));
    idx.ingest(call(1, 'p', 100, { sessionId: 'real', model: '<synthetic>' }));
    assert.deepStrictEqual(idx.list().map((s) => [s.sessionId, s.models]), [['real', []]]);
  });

  test('sessions are listed by day and most recent first', () => {
    const idx = new SessionIndex();
    idx.ingest(call(1, 'p', 10, { sessionId: 'early' }));
    idx.ingest(call(30, 'p', 10, { sessionId: 'late' }));
    idx.ingest(call(1, 'p', 10, { sessionId: 'yesterday', ts: '2026-10-21T10:00:00.000Z' }));
    assert.deepStrictEqual(idx.forDay('2026-10-22').map((s) => s.sessionId), ['late', 'early']);
    assert.deepStrictEqual(idx.days(), ['2026-10-22', '2026-10-21']);
  });

  test('the timeline series: every call, prompts numbered by turn, compactions, subagent lanes', () => {
    const idx = new SessionIndex();
    const events = sampleSession();
    events.forEach((ev) => idx.ingest(ev));
    const view = buildSessionView(idx.list()[0], events, {});
    assert.strictEqual(view.calls.length, 4);
    assert.deepStrictEqual(view.prompts.map((p) => p.index), [1, 1, 2], 'the second message in turn 1 keeps its number');
    assert.deepStrictEqual(view.compactions, [{ ts: at(12), trigger: 'auto', preTokens: 987_000, postTokens: 60_000 }]);
    assert.deepStrictEqual(view.subagents.map((s) => [s.agentId, s.calls]), [['agent-abcdef123', 1]]);
    assert.strictEqual(callContext(view.calls[0]), 995, 'context excludes output');
  });

  test('the turn tree: tokens add up at every level, subagents split out, categories approximate', () => {
    const idx = new SessionIndex();
    const events = sampleSession();
    events.forEach((ev) => idx.ingest(ev));
    const { tree } = buildSessionView(idx.list()[0], events, {});
    assert.strictEqual(tree.tokens, 4000);
    assert.deepStrictEqual(tree.children.map((p) => [p.label, p.tokens]), [['P1', 3600], ['P2', 400]]);
    const [main, sub] = tree.children[0].children;
    assert.deepStrictEqual([main.label, main.tokens, sub.label, sub.tokens], ['main agent', 3000, 'subagent abcdef1', 600]);
    assert.deepStrictEqual(main.children.map((c) => [c.label, c.tokens, c.approximate]), [['Script', 2000, true], ['File edit', 1000, true]]);
    assert.deepStrictEqual(sub.children.map((c) => c.label), ['Replies only']);
  });

  test('calls before any prompt get their own bucket instead of disappearing', () => {
    const idx = new SessionIndex();
    const events = [call(0, undefined, 300), ...sampleSession()];
    events.forEach((ev) => idx.ingest(ev));
    const { tree } = buildSessionView(idx.list()[0], events, {});
    assert.strictEqual(tree.children[0].label, 'Before first prompt');
    assert.strictEqual(tree.tokens, idx.list()[0].tokens);
  });

  test("marks are limited to this session's models, and findings map to turns and times", () => {
    const idx = new SessionIndex();
    const events = sampleSession();
    events.forEach((ev) => idx.ingest(ev));
    const refs = events.filter((ev) => ev.kind === 'tool_call').map((ev) => ev.eventId);
    const view = buildSessionView(idx.list()[0], events, { opus: { largestSeen: 900_000 }, other: { largestSeen: 1 } }, [
      { heuristicId: 'backtracking', severity: 'warn', summary: 's', eventRefs: refs },
      { heuristicId: 'stalled', severity: 'warn', summary: 'elsewhere', eventRefs: ['not-in-this-session'] },
    ]);
    assert.deepStrictEqual(Object.keys(view.marks), ['opus']);
    assert.deepStrictEqual(view.findings.map((f) => [f.heuristicId, f.turnIds, f.fromTs, f.toTs]), [['backtracking', ['p1'], at(1), at(2)]]);
    assert.deepStrictEqual(view.tree.children[0].findings, [{ heuristicId: 'backtracking', severity: 'warn' }]);
  });

  test('redacted real transcript: tree and summary agree on tokens and turns', () => {
    const fixture = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');
    const events = sessionEvents(fixture);
    const idx = new SessionIndex();
    events.forEach((ev) => idx.ingest(ev));
    const [s] = idx.list();
    const view = buildSessionView(s, events, {});
    assert.strictEqual(view.tree.tokens, s.tokens);
    assert.strictEqual(view.tree.children.filter((p) => p.turnId).length, s.prompts);
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
