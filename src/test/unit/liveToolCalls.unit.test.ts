import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { normalizeHookPayload, normalizeTranscriptChunk, SeenMessages, TurnTracker } from '../../adapters/claude-code/normalize';
import { LiveToolCalls, normalizeTranscriptSession } from '../../adapters/claude-code/transcriptSession';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { EventLog } from '../../core/eventLog';
import { CoreService } from '../../core/service/server';
import { workspaceStoreDir } from '../../core/userStore';

// Tool calls from live transcripts (bead snagboat-79f.5.4): the tailer builds them as backfill does,
// with the hooks' ids, so projects without hooks get tool calls (and so tests_green and git outcomes).

const FIXTURE = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');

const pick = (e: NormalizedEvent) => [e.eventId, e.ts, e.status, e.toolName, e.toolCategory, e.target, e.turnId, e.agentId ?? null];

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('tailed a line at a time, a real transcript gives the same tool calls backfill rebuilds', () => {
    const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
    const backfill = normalizeTranscriptSession([{ file: FIXTURE, lines }], { captureContent: false }).filter((e) => e.kind === 'tool_call');
    assert.ok(backfill.length > 0, 'the fixture has tool calls');
    const seen = new SeenMessages();
    const turns = new TurnTracker();
    const toolCalls = new LiveToolCalls();
    const live: NormalizedEvent[] = [];
    let offset = 0;
    for (const line of lines) {
      live.push(...normalizeTranscriptChunk([line], FIXTURE, offset, { seen, turns, toolCalls }).filter((e) => e.kind === 'tool_call'));
      offset += line.length + 1;
    }
    // Backfill also counts a call whose result never came (status unknown); live waits for the result.
    const answered = backfill.filter((e) => e.status !== 'unknown');
    assert.deepStrictEqual(live.map(pick).sort(), answered.map(pick).sort());
  });

  test("a hook and the transcript report one call with one id; a failed call is a failure either way", () => {
    const toolCalls = new LiveToolCalls();
    const at = '2026-11-11T10:00:00.000Z';
    toolCalls.observe({ type: 'assistant', sessionId: 's', timestamp: at, message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'npm test', description: 'a long description not kept' } }] } }, 'f', 't1');
    const [fromTranscript] = toolCalls.observe({ type: 'user', sessionId: 's', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'Exit code 1' }] } }, 'f', 't1');
    const fromHook = normalizeHookPayload({ session_id: 's', hook_event_name: 'PostToolUseFailure', tool_use_id: 'toolu_9', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' });
    assert.strictEqual(fromTranscript.eventId, fromHook!.eventId);
    assert.deepStrictEqual([fromTranscript.status, fromTranscript.toolCategory, fromTranscript.target], [fromHook!.status, fromHook!.toolCategory, fromHook!.target]);
    assert.deepStrictEqual(toolCalls.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown' }] } }, 'f', undefined), [], 'a result with no tool_use seen: nothing');
  });

  test('the core records tool calls for a project without hooks, and so tests going green', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-livetools-')));
    const home = path.join(root, '.snagboat');
    const projects = path.join(root, 'projects');
    const project = path.join(root, 'app');
    fs.mkdirSync(project);
    const dir = path.join(projects, sanitizeCwd(project));
    fs.mkdirSync(dir, { recursive: true });
    const t = (min: number) => new Date(Date.now() - 60 * 60_000 + min * 60_000).toISOString();
    const line = (o: object) => JSON.stringify({ sessionId: 'lt', cwd: project, ...o });
    const run = (id: string, min: number, failed: boolean) => [
      line({ type: 'assistant', uuid: `a-${id}`, timestamp: t(min), message: { id: `m-${id}`, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      line({ type: 'user', uuid: `u-${id}`, timestamp: t(min + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? 'Exit code 1' : 'ok' }] } }),
    ];
    fs.writeFileSync(path.join(dir, 'lt.jsonl'), [line({ type: 'user', uuid: 'p', timestamp: t(0), promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] } }), ...run('toolu_a', 1, true), ...run('toolu_b', 5, false)].join('\n') + '\n');
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, claudeProjectsDir: projects, copilotSessionsDir: path.join(root, 'none') });
    try {
      const read = () => new EventLog(workspaceStoreDir(home, project)).readAll();
      await waitFor(async () => (await read()).some((e) => e.kind === 'outcome'));
      const events = await read();
      assert.deepStrictEqual(events.filter((e) => e.kind === 'tool_call').map((e) => [e.eventId, e.status]), [['tool:toolu_a', 'failure'], ['tool:toolu_b', 'success']]);
      assert.deepStrictEqual(events.filter((e) => e.kind === 'outcome').map((e) => e.outcome?.refs), [['tool:toolu_a', 'tool:toolu_b']]);
    } finally {
      await core.stop();
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
