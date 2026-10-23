import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeTranscriptChunk, SeenMessages } from '../../adapters/claude-code/normalize';
import { readCheckpointState } from '../../adapters/claude-code/checkpointState';
import { expectedTotals, replayTotals } from '../../scripts/transcripts';
import { replay, sessionEvents } from '../../scripts/replayHeuristics';

// Real Claude Code writes one transcript line per content block of a response,
// all sharing message.id and each repeating the whole message's usage.
function blockLine(uuid: string, messageId: string | undefined, blocks: Array<[type: string, text?: string]>, output = 100): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: 's1',
    timestamp: '2026-10-16T12:00:00.000Z',
    message: {
      id: messageId,
      model: 'claude-sonnet-5',
      content: blocks.map(([type, text]) => (type === 'text' ? { type, text } : { type })),
      usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    },
  });
}

const SPLIT_MESSAGE = [
  blockLine('u1', 'msg_A', [['thinking']]),
  blockLine('u2', 'msg_A', [['text', 'Actually, let me try again.']]),
  blockLine('u3', 'msg_A', [['tool_use']]),
];

// Compiled to out/test/unit; the fixture stays in src (tsc doesn't copy .jsonl).
const FIXTURE = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a message split across lines becomes one event with usage counted once and all its text', () => {
    const events = normalizeTranscriptChunk(SPLIT_MESSAGE, 'f', 0, { captureContent: true, seen: new SeenMessages() });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventId, 'u1', 'identified by its first line');
    assert.deepStrictEqual(events[0].tokens, { input: 2, output: 100, cacheRead: 1000, cacheCreation: 50 });
    assert.strictEqual(events[0].textExcerpt, 'Actually, let me try again.', 'text from a non-first line is kept');
  });

  test('without capture, the merged event carries no text', () => {
    const events = normalizeTranscriptChunk(SPLIT_MESSAGE, 'f', 0, { seen: new SeenMessages() });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].textExcerpt, undefined);
  });

  test('distinct messages each count, including back-to-back ones', () => {
    const lines = [...SPLIT_MESSAGE, blockLine('u4', 'msg_B', [['text', 'Done.']], 7)];
    const events = normalizeTranscriptChunk(lines, 'f', 0, { seen: new SeenMessages() });
    assert.deepStrictEqual(events.map((e) => e.tokens?.output), [100, 7]);
  });

  test('a message straddling two reads counts once; later lines add only their text, only with capture on', () => {
    const seen = new SeenMessages();
    const first = normalizeTranscriptChunk(SPLIT_MESSAGE.slice(0, 1), 'f', 0, { captureContent: true, seen });
    const rest = normalizeTranscriptChunk(SPLIT_MESSAGE.slice(1), 'f', 1, { captureContent: true, seen });
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].tokens?.output, 100);
    assert.strictEqual(rest.length, 1, 'the text line only; the tool_use line has nothing to add');
    assert.strictEqual(rest[0].tokens, undefined);
    assert.strictEqual(rest[0].textExcerpt, 'Actually, let me try again.');

    const quietSeen = new SeenMessages();
    normalizeTranscriptChunk(SPLIT_MESSAGE.slice(0, 1), 'f', 0, { seen: quietSeen });
    assert.deepStrictEqual(normalizeTranscriptChunk(SPLIT_MESSAGE.slice(1), 'f', 1, { seen: quietSeen }), [], 'nothing to emit with capture off');
  });

  test('seen message ids are tracked per transcript file', () => {
    const seen = new SeenMessages();
    normalizeTranscriptChunk(SPLIT_MESSAGE, 'a.jsonl', 0, { seen });
    assert.strictEqual(normalizeTranscriptChunk(SPLIT_MESSAGE, 'b.jsonl', 0, { seen }).length, 1, 'same id in another file is a different message');
  });

  test('lines without a message.id fall back to counting individually', () => {
    const lines = [blockLine('u1', undefined, [['text', 'one']]), blockLine('u2', undefined, [['text', 'two']])];
    assert.strictEqual(normalizeTranscriptChunk(lines, 'f', 0, { seen: new SeenMessages() }).length, 2);
  });

  test('SeenMessages survives a checkpoint round trip and stays bounded', () => {
    const seen = new SeenMessages({}, 3);
    for (const id of ['a', 'b', 'c', 'd']) seen.add('f', id);
    const restored = new SeenMessages(JSON.parse(JSON.stringify(seen.snapshot())), 3);
    assert.ok(!restored.has('f', 'a'), 'oldest id evicted');
    assert.ok(restored.has('f', 'd'));
  });

  test('readCheckpointState reads both the legacy offsets-only shape and version 2', () => {
    const legacy = readCheckpointState({ '/t/a.jsonl': 120, '/t/b.jsonl': 40 });
    assert.deepStrictEqual([...legacy.offsets], [['/t/a.jsonl', 120], ['/t/b.jsonl', 40]]);
    assert.deepStrictEqual(legacy.seen.snapshot(), {});

    const v2 = readCheckpointState({ version: 2, offsets: { '/t/a.jsonl': 300 }, recentMessageIds: { '/t/a.jsonl': ['msg_A'] } });
    assert.deepStrictEqual([...v2.offsets], [['/t/a.jsonl', 300]]);
    assert.ok(v2.seen.has('/t/a.jsonl', 'msg_A'));
    assert.strictEqual(readCheckpointState(undefined).offsets.size, 0);
  });

  test('redacted real transcript: replay under many chunkings and restarts matches the per-message total', () => {
    const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
    const expected = expectedTotals(lines);
    assert.ok(expected.usageLines > expected.messages, 'fixture must contain split messages to be meaningful');
    for (let seed = 1; seed <= 20; seed++) {
      assert.deepStrictEqual(replayTotals(lines, 'fixture.jsonl', seed).totals, expected.totals, `seed ${seed}`);
    }
  });

  test('replay:heuristics runs the real heuristics over a redacted real transcript', () => {
    const events = sessionEvents(FIXTURE);
    assert.ok(events.some((e) => e.kind === 'user_prompt') && events.some((e) => e.kind === 'turn_stop') && events.some((e) => e.kind === 'tool_call'));
    assert.deepStrictEqual([...events].sort((a, b) => a.ts.localeCompare(b.ts)).map((e) => e.eventId), events.map((e) => e.eventId), 'time ordered');
    const episodes = replay(events, { 'token-budget': { session: 1 } });
    assert.ok(episodes.some((e) => e.heuristic === 'token-budget'), 'settings overrides reach the heuristics');
    const known = new Set(['stalled', 'token-budget', 'tool-churn', 'backtracking', 'verbal-hedge']);
    assert.deepStrictEqual(episodes.filter((e) => !known.has(e.heuristic) || e.endMin < e.startMin), []);
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
