import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { normalizeHookPayload, normalizeTranscriptChunk, SeenMessages, todosOf } from '../../adapters/claude-code/normalize';
import { LiveToolCalls, normalizeTranscriptSession } from '../../adapters/claude-code/transcriptSession';
import { navigatorAhead, planAhead } from '../../advisor/ahead';
import { advisorBrief } from '../../advisor/brief';
import { AdvisorReport } from '../../advisor/report';
import { EventLog } from '../../core/eventLog';
import { hasCapturedText, TODO_MAX_CHARS, withoutCapturedText } from '../../core/excerpt';
import { AggregateStore, applyRetention } from '../../core/retention';

// Navigator's plan fallback (bead snagboat-79f.6.5): the agent's todo list (TodoWrite) is recorded
// on its tool call, counts always and the items' text only with capture on, and Navigator's Ahead
// line falls back to it when the workspace has no Beads.

const TODOS = [
  { content: 'Read the adapter', status: 'completed', activeForm: 'Reading the adapter' },
  { content: 'Write planAhead', status: 'in_progress', activeForm: 'Writing planAhead' },
  { content: 'Test it with token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', status: 'pending', activeForm: 'Testing it' },
  { content: 'Update the docs', status: 'pending' },
  { content: 'odd', status: 'someday' },
];

