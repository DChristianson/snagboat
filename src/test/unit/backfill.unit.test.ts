import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mainTranscriptOf, normalizeTranscriptSession } from '../../adapters/claude-code/transcriptSession';
import { normalizeHookPayload } from '../../adapters/claude-code/normalize';
import { dayStats, isRetiredCopilotMetric, mergeDay, sourceFileOf } from '../../backfill/merge';
import { planBackfill, rebuildDays } from '../../backfill/rebuild';
import { EventLog } from '../../core/eventLog';
import { NormalizedEvent } from '../../core/types';

const S = 'sess-1';
const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 12, 0) + min * 60_000).toISOString();

function ev(o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind'>): NormalizedEvent {
  return { sessionId: S, agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 'claude-code', ref: '/t/main.jsonl#offset~0' }, ...o };
}

// Transcript lines shaped like Claude Code's (structure only).
const promptLine = (uuid: string, promptId: string, min: number) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, promptId, sessionId: S, timestamp: at(min), message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } });
const toolUseLine = (uuid: string, parent: string, msgId: string, toolId: string, min: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    sessionId: S,
    timestamp: at(min),
    message: { id: msgId, model: 'opus', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 5, output_tokens: 10 } },
    ...extra,
  });
const toolResultLine = (uuid: string, parent: string, toolId: string, min: number, isError = false) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: parent, sessionId: S, timestamp: at(min), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError }] } });
const endLine = (uuid: string, parent: string, msgId: string, min: number) =>
  JSON.stringify({ type: 'assistant', uuid, parentUuid: parent, sessionId: S, timestamp: at(min), message: { id: msgId, model: 'opus', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 3 } } });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('source files: transcript and Copilot log refs, not hooks, spans, or saves', () => {
    assert.strictEqual(sourceFileOf(ev({ eventId: 'a', kind: 'turn_stop' })), '/t/main.jsonl');
    assert.strictEqual(sourceFileOf(ev({ eventId: 'b', kind: 'tool_call', raw: { adapter: 'claude-code', ref: 'hook:PostToolUse:Bash' } })), undefined);
    assert.strictEqual(sourceFileOf(ev({ eventId: 'c', kind: 'turn_stop', agent: 'copilot', raw: { adapter: 'copilot-cli', ref: '/c/events.jsonl#offset~9' } })), '/c/events.jsonl');
    assert.strictEqual(sourceFileOf(ev({ eventId: 'd', kind: 'turn_stop', agent: 'copilot', raw: { adapter: 'copilot', ref: 'otlp:span:1' } })), undefined);
    assert.ok(isRetiredCopilotMetric(ev({ eventId: 'e', kind: 'turn_stop', agent: 'copilot', raw: { adapter: 'copilot', ref: 'otlp:metric:gen_ai.client.token.usage' } })));
    assert.strictEqual(mainTranscriptOf('/p/sess/subagents/agent-a.jsonl'), '/p/sess.jsonl');
    assert.strictEqual(mainTranscriptOf('/p/sess.jsonl'), '/p/sess.jsonl');
  });

  test('a session read from transcripts gets turns, turn ends, and tool calls keyed like the hook', () => {
    const events = normalizeTranscriptSession(
      [
        { file: '/p/s.jsonl', lines: [promptLine('u1', 'p1', 0), toolUseLine('a1', 'u1', 'm1', 'toolu_1', 1), toolResultLine('r1', 'a1', 'toolu_1', 2, true), endLine('a2', 'r1', 'm2', 3)] },
        { file: '/p/s/subagents/agent-x.jsonl', lines: [toolUseLine('x1', 'nope', 'mx', 'toolu_2', 1, { agentId: 'agent-x', isSidechain: true, promptId: 'p1' })] },
      ],
      { captureContent: false }
    );
    const tool = events.find((e) => e.eventId === 'tool:toolu_1')!;
    assert.deepStrictEqual([tool.kind, tool.turnId, tool.status, tool.toolCategory, tool.ts], ['tool_call', 'p1', 'failure', 'tests-builds', at(2)]);
    assert.strictEqual(sourceFileOf(tool), '/p/s.jsonl');
    assert.strictEqual(events.find((e) => e.eventId === 'tool:toolu_2')?.agentId, 'agent-x');
    assert.ok(events.some((e) => e.endsTurn && e.turnId === 'p1'));
    const hook = normalizeHookPayload({ session_id: S, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.strictEqual(hook?.eventId, 'tool:toolu_1', 'the live hook event shares the id');
  });

  test('mergeDay replaces re-read events, keeps live ones and hooks, drops retired metrics and duplicate tool calls', () => {
    const reread = new Set(['/t/main.jsonl']);
    const startedAt = at(30);
    const current = [
      ev({ eventId: 'm1', kind: 'turn_stop', ts: at(1), tokens: { input: 1 } }), // rebuilt below
      ev({ eventId: 'old-per-line', kind: 'turn_stop', ts: at(1), tokens: { input: 1 } }), // an old build's id: gone
      ev({ eventId: 'live', kind: 'turn_stop', ts: at(31), tokens: { input: 1 } }), // logged after the re-read began
      ev({ eventId: 'h1', kind: 'tool_call', ts: at(2), toolName: 'Bash', target: 'npm test', raw: { adapter: 'claude-code', ref: 'hook:PostToolUse:Bash' } }),
      ev({ eventId: 'stop', kind: 'turn_stop', ts: at(4), raw: { adapter: 'claude-code', ref: 'hook:Stop' } }),
      ev({ eventId: 'metric', kind: 'turn_stop', agent: 'copilot', tokens: { input: 9 }, raw: { adapter: 'copilot', ref: 'otlp:metric:x' } }),
      ev({ eventId: 'span', kind: 'turn_stop', ts: at(5), agent: 'copilot', channel: 'inline', tokens: { input: 2 }, raw: { adapter: 'copilot', ref: 'otlp:span:1' } }),
      ev({ eventId: 'save', kind: 'edit', ts: at(6), agent: 'generic-fs', raw: { adapter: 'generic-fs', ref: 'save' } }),
    ];
    const rebuilt = [
      ev({ eventId: 'u1', kind: 'user_prompt', ts: at(0), turnId: 'p1' }),
      ev({ eventId: 'm1', kind: 'turn_stop', ts: at(1), turnId: 'p1', tokens: { input: 1 } }),
      ev({ eventId: 'tool:a', kind: 'tool_call', ts: at(2.05), toolName: 'Bash', target: 'npm test', turnId: 'p1', raw: { adapter: 'claude-code', ref: '/t/main.jsonl#tool' } }), // = hook h1
      ev({ eventId: 'tool:b', kind: 'tool_call', ts: at(3), toolName: 'Read', target: 'a.ts', turnId: 'p1', raw: { adapter: 'claude-code', ref: '/t/main.jsonl#tool' } }),
    ];
    const merged = mergeDay(current, rebuilt, reread, startedAt);
    assert.deepStrictEqual(merged.map((e) => e.eventId), ['u1', 'm1', 'h1', 'tool:b', 'stop', 'span', 'save', 'live']);
    const byId = new Map(merged.map((e) => [e.eventId, e]));
    assert.strictEqual(byId.get('m1')?.turnId, 'p1', 'the rebuilt version wins');
    assert.deepStrictEqual([byId.get('h1')?.toolCategory, byId.get('h1')?.turnId], ['tests-builds', 'p1'], 'old hook events gain a category and a turn');
    assert.strictEqual(byId.get('stop')?.endsTurn, true, 'the Stop hook ends the turn');
  });

  test("mergeDay drops hook events logged under a Copilot session's id, which Copilot's own log covers", () => {
    const C = 'copilot-sess';
    const hook = (eventId: string, ref: string) => ev({ eventId, kind: ref === 'hook:Stop' ? 'turn_stop' : 'tool_call', sessionId: C, ts: at(2), raw: { adapter: 'claude-code', ref } });
    const current = [hook('h1', 'hook:PostToolUse:Bash'), hook('h2', 'hook:Stop'), ev({ eventId: 'claude-hook', kind: 'tool_call', ts: at(3), raw: { adapter: 'claude-code', ref: 'hook:PostToolUse:Read' } })];
    const rebuilt = [ev({ eventId: 'c1', kind: 'tool_call', sessionId: C, agent: 'copilot', ts: at(2), raw: { adapter: 'copilot-cli', ref: '/c/events.jsonl#offset~0' } })];
    assert.deepStrictEqual(mergeDay(current, rebuilt, new Set(['/c/events.jsonl']), at(30)).map((e) => e.eventId), ['c1', 'claude-hook']);
  });

  test('mergeDay leaves events from a source that could not be re-read alone', () => {
    const current = [ev({ eventId: 'm1', kind: 'turn_stop', tokens: { input: 1 } })];
    assert.deepStrictEqual(mergeDay(current, [], new Set(), at(30)), current);
  });

  test('dayStats counts linked and unlinked agent calls, tool calls, turn ends, and retired metrics', () => {
    const s = dayStats([
      ev({ eventId: 'u', kind: 'user_prompt', turnId: 'p1' }),
      ev({ eventId: 'a', kind: 'turn_stop', turnId: 'p1', tokens: { input: 10 }, endsTurn: true }),
      ev({ eventId: 'b', kind: 'turn_stop', tokens: { input: 5 } }),
      ev({ eventId: 'c', kind: 'turn_stop', channel: 'inline', agent: 'copilot', tokens: { input: 1 }, raw: { adapter: 'copilot', ref: 'otlp:span:1' } }),
      ev({ eventId: 'd', kind: 'turn_stop', agent: 'copilot', tokens: { input: 7 }, raw: { adapter: 'copilot', ref: 'otlp:metric:x' } }),
      ev({ eventId: 't', kind: 'tool_call' }),
      ev({ eventId: 'e', kind: 'edit', agent: 'generic-fs' }),
    ]);
    assert.deepStrictEqual(s, { modelCalls: 2, unlinkedCalls: 1, toolCalls: 1, turnEnds: 1, tokens: 23, retiredMetrics: 1 });
  });

  test('EventLog.rewriteDay runs after queued appends and replaces the file whole', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-rewrite-'));
    const log = new EventLog(dir);
    await log.init();
    log.append(ev({ eventId: 'a', kind: 'turn_stop', ts: at(1) }));
    let seen: string[] = [];
    const rewrite = log.rewriteDay('2026-10-20', (events) => {
      seen = events.map((e) => e.eventId);
      return [...events, ev({ eventId: 'z', kind: 'turn_stop', ts: at(9) })];
    });
    log.append(ev({ eventId: 'b', kind: 'turn_stop', ts: at(2) })); // queued after the rewrite
    await rewrite;
    await log.flush();
    assert.deepStrictEqual(seen, ['a']);
    assert.deepStrictEqual((await log.readDay('2026-10-20')).map((e) => e.eventId), ['a', 'z', 'b']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'events')), ['2026-10-20.jsonl'], 'no temp file left');
    await log.rewriteDay('2026-01-01', () => [ev({ eventId: 'x', kind: 'turn_stop' })]);
    assert.ok(!(await log.listDays()).includes('2026-01-01'), 'a day with no file is left alone');
  });

  test('rebuildDays re-reads each session once, with its subagents, files events by day, and reports missing files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-rebuild-'));
    const main = path.join(dir, 's.jsonl');
    fs.writeFileSync(main, [promptLine('u1', 'p1', 0), toolUseLine('a1', 'u1', 'm1', 'toolu_1', 1), toolResultLine('r1', 'a1', 'toolu_1', 2)].join('\n') + '\n');
    fs.mkdirSync(path.join(dir, 's', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 's', 'subagents', 'agent-x.jsonl'), toolUseLine('x1', 'nope', 'mx', 'toolu_2', 1, { agentId: 'agent-x', isSidechain: true, promptId: 'p1' }) + '\n');
    const gone = path.join(dir, 'gone.jsonl');
    const stored = new Map([
      ['2026-10-20', [ev({ eventId: 'm1', kind: 'turn_stop', raw: { adapter: 'claude-code', ref: `${main}#offset~0` } }), ev({ eventId: 'g', kind: 'turn_stop', raw: { adapter: 'claude-code', ref: `${gone}#offset~0` } })]],
    ]);
    const rebuilt = await rebuildDays(stored, { captureContent: false });
    assert.deepStrictEqual([...rebuilt.reread].sort(), [main, path.join(dir, 's', 'subagents', 'agent-x.jsonl')].sort());
    assert.deepStrictEqual(rebuilt.missing, [gone]);
    assert.deepStrictEqual(
      rebuilt.byDay.get('2026-10-20')!.map((e) => e.eventId).sort(),
      ['a1', 'tool:toolu_1', 'tool:toolu_2', 'u1', 'x1'] // model calls take their line's uuid
    );
  });

  test('planBackfill moves misfiled events to their own day, or leaves them when that day is past retention', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-plan-'));
    const main = path.join(dir, 's.jsonl');
    fs.writeFileSync(main, [promptLine('u1', 'p1', 0), toolUseLine('a1', 'u1', 'm1', 'toolu_1', 1), toolResultLine('r1', 'a1', 'toolu_1', 2)].join('\n') + '\n');
    const log = new EventLog(path.join(dir, 'storage'));
    await log.init();
    // An older build wrote 2026-10-20's events into the file of the day it caught up (2026-10-22).
    const misfiled = ev({ eventId: 'old-a1', kind: 'turn_stop', ts: at(1), tokens: { input: 5, output: 10 }, raw: { adapter: 'claude-code', ref: `${main}#offset~0` } });
    const today = ev({ eventId: 'today', kind: 'turn_stop', ts: '2026-10-22T09:00:00.000Z', tokens: { input: 1 }, raw: { adapter: 'claude-code', ref: 'other.jsonl#offset~0' } });
    await fs.promises.writeFile(path.join(dir, 'storage', 'events', '2026-10-22.jsonl'), [misfiled, today].map((e) => JSON.stringify(e)).join('\n') + '\n');
    await log.init();
    const chosen = new Map([['2026-10-22', await log.readDay('2026-10-22')]]);

    const plan = await planBackfill(log, chosen, { captureContent: false, oldestRawDay: '2026-10-01' });
    assert.deepStrictEqual(plan.days.map((d) => [d.day, d.chosen]), [['2026-10-22', true], ['2026-10-20', false]]);
    assert.deepStrictEqual(plan.merge('2026-10-22', chosen.get('2026-10-22')!).map((e) => e.eventId), ['today'], 'the misfiled event leaves');
    assert.deepStrictEqual(plan.merge('2026-10-20', []).map((e) => e.eventId), ['u1', 'a1', 'tool:toolu_1'], 'and arrives, rebuilt, on its own day');
    assert.strictEqual(plan.days[0].stats.modelCalls + plan.days[1].stats.modelCalls, plan.days[0].after.modelCalls + plan.days[1].after.modelCalls);

    const tooOld = await planBackfill(log, chosen, { captureContent: false, oldestRawDay: '2026-10-21' });
    assert.deepStrictEqual(tooOld.days.map((d) => d.day), ['2026-10-22']);
    assert.deepStrictEqual(tooOld.merge('2026-10-22', chosen.get('2026-10-22')!).map((e) => e.eventId), ['old-a1', 'today'], 'its own day only keeps totals, so it stays');
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
