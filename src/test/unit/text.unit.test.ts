import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeTranscriptChunk, SeenMessages, TurnTracker } from '../../adapters/claude-code/normalize';
import { copilotSessionNameEvent, CopilotCliState, normalizeCopilotCliChunk, readSessionName } from '../../adapters/copilot/cliSessions';
import { Aggregate } from '../../core/aggregate';
import { EventLog } from '../../core/eventLog';
import { makeExcerpt, makePromptText, PROMPT_MAX_CHARS, redactSecrets, withoutCapturedText } from '../../core/excerpt';
import { AggregateStore, applyRetention, EventSink, RetentionPolicy } from '../../core/retention';
import { SessionIndex } from '../../core/sessions';
import { NormalizedEvent } from '../../core/types';
import { buildDetailState } from '../../ui/detailModel';

const S = 'sess-1';
const at = (day: string, min = 0) => new Date(Date.parse(`${day}T12:00:00.000Z`) + min * 60_000).toISOString();

function ev(o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind'>): NormalizedEvent {
  return { sessionId: S, agent: 'claude-code', ts: at('2026-10-20'), status: 'unknown', raw: { adapter: 'claude-code', ref: '/t.jsonl#offset~0' }, ...o };
}

// Claude Code transcript lines (structure only).
const promptLine = (uuid: string, content: unknown, ts = at('2026-10-20')) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, promptId: `p-${uuid}`, sessionId: S, timestamp: ts, message: { role: 'user', content } });
const titleLine = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: S });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('redaction replaces common secret formats and leaves ordinary text alone', () => {
    const cases: Array<[string, string]> = [
      ['key AKIAABCDEFGHIJKLMNOP here', 'key [redacted AWS key] here'],
      [`token ghp_${'a'.repeat(36)}`, 'token [redacted GitHub token]'],
      [`github_pat_${'A1'.repeat(15)}`, '[redacted GitHub token]'],
      [`sk-ant-api03-${'x'.repeat(30)}`, '[redacted Anthropic key]'],
      [`OPENAI=sk-proj-${'y'.repeat(30)}`, 'OPENAI=[redacted API key]'],
      [`xoxb-${'1'.repeat(12)}-abc`, '[redacted Slack token]'],
      [`AIza${'B'.repeat(35)}`, '[redacted Google API key]'],
      ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'Authorization: Bearer [redacted]'],
      ['postgres://admin:hunter2secret@db.local/app', 'postgres://admin:[redacted]@db.local/app'],
      ['password = "correct-horse-42"', 'password = "[redacted]"'],
      ['API_KEY=a1b2c3d4e5f6', 'API_KEY=[redacted]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', '[redacted private key]'],
    ];
    for (const [input, expected] of cases) assert.strictEqual(redactSecrets(input), expected, input);
    const ordinary = 'Fix the token parser in src/auth.ts; the password field is optional. Run npm test.';
    assert.strictEqual(redactSecrets(ordinary), ordinary);
    // Code that only looks like key=value (the false positives seen in real replies).
    for (const code of ['token=$(gh auth token)', 'token: string', 'const token = parseToken(x)', 'secret = `${prefix}...`']) assert.strictEqual(redactSecrets(code), code, code);
    assert.strictEqual(makeExcerpt([`use sk-ant-${'z'.repeat(30)}`]), 'use [redacted Anthropic key]', 'replies are redacted too');
  });

  test('prompt text is capped at 2,000 characters with a note of what was cut', () => {
    assert.strictEqual(makePromptText(['  short prompt ']), 'short prompt');
    assert.strictEqual(makePromptText(['', '   ']), undefined);
    const long = makePromptText(['x'.repeat(PROMPT_MAX_CHARS + 48_055)])!;
    assert.ok(long.startsWith('x'.repeat(PROMPT_MAX_CHARS)));
    assert.ok(long.endsWith('… (+48,055 characters)'), long.slice(-30));
  });

  test("Claude Code prompts keep your words, not injected context; nothing is captured with capture off", () => {
    const lines = [
      promptLine('u1', [
        { type: 'text', text: '<ide_opened_file>The user opened src/a.ts</ide_opened_file>' },
        { type: 'text', text: '<ide_selection>const secret = 1;</ide_selection>' },
        { type: 'text', text: 'fix the failing test' },
      ]),
      promptLine('u2', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>'),
      promptLine('u3', [{ type: 'text', text: '<task-notification>task done</task-notification>' }]),
    ];
    const on = normalizeTranscriptChunk(lines, '/t.jsonl', 0, { captureContent: true, seen: new SeenMessages(), turns: new TurnTracker() });
    assert.deepStrictEqual(on.map((e) => e.promptText), ['fix the failing test', '/compact keep the plan', undefined]);
    const off = normalizeTranscriptChunk(lines, '/t.jsonl', 0, { captureContent: false, seen: new SeenMessages(), turns: new TurnTracker() });
    assert.ok(off.every((e) => e.promptText === undefined));
  });

  test('Claude Code session titles: one event per change, a stable id, and none with capture off', () => {
    const turns = new TurnTracker();
    const lines = [promptLine('u1', 'hi', at('2026-10-20', 5)), titleLine('Fix login bug'), titleLine('Fix login bug'), titleLine('Fix login and signup bugs')];
    const events = normalizeTranscriptChunk(lines, '/t.jsonl', 0, { captureContent: true, seen: new SeenMessages(), turns }).filter((e) => e.kind === 'session_name');
    assert.deepStrictEqual(events.map((e) => [e.sessionName, e.ts]), [['Fix login bug', at('2026-10-20', 5)], ['Fix login and signup bugs', at('2026-10-20', 5)]]);
    const again = normalizeTranscriptChunk([titleLine('Fix login bug')], '/t.jsonl', 0, { captureContent: true, seen: new SeenMessages(), turns: new TurnTracker() });
    assert.strictEqual(again[0].eventId, events[0].eventId, 'a restart re-reads the title under the same id');
    const off = normalizeTranscriptChunk(lines, '/t.jsonl', 0, { captureContent: false, seen: new SeenMessages(), turns: new TurnTracker() });
    assert.ok(!off.some((e) => e.kind === 'session_name'));
  });

  test("Copilot prompts carry their text, and the session's name comes from workspace.yaml", () => {
    const line = JSON.stringify({ type: 'user.message', id: 'm1', parentId: null, timestamp: at('2026-10-20'), data: { content: 'run the tests please', interactionId: 'I1' } });
    const [prompt] = normalizeCopilotCliChunk([line], '/s/x/events.jsonl', 0, new CopilotCliState(), { captureContent: true });
    assert.strictEqual(prompt.promptText, 'run the tests please');
    const [bare] = normalizeCopilotCliChunk([line], '/s/x/events.jsonl', 0, new CopilotCliState());
    assert.strictEqual(bare.promptText, undefined);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-copilot-name-'));
    const file = path.join(dir, 'events.jsonl');
    assert.strictEqual(readSessionName(file), undefined, 'no workspace.yaml');
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'id: abc\ncwd: /w/proj\nname: "Refactor the parser"\nuser_named: true\nupdated_at: 2026-10-20T13:00:00.000Z\n');
    assert.deepStrictEqual(readSessionName(file), { name: 'Refactor the parser', userNamed: true, updatedAt: '2026-10-20T13:00:00.000Z' });
    const named = copilotSessionNameEvent('abc', 'Refactor the parser', file, '2026-10-20T13:00:00.000Z');
    assert.deepStrictEqual([named.kind, named.sessionName, named.ts], ['session_name', 'Refactor the parser', '2026-10-20T13:00:00.000Z']);
  });

  test('the session index takes the latest name, and a name alone lists no session; totals ignore names', () => {
    const idx = new SessionIndex();
    idx.ingest(ev({ eventId: 'n2', kind: 'session_name', sessionName: 'Newer', ts: at('2026-10-20', 9) }));
    idx.ingest(ev({ eventId: 'n1', kind: 'session_name', sessionName: 'Older', ts: at('2026-10-20', 1) }));
    assert.deepStrictEqual(idx.list(), [], 'no prompts or calls yet');
    idx.ingest(ev({ eventId: 'c', kind: 'turn_stop', tokens: { input: 5 } }));
    assert.strictEqual(idx.get(S)?.name, 'Newer');
    idx.reset();
    idx.ingest(ev({ eventId: 'c', kind: 'turn_stop', tokens: { input: 5 } }));
    assert.strictEqual(idx.get(S)?.name, undefined, 'reset forgets names');

    const agg = new Aggregate();
    agg.apply(ev({ eventId: 'n', kind: 'session_name', sessionName: 'x' }));
    assert.deepStrictEqual(agg.snapshot().perAgent, {});
  });

  test('text retention strips text from older raw days, keeping their events; the sink never stores expired text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-text-retention-'));
    const log = new EventLog(dir);
    await log.init();
    const store = new AggregateStore(dir);
    await store.init();
    const policy: RetentionPolicy = { rawDays: 90, aggregateDays: -1, textDays: 30 };
    const old = ev({ eventId: 'old', kind: 'user_prompt', ts: at('2026-09-01'), promptText: 'old prompt', textExcerpt: 'old reply' });
    const recent = ev({ eventId: 'new', kind: 'user_prompt', ts: at('2026-10-20'), promptText: 'new prompt' });
    log.append(old);
    log.append(recent);
    await log.flush();

    const result = await applyRetention(log, store, policy, '2026-10-26');
    assert.deepStrictEqual(result.textRemoved, ['2026-09-01']);
    assert.deepStrictEqual(await log.readDay('2026-09-01'), [withoutCapturedText(old)], 'the event stays, without its text');
    assert.strictEqual((await log.readDay('2026-10-20'))[0].promptText, 'new prompt');
    assert.deepStrictEqual((await applyRetention(log, store, policy, '2026-10-26')).textRemoved, [], 'nothing left to strip');

    const sink = new EventSink(log, store, () => policy, () => '2026-10-26', (op) => void op());
    assert.ok(sink.write(ev({ eventId: 'late', kind: 'user_prompt', ts: at('2026-09-02'), promptText: 'caught up late' })));
    await log.flush();
    assert.strictEqual((await log.readDay('2026-09-02'))[0].promptText, undefined);
  });

  test('the Overview leaves session-name events out and shows names and prompt text on events', () => {
    const state = buildDetailState({
      now: at('2026-10-20', 10),
      capture: { enabled: true, retentionDays: 30 },
      today: new Aggregate().snapshot(),
      recentEvents: [ev({ eventId: 'p', kind: 'user_prompt', promptText: 'do it' }), ev({ eventId: 'n', kind: 'session_name', sessionName: 'Named' })],
      findings: [],
      muted: [],
      daily: [],
      isOpenable: () => false,
      sessionName: (id) => (id === S ? 'Named' : undefined),
    });
    assert.deepStrictEqual(state.timeline.events.map((e) => [e.id, e.promptText, e.sessionName]), [['p', 'do it', 'Named']]);
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
