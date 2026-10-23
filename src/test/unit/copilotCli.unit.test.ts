import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotCliState, normalizeCopilotCliChunk, readSessionCwd } from '../../adapters/copilot/cliSessions';
import { CopilotCliTailer, readCliCheckpoint } from '../../adapters/copilot/cliTailer';
import { contextSize } from '../../core/contextLimits';
import { AdapterContext, NormalizedEvent } from '../../core/types';

// Event shapes follow real Copilot CLI session logs (~/.copilot/session-state/<id>/events.jsonl),
// checked structure-only; values here are synthetic.
const at = (n: number) => new Date(Date.UTC(2026, 9, 22, 20, 0, n)).toISOString();
const ev = (type: string, id: string, parentId: string | null, n: number, data: Record<string, unknown> = {}) => JSON.stringify({ type, id, parentId, timestamp: at(n), data });

function session(cwd: string): string[] {
  return [
    ev('session.start', 'e0', null, 0, { sessionId: 'sess-cli-1', context: { cwd } }),
    ev('user.message', 'e1', 'e0', 1, { content: 'run the tests please', interactionId: 'I1', turnId: '0' }),
    ev('assistant.turn_start', 'e2', 'e1', 2, { turnId: '0', interactionId: 'I1' }),
    ev('session.usage_record', 'e3', 'e2', 3, { usage: { model: 'claude-sonnet-x', inputTokens: 28572, outputTokens: 114, cacheReadTokens: 15169, cacheWriteTokens: 13399, maxPromptTokens: 200000 } }),
    ev('tool.execution_start', 'e4', 'e3', 4, { toolCallId: 't1', toolName: 'bash', arguments: { command: 'npm test', description: 'Run tests' }, turnId: '0' }),
    ev('tool.execution_complete', 'e5', 'e4', 5, { toolCallId: 't1', interactionId: 'I1', success: true, shellExecution: { exitCode: 1 }, model: 'claude-sonnet-x' }),
    ev('user.message', 'e6', 'e5', 10, { content: 'now the docs', interactionId: 'I2', turnId: '1' }),
    ev('session.usage_record', 'e7', 'e6', 11, { usage: { model: 'claude-sonnet-x', inputTokens: 1000, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0, maxPromptTokens: 200000 } }),
  ];
}