const T0 = Date.parse('2026-11-11T12:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

function ev(o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'sessionId'>): NormalizedEvent {
  return { agent: 'claude-code', ts: iso(0), kind: 'tool_call', status: 'success', raw: { adapter: 'claude-code', ref: 'r' }, ...o };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a TodoWrite list: counts always; the text (redacted) only with capture on', () => {
    const off = todosOf('TodoWrite', { todos: TODOS }, false);
    assert.deepStrictEqual(off, { pending: 2, inProgress: 1, completed: 1 }, 'an unknown status is left out; no text');
    const on = todosOf('TodoWrite', { todos: TODOS }, true)!;
    assert.deepStrictEqual([on.pending, on.inProgress, on.completed], [2, 1, 1]);
    assert.deepStrictEqual(on.items!.map((i) => i.status), ['completed', 'in_progress', 'pending', 'pending']);
    assert.strictEqual(on.items![1].text, 'Write planAhead');
    assert.strictEqual(on.items![2].text, 'Test it with token [redacted GitHub token]');
    assert.ok(!JSON.stringify(on).includes('Testing it'), 'activeForm is not kept');
    const long = todosOf('TodoWrite', { todos: [{ content: 'x'.repeat(500), status: 'pending' }] }, true)!;
    assert.strictEqual(long.items![0].text.length, TODO_MAX_CHARS);
    assert.deepStrictEqual(todosOf('TodoWrite', { todos: [] }, true), { pending: 0, inProgress: 0, completed: 0, items: [] }, 'an emptied list counts');
    assert.strictEqual(todosOf('Bash', { todos: TODOS }, true), undefined, 'only the todo tool');
    assert.strictEqual(todosOf('TodoWrite', { command: 'x' }, true), undefined, 'no list');
  });

  test('hooks, the live tailer and backfill record the same list on the tool call', () => {
    const hook = (capture: boolean) => normalizeHookPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_t', tool_name: 'TodoWrite', tool_input: { todos: TODOS } }, undefined, iso(0), capture)!;
    assert.strictEqual(hook(false).todos!.items, undefined);
    assert.strictEqual(hook(true).todos!.items!.length, 4);
    const bash = normalizeHookPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_b', tool_name: 'Bash', tool_input: { command: 'ls' } }, undefined, iso(0), true)!;
    assert.ok(!('todos' in bash));

    const use = JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 's', timestamp: iso(0), message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_t', name: 'TodoWrite', input: { todos: TODOS } }], usage: { input_tokens: 1, output_tokens: 1 } } });
    const result = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: 'a1', sessionId: 's', timestamp: iso(1), toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_t', content: 'ok' }] } });
    for (const capture of [false, true]) {
      const live = normalizeTranscriptChunk([use, result], 'f.jsonl', 0, { seen: new SeenMessages(), toolCalls: new LiveToolCalls(), captureContent: capture }).filter((e) => e.kind === 'tool_call');
      const backfill = normalizeTranscriptSession([{ file: 'f.jsonl', lines: [use, result] }], { captureContent: capture }).filter((e) => e.kind === 'tool_call');
      assert.strictEqual(live.length, 1);
      assert.deepStrictEqual(live[0].todos, hook(capture).todos, `live, capture ${capture}`);
      assert.deepStrictEqual(backfill[0].todos, hook(capture).todos, `backfill, capture ${capture}`);
      assert.strictEqual(live[0].eventId, hook(capture).eventId);
    }
  });

  test('Remove captured text and text retention take the items away and keep the counts', async () => {
    const e = normalizeHookPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_t', tool_name: 'TodoWrite', tool_input: { todos: TODOS } }, undefined, '2026-09-01T12:00:00.000Z', true)!;
    assert.ok(hasCapturedText(e));
    const stripped = withoutCapturedText(e);
    assert.deepStrictEqual(stripped.todos, { pending: 2, inProgress: 1, completed: 1 });
    assert.ok(!hasCapturedText(stripped));
    assert.strictEqual(e.todos!.items!.length, 4, 'the original is untouched');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-todo-retention-'));
    const log = new EventLog(dir);
    await log.init();
    const store = new AggregateStore(dir);
    await store.init();
    log.append(e);
    await log.flush();
    const result = await applyRetention(log, store, { rawDays: 90, aggregateDays: -1, textDays: 30 }, '2026-10-26');
    assert.deepStrictEqual(result.textRemoved, ['2026-09-01']);
    assert.deepStrictEqual((await log.readDay('2026-09-01'))[0].todos, { pending: 2, inProgress: 1, completed: 1 });
  });

  test("planAhead: the latest list of the most recent session, a live one first; text when captured, else counts", () => {
    const withText = todosOf('TodoWrite', { todos: TODOS }, true)!;
    const earlier = todosOf('TodoWrite', { todos: [{ content: 'Old plan', status: 'pending' }] }, true)!;
    const events = [
      ev({ eventId: 'a1', sessionId: 'a', ts: iso(-10), todos: earlier }),
      ev({ eventId: 'a2', sessionId: 'a', ts: iso(-5), todos: withText }),
      ev({ eventId: 'a3', sessionId: 'a', ts: iso(-2), kind: 'turn_stop', status: 'unknown' }),
      ev({ eventId: 'an', sessionId: 'a', ts: iso(-3), kind: 'session_name', status: 'unknown', sessionName: 'Plan fallback' }),
      ev({ eventId: 'old', sessionId: 'b', ts: iso(-600), todos: { pending: 0, inProgress: 0, completed: 3 } }),
    ];
    assert.deepStrictEqual(planAhead(events, T0), {
      source: 'plan', sessionId: 'a', sessionName: 'Plan fallback', live: true, text: true,
      inProgress: ['Write planAhead'], next: 'Test it with token [redacted GitHub token]', pending: 2, inProgressCount: 1, completed: 1,
    });

    // Counts only when the text wasn't captured (or was removed).
    const counts = planAhead(events.map(withoutCapturedText), T0)!;
    assert.deepStrictEqual([counts.text, counts.inProgress, counts.next, counts.pending, counts.inProgressCount, counts.completed], [false, [], undefined, 2, 1, 1]);

    // Nothing live: the most recently active. A live session wins.
    const idle = planAhead(events, T0 + 60 * 60_000)!;
    assert.deepStrictEqual([idle.sessionId, idle.live], ['a', false]);
    const later = [...events, ev({ eventId: 'b2', sessionId: 'b', ts: iso(30), kind: 'turn_stop', status: 'unknown' })];
    assert.strictEqual(planAhead(later, T0 + 31 * 60_000)!.sessionId, 'b', 'b is live, a is not');
    // An outcome is not agent activity: it doesn't make a session live.
    const outcome = [...events, ev({ eventId: 'o', sessionId: 'b', ts: iso(30), kind: 'outcome', status: 'unknown', outcome: { type: 'milestone' } })];
    assert.strictEqual(planAhead(outcome, T0 + 31 * 60_000)!.sessionId, 'a');

    assert.strictEqual(planAhead([ev({ eventId: 'x', sessionId: 'x', toolName: 'Bash' })], T0), undefined, 'no todo list anywhere');
  });

  test("Navigator's Ahead: Beads when the folder has them, else the plan, else nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-nav-ahead-'));
    const events = [ev({ eventId: 'p', sessionId: 'p', todos: { pending: 4, inProgress: 1, completed: 2 } })];
    let ran = 0;
    const bd = async () => {
      ran += 1;
      return '[]';
    };
    assert.deepStrictEqual((await navigatorAhead(dir, events, T0, bd))?.source, 'plan', 'no .beads: the plan');
    assert.strictEqual(ran, 0);
    assert.strictEqual((await navigatorAhead(undefined, events, T0, bd))?.source, 'plan', 'no folder: the plan');
    assert.strictEqual(await navigatorAhead(dir, [], T0, bd), undefined, 'neither: left out');
    fs.mkdirSync(path.join(dir, '.beads'));
    assert.strictEqual((await navigatorAhead(dir, events, T0, bd))?.source, 'beads', 'Beads first');
    assert.strictEqual((await navigatorAhead(dir, events, T0, async () => 'not json'))?.source, 'plan', 'bd failing: the plan');

    // The plan rides on the brief and never stands in for a blocked bead.
    const report: AdvisorReport = { id: 'navigator', name: 'Navigator', goal: 'g', status: 's', voice: '', version: 'v', source: 'built-in', notify: { rules: [] }, measures: [], problems: [] };
    const plan = planAhead(events, T0)!;
    const brief = advisorBrief(report, [], new Set(), plan);
    assert.strictEqual(brief.ahead, plan);
    assert.strictEqual(brief.watching, undefined);
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
