import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeTranscriptLine, normalizeHookPayload } from '../../adapters/claude-code/normalize';
import { readNewLines } from '../../core/lineTailer';
import { ensureHooksConfigured, buildHookCommand } from '../../adapters/claude-code/hooksConfig';

// Shaped after a real assistant transcript line captured from this machine's own
// ~/.claude/projects/.../*.jsonl transcript during the design of this extension.
const REAL_SHAPED_ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  uuid: 'aaaa-bbbb',
  sessionId: 'session-123',
  timestamp: '2026-09-17T10:00:00.000Z',
  message: {
    model: 'claude-sonnet-5',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 13983,
      cache_read_input_tokens: 37165,
      output_tokens: 156,
    },
  },
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('normalizeTranscriptLine maps a real-shaped assistant usage line to a turn_stop event', () => {
    const event = normalizeTranscriptLine(REAL_SHAPED_ASSISTANT_LINE, '/tmp/session.jsonl', 0);
    assert.ok(event);
    assert.strictEqual(event!.kind, 'turn_stop');
    assert.strictEqual(event!.agent, 'claude-code');
    assert.strictEqual(event!.model, 'claude-sonnet-5');
    assert.strictEqual(event!.sessionId, 'session-123');
    assert.deepStrictEqual(event!.tokens, {
      input: 2,
      output: 156,
      cacheRead: 37165,
      cacheCreation: 13983,
    });
  });

  test('normalizeTranscriptLine ignores non-assistant lines and assistant lines without usage', () => {
    assert.strictEqual(normalizeTranscriptLine(JSON.stringify({ type: 'user' }), 'f', 0), undefined);
    assert.strictEqual(
      normalizeTranscriptLine(JSON.stringify({ type: 'assistant', message: {} }), 'f', 0),
      undefined
    );
  });

  test('normalizeTranscriptLine ignores malformed JSON without throwing', () => {
    assert.strictEqual(normalizeTranscriptLine('not json{', 'f', 0), undefined);
  });

  test('readNewLines returns only complete lines and advances offset by exact bytes consumed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-tailer-'));
    const filePath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(filePath, 'line-one\nline-two\npartial-thi');

    const first = await readNewLines(filePath, 0);
    assert.deepStrictEqual(first.lines, ['line-one', 'line-two']);
    assert.strictEqual(first.newOffset, Buffer.byteLength('line-one\nline-two\n', 'utf8'));

    // Nothing new yet: the partial line hasn't been completed.
    const second = await readNewLines(filePath, first.newOffset);
    assert.deepStrictEqual(second.lines, []);
    assert.strictEqual(second.newOffset, first.newOffset);

    // Complete the partial line and append one more.
    fs.appendFileSync(filePath, 'rd\nline-four\n');
    const third = await readNewLines(filePath, first.newOffset);
    assert.deepStrictEqual(third.lines, ['partial-third', 'line-four']);
  });

  test('normalizeHookPayload maps PostToolUse to a tool_call event with derived status', () => {
    const success = normalizeHookPayload({
      session_id: 'sess-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.ts' },
      tool_response: {},
    });
    assert.ok(success);
    assert.strictEqual(success!.kind, 'tool_call');
    assert.strictEqual(success!.status, 'success');
    assert.strictEqual(success!.target, '/tmp/foo.ts');
    assert.strictEqual(success!.tokens, undefined, 'hook events must never carry tokens (transcript is the sole token source)');

    const failure = normalizeHookPayload({
      session_id: 'sess-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { error: 'exit code 1' },
    });
    assert.strictEqual(failure!.status, 'failure');
    assert.strictEqual(failure!.target, 'false');
  });

  test('normalizeHookPayload maps Stop to a turn_stop event and ignores unknown hook names', () => {
    const stop = normalizeHookPayload({ session_id: 'sess-1', hook_event_name: 'Stop' });
    assert.ok(stop);
    assert.strictEqual(stop!.kind, 'turn_stop');

    assert.strictEqual(normalizeHookPayload({ hook_event_name: 'SomethingElse' }), undefined);
    assert.strictEqual(normalizeHookPayload('not an object'), undefined);
    assert.strictEqual(normalizeHookPayload(null), undefined);
  });

  test('ensureHooksConfigured additively merges hooks without touching existing settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-hooksconfig-'));
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        someUnrelatedSetting: true,
        hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] }] },
      })
    );

    await ensureHooksConfigured(dir, 45679);
    const afterFirst = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(afterFirst.someUnrelatedSetting, true, 'unrelated settings must be preserved');
    assert.strictEqual(afterFirst.hooks.PostToolUse.length, 2, 'existing hook entry preserved, ours appended');
    assert.strictEqual(afterFirst.hooks.PostToolUse[0].hooks[0].command, 'echo existing');
    assert.ok(afterFirst.hooks.PostToolUse[1].hooks[0].command.includes(buildHookCommand(45679).split(' # ')[1]));
    assert.strictEqual(afterFirst.hooks.Stop.length, 1);

    // Calling again must be idempotent: no duplicate snagboat entries.
    await ensureHooksConfigured(dir, 45679);
    const afterSecond = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(afterSecond.hooks.PostToolUse.length, 2, 'second call must not add a duplicate entry');
  });

  test('ensureHooksConfigured creates .claude/settings.json from scratch when absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-hooksconfig-fresh-'));
    await ensureHooksConfigured(dir, 45679);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(settings.hooks.PostToolUse.length, 1);
    assert.strictEqual(settings.hooks.Stop.length, 1);
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