function fakeCtx() {
  const published: NormalizedEvent[] = [];
  const ctx: AdapterContext = {
    publish: (e) => published.push(e),
    readCheckpoint: async () => undefined,
    writeCheckpoint: async () => undefined,
    reportHealth: () => undefined,
    captureContent: () => false,
  };
  return { ctx, published };
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => (predicate() ? resolve() : Date.now() - start > timeoutMs ? reject(new Error('waitFor: timed out')) : setTimeout(tick, 50));
    tick();
  });
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a session maps to prompts, model calls, and tool calls, each in its turn', () => {
    const events = normalizeCopilotCliChunk(session('/w/proj'), '/s/sess-cli-1/events.jsonl', 0, new CopilotCliState());
    assert.deepStrictEqual(
      events.map((e) => [e.kind, e.turnId]),
      [['user_prompt', 'I1'], ['turn_stop', 'I1'], ['tool_call', 'I1'], ['user_prompt', 'I2'], ['turn_stop', 'I2']]
    );
    assert.ok(events.every((e) => e.agent === 'copilot' && e.sessionId === 'sess-cli-1'));
    const prompt = events[0];
    assert.strictEqual(prompt.textExcerpt, undefined);
    assert.ok(!JSON.stringify(events).includes('run the tests please'), 'prompt text is never stored');
  });

  test('a reply that requests no tools ends the turn; one that requests tools does not', () => {
    const lines = [
      ...session('/w/proj').slice(0, 4),
      ev('assistant.message', 'm1', 'e3', 3, { interactionId: 'I1', toolRequests: [{ toolCallId: 't1', name: 'bash' }] }),
      ev('assistant.message', 'm2', 'e5', 6, { interactionId: 'I1', toolRequests: [] }),
    ];
    const events = normalizeCopilotCliChunk(lines, 'f', 0, new CopilotCliState());
    const ends = events.filter((e) => e.endsTurn);
    assert.deepStrictEqual(ends.map((e) => [e.kind, e.turnId, e.eventId, e.tokens]), [['turn_stop', 'I1', 'm2:end', undefined]]);
  });

  test('usage records split cached tokens out of inputTokens and carry the reported limit', () => {
    const call = normalizeCopilotCliChunk(session('/w/proj'), 'f', 0, new CopilotCliState())[1];
    assert.deepStrictEqual(call.tokens, { input: 4, output: 114, cacheRead: 15169, cacheCreation: 13399 });
    assert.strictEqual(contextSize(call), 28572, 'context size reconstructs inputTokens exactly');
    assert.strictEqual(call.contextLimit, 200000);
    assert.strictEqual(call.model, 'claude-sonnet-x');
  });

  test('tool calls take name and command from their start event; a non-zero exit is a failure', () => {
    const tool = normalizeCopilotCliChunk(session('/w/proj'), 'f', 0, new CopilotCliState())[2];
    assert.strictEqual(tool.toolName, 'bash');
    assert.strictEqual(tool.target, 'npm test');
    assert.strictEqual(tool.toolCategory, 'tests-builds');
    assert.strictEqual(tool.status, 'failure');
  });

  test("a restart resumes attribution from the checkpoint's last turn", () => {
    const { lastTurns } = readCliCheckpoint({ version: 1, offsets: { f: 10 }, lastTurnByFile: { f: 'I7' } });
    const events = normalizeCopilotCliChunk([ev('session.usage_record', 'x1', 'unknown-parent', 1, { usage: { inputTokens: 10, outputTokens: 1 } })], 'f', 10, new CopilotCliState(lastTurns.get('f')));
    assert.strictEqual(events[0].turnId, 'I7');
  });

  test('readSessionCwd finds the working directory from session.start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-'));
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, session('/w/proj').join('\n') + '\n');
    assert.strictEqual(readSessionCwd(file), '/w/proj');
    assert.strictEqual(readSessionCwd(path.join(dir, 'missing.jsonl')), undefined);
  });

  test("the tailer follows only sessions started inside this window's workspace, including new ones", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-sessions-'));
    const write = (id: string, cwd: string) => {
      fs.mkdirSync(path.join(base, id));
      fs.writeFileSync(path.join(base, id, 'events.jsonl'), session(cwd).map((l) => l.replace(/sess-cli-1/, id)).join('\n') + '\n');
    };
    write('mine', '/w/proj/sub');
    write('other', '/w/elsewhere');
    const { ctx, published } = fakeCtx();
    const tailer = new CopilotCliTailer(ctx, base, ['/w/proj'], new Map(), new Map(), () => undefined, { discoveryIntervalMs: 150, rescanIntervalMs: 200 });
    tailer.start();
    try {
      await waitFor(() => published.length === 5);
      assert.ok(published.every((e) => e.sessionId === 'mine'), 'sessions from other folders are ignored');
      write('later', '/w/proj');
      await waitFor(() => published.some((e) => e.sessionId === 'later'));
      fs.appendFileSync(path.join(base, 'later', 'events.jsonl'), ev('user.message', 'z1', null, 20, { content: 'x', interactionId: 'I9' }) + '\n');
      await waitFor(() => published.some((e) => e.turnId === 'I9'));
      const cp = tailer.checkpoint();
      assert.ok(Object.keys(cp.offsets).some((f) => f.includes('later')));
      assert.strictEqual(cp.lastTurnByFile[path.join(base, 'later', 'events.jsonl')], 'I9');
    } finally {
      tailer.stop();
    }
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
  process.exit(failures > 0 ? 1 : 0);
}

main();
