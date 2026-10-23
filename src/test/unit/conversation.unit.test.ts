import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isUserPrompt, normalizeHookPayload, normalizeTranscriptChunk, SeenMessages, TurnTracker } from '../../adapters/claude-code/normalize';
import { readCheckpointState } from '../../adapters/claude-code/checkpointState';

// Line shapes follow real Claude Code transcripts (structure only): a prompt
// starts a turn with a promptId; assistant lines chain to it via parentUuid;
// tool results come back as `user` lines with toolUseResult.
const S = 'session-1';
const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n)).toISOString();

const prompt = (uuid: string, promptId: string, n: number, content: unknown = [{ type: 'text', text: 'please fix the test' }]) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, promptId, sessionId: S, timestamp: at(n), message: { role: 'user', content } });

const assistant = (uuid: string, parent: string, msgId: string, n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    sessionId: S,
    timestamp: at(n),
    message: { id: msgId, model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Bash' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 50 } },
    ...extra,
  });

const toolResult = (uuid: string, parent: string, n: number) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: parent, sessionId: S, timestamp: at(n), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result' }] } });

const FIXTURE = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('isUserPrompt recognizes typed prompts and nothing else', () => {
    assert.ok(isUserPrompt(JSON.parse(prompt('u1', 'p1', 0))));
    assert.ok(isUserPrompt(JSON.parse(prompt('u1', 'p1', 0, 'plain string prompt'))));
    assert.ok(!isUserPrompt(JSON.parse(toolResult('u2', 'u1', 1))), 'tool result');
    assert.ok(!isUserPrompt({ ...JSON.parse(prompt('u3', 'p1', 0)), isMeta: true }), 'meta line');
    assert.ok(!isUserPrompt({ ...JSON.parse(prompt('u4', 'p1', 0)), isCompactSummary: true }), 'compaction summary');
    assert.ok(!isUserPrompt({ ...JSON.parse(prompt('u5', 'p1', 0)), isSidechain: true, agentId: 'a1' }), "a subagent's instructions");
    assert.ok(!isUserPrompt(JSON.parse(prompt('u6', 'p1', 0, '   '))), 'blank');
  });

  test('prompts become user_prompt events with no text, and every call is attributed to its turn', () => {
    const lines = [
      prompt('u1', 'p1', 0),
      assistant('a1', 'u1', 'msg1', 1),
      toolResult('t1', 'a1', 2),
      assistant('a2', 't1', 'msg2', 3),
      prompt('u2', 'p2', 10),
      assistant('a3', 'u2', 'msg3', 11),
    ];
    const events = normalizeTranscriptChunk(lines, 'f', 0, { seen: new SeenMessages(), turns: new TurnTracker() });
    assert.deepStrictEqual(
      events.map((e) => [e.kind, e.turnId]),
      [['user_prompt', 'p1'], ['turn_stop', 'p1'], ['turn_stop', 'p1'], ['user_prompt', 'p2'], ['turn_stop', 'p2']]
    );
    const promptEvent = events[0];
    assert.strictEqual(promptEvent.textExcerpt, undefined);
    assert.strictEqual(promptEvent.target, undefined);
    assert.strictEqual(promptEvent.tokens, undefined);
    assert.strictEqual(promptEvent.eventId, 'u1');
  });

  test('a turn split across reads keeps its attribution', () => {
    const turns = new TurnTracker();
    const seen = new SeenMessages();
    normalizeTranscriptChunk([prompt('u1', 'p1', 0), assistant('a1', 'u1', 'msg1', 1)], 'f', 0, { seen, turns });
    const later = normalizeTranscriptChunk([toolResult('t1', 'a1', 2), assistant('a2', 't1', 'msg2', 3)], 'f', 100, { seen, turns });
    assert.deepStrictEqual(later.map((e) => e.turnId), ['p1']);
  });

  test("after a restart, lines with an unknown parent fall back to the file's last turn from the checkpoint", () => {
    const restored = readCheckpointState({ version: 2, offsets: { f: 500 }, recentMessageIds: {}, lastTurnByFile: { f: 'p7' } });
    const events = normalizeTranscriptChunk([assistant('a9', 'unknown-parent', 'msg9', 1)], 'f', 500, { seen: restored.seen, turns: restored.turns });
    assert.strictEqual(events[0].turnId, 'p7');
    assert.deepStrictEqual(readCheckpointState({ version: 2, offsets: {}, recentMessageIds: {} }).turns.snapshot(), {}, 'older v2 checkpoints still load');
  });

  test('subagent lines carry the spawning turn and their agent id; their opening instructions are not a prompt', () => {
    const sub = (uuid: string, parent: string | null, n: number, type: 'user' | 'assistant') =>
      type === 'user'
        ? JSON.stringify({ type, uuid, parentUuid: parent, promptId: 'p1', agentId: 'agent-x', isSidechain: true, sessionId: S, timestamp: at(n), message: { role: 'user', content: [{ type: 'text', text: 'explore the repo' }] } })
        : assistant(uuid, parent!, `sub-${uuid}`, n, { promptId: 'p1', agentId: 'agent-x', isSidechain: true });
    const events = normalizeTranscriptChunk([sub('s1', null, 0, 'user'), sub('s2', 's1', 1, 'assistant')], 'sub.jsonl', 0, { seen: new SeenMessages(), turns: new TurnTracker() });
    assert.deepStrictEqual(events.map((e) => [e.kind, e.turnId, e.agentId]), [['turn_stop', 'p1', 'agent-x']]);
  });

  test('a compact_boundary becomes a compaction event with trigger, sizes, and the model in use', () => {
    const lines = [
      prompt('u1', 'p1', 0),
      assistant('a1', 'u1', 'msg1', 1),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: 'a1', sessionId: S, timestamp: at(2), compactMetadata: { trigger: 'auto', preTokens: 987250, postTokens: 61000 } }),
    ];
    const events = normalizeTranscriptChunk(lines, 'f', 0, { seen: new SeenMessages(), turns: new TurnTracker() });
    const compaction = events.find((e) => e.kind === 'compaction')!;
    assert.deepStrictEqual(compaction.compaction, { trigger: 'auto', preTokens: 987250, postTokens: 61000 });
    assert.strictEqual(compaction.model, 'claude-opus-5-5');
    assert.strictEqual(compaction.turnId, 'p1');
    const manual = normalizeTranscriptChunk(
      [JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c2', sessionId: S, timestamp: at(3), compactMetadata: { trigger: 'manual' } })],
      'f2', 0, { seen: new SeenMessages() }
    );
    assert.strictEqual(manual[0].compaction?.trigger, 'manual');
  });

  test('hook events take prompt_id and agent_id from the payload, else the session\'s current turn', () => {
    const base = { session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} };
    const withIds = normalizeHookPayload({ ...base, prompt_id: 'p3', agent_id: 'agent-y' }, () => 'fallback');
    assert.strictEqual(withIds?.turnId, 'p3');
    assert.strictEqual(withIds?.agentId, 'agent-y');
    assert.strictEqual(normalizeHookPayload(base, () => 'p2')?.turnId, 'p2', 'older payloads without prompt_id');
    assert.strictEqual(normalizeHookPayload(base)?.turnId, undefined);

    const turns = new TurnTracker();
    normalizeTranscriptChunk([prompt('u1', 'p5', 0)], 'f', 0, { seen: new SeenMessages(), turns });
    assert.strictEqual(normalizeHookPayload(base, (sid) => turns.latestTurnForSession(sid))?.turnId, 'p5');
  });

  test('redacted real transcript: every model call is attributed to a prompt in the same file', () => {
    const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
    const events = normalizeTranscriptChunk(lines, 'fixture.jsonl', 0, { seen: new SeenMessages(), turns: new TurnTracker() });
    const prompts = new Set(events.filter((e) => e.kind === 'user_prompt').map((e) => e.turnId));
    const calls = events.filter((e) => e.kind === 'turn_stop');
    assert.ok(prompts.size > 0 && calls.length > 0);
    assert.deepStrictEqual(calls.filter((e) => !e.turnId || !prompts.has(e.turnId)), []);
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
