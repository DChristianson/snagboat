import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { normalizeHookPayload, normalizeTranscriptChunk, SeenMessages, taskOpOf, todosOf } from '../../adapters/claude-code/normalize';
import { LiveToolCalls, normalizeTranscriptSession } from '../../adapters/claude-code/transcriptSession';
import { navigatorAhead, planAhead, replayTasks } from '../../advisor/ahead';
import { advisorBrief } from '../../advisor/brief';
import { AdvisorReport } from '../../advisor/report';
import { EventLog } from '../../core/eventLog';
import { hasCapturedText, TODO_MAX_CHARS, withoutCapturedText } from '../../core/excerpt';
import { AggregateStore, applyRetention } from '../../core/retention';

// Navigator's plan fallback (bead snagboat-79f.6.5): the agent's todo list (TodoWrite) is recorded
// on its tool call, counts always and the items' text only with capture on, and Navigator's Ahead
// line falls back to it when the workspace has no Beads. Newer Claude Code keeps the plan with task
// tools instead (bead snagboat-79f.6.9): each call records its change (taskOp) and the plan is
// what replaying a session's changes leaves.

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

  // A task tool call as a hook reports it (PostToolUse, with its tool_response).
  const taskHook = (id: string, tool: string, input: unknown, response: unknown, capture: boolean, ts = iso(0), session = 's') =>
    normalizeHookPayload({ session_id: session, hook_event_name: 'PostToolUse', tool_use_id: id, tool_name: tool, tool_input: input, tool_response: response }, undefined, ts, capture)!;

  test('task tools: each call records its change; subjects (redacted) only with capture on', () => {
    const created = { task: { id: '1', subject: 'Write it' } };
    assert.deepStrictEqual(taskOpOf('TaskCreate', { subject: 'Write it', description: 'all of it', activeForm: 'Writing it' }, created, true), { op: 'create', id: '1', subject: 'Write it' });
    assert.deepStrictEqual(taskOpOf('TaskCreate', { subject: 'Write it', description: 'all of it' }, created, false), { op: 'create', id: '1' }, 'no subject with capture off');
    assert.deepStrictEqual(taskOpOf('TaskCreate', { subject: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' }, { task: { id: 7 } }, true), { op: 'create', id: '7', subject: 'Use [redacted GitHub token]' }, 'a numeric id; redacted');
    assert.deepStrictEqual(taskOpOf('TaskCreate', { subject: 'x' }, JSON.stringify(created), false), { op: 'create', id: '1' }, 'output as a JSON string');
    assert.deepStrictEqual(taskOpOf('TaskCreate', { subject: 'x' }, [{ type: 'text', text: 'Task #3 created successfully: x' }], false), { op: 'create', id: '3' }, "the result's text");
    assert.strictEqual(taskOpOf('TaskCreate', { subject: 'x' }, { ok: true }, true), undefined, 'no id: skipped');
    assert.strictEqual(taskOpOf('TaskCreate', { subject: 'x' }, undefined, true), undefined);
    assert.strictEqual(taskOpOf('TaskCreate', { subject: 'x' }, created, true, true), undefined, 'a failed call');

    assert.deepStrictEqual(taskOpOf('TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Writing it', owner: 'me' }, { success: true, taskId: '1', updatedFields: ['status'] }, true), { op: 'update', id: '1', status: 'in_progress' });
    assert.deepStrictEqual(taskOpOf('TaskUpdate', { id: '1', status: 'completed' }, undefined, false), { op: 'update', id: '1', status: 'completed' }, 'id for taskId');
    assert.deepStrictEqual(taskOpOf('TaskUpdate', { task_id: 2, status: 'deleted' }, {}, false), { op: 'update', id: '2', status: 'deleted' }, 'task_id for taskId; deleted');
    assert.deepStrictEqual(taskOpOf('TaskUpdate', { status: 'completed' }, { success: true, taskId: '4' }, false), { op: 'update', id: '4', status: 'completed' }, "the output's taskId");
    assert.deepStrictEqual(taskOpOf('TaskUpdate', { taskId: '1', subject: 'Write all of it' }, {}, true), { op: 'update', id: '1', subject: 'Write all of it' });
    assert.strictEqual(taskOpOf('TaskUpdate', { taskId: '1', subject: 'Write all of it' }, {}, false), undefined, 'a subject alone, capture off: nothing to record');
    assert.strictEqual(taskOpOf('TaskUpdate', { taskId: '1', status: 'someday', owner: 'me' }, {}, true), undefined, 'an unknown status');
    assert.strictEqual(taskOpOf('TaskUpdate', { status: 'completed' }, {}, true), undefined, 'no id');
    assert.strictEqual(taskOpOf('TaskUpdate', { taskId: '1', status: 'completed' }, { success: false }, true), undefined, 'not done');

    const listed = { tasks: [{ id: '1', subject: 'Write it', status: 'completed', blockedBy: [] }, { id: '2', subject: 'Test it', status: 'pending', owner: 'a', blockedBy: ['1'] }, { id: '3', status: 'odd' }, { id: '4', status: 'constructor' }, { subject: 'no id', status: 'pending' }] };
    assert.deepStrictEqual(taskOpOf('TaskList', {}, listed, true), { op: 'list', tasks: [{ id: '1', status: 'completed', subject: 'Write it' }, { id: '2', status: 'pending', subject: 'Test it' }] });
    assert.deepStrictEqual(taskOpOf('TaskList', {}, listed, false), { op: 'list', tasks: [{ id: '1', status: 'completed' }, { id: '2', status: 'pending' }] });
    assert.deepStrictEqual(taskOpOf('TaskList', {}, { tasks: [] }, false), { op: 'list', tasks: [] }, 'an empty list');
    assert.strictEqual(taskOpOf('TaskList', {}, 'No tasks found', false), undefined, 'no list: skipped');
    assert.strictEqual(taskOpOf('TaskGet', { taskId: '1' }, { task: { id: '1', status: 'pending' } }, true), undefined, 'TaskGet is ignored');
    assert.strictEqual(taskOpOf('TodoWrite', { todos: TODOS }, {}, true), undefined);

    // Hooks: from PostToolUse's tool_input and tool_response; a failed call records none.
    assert.deepStrictEqual(taskHook('toolu_c', 'TaskCreate', { subject: 'Write it', description: 'd' }, created, true).taskOp, { op: 'create', id: '1', subject: 'Write it' });
    const failed = normalizeHookPayload({ session_id: 's', hook_event_name: 'PostToolUseFailure', tool_use_id: 'toolu_f', tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' }, error: 'no such task' }, undefined, iso(0), true)!;
    assert.ok(failed && !('taskOp' in failed));
    assert.ok(!('taskOp' in taskHook('toolu_b', 'Bash', { command: 'ls' }, { stdout: '' }, true)));
  });

  test('task tools: hooks, the live tailer and backfill record the same change, the new id from the result', () => {
    const lines = (tool: string, id: string, input: unknown, result: unknown, minute: number, extra: object = {}) => [
      JSON.stringify({ type: 'assistant', uuid: `a-${id}`, sessionId: 's', timestamp: iso(minute), message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: tool, input }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: 'user', uuid: `u-${id}`, parentUuid: `a-${id}`, sessionId: 's', timestamp: iso(minute + 1), toolUseResult: result, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Task #1 created successfully: Write it', ...extra }] } }),
    ];
    const calls: Array<[string, string, unknown, unknown]> = [
      ['TaskCreate', 'toolu_c', { subject: 'Write it', description: 'd' }, { task: { id: '1', subject: 'Write it' } }],
      ['TaskUpdate', 'toolu_u', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } }],
      ['TaskList', 'toolu_l', {}, { tasks: [{ id: '1', subject: 'Write it', status: 'completed', blockedBy: [] }] }],
    ];
    for (const capture of [false, true]) {
      calls.forEach(([tool, id, input, result], i) => {
        const raw = lines(tool, id, input, result, i * 2);
        const hook = taskHook(id, tool, input, result, capture);
        const live = normalizeTranscriptChunk(raw, 'f.jsonl', 0, { seen: new SeenMessages(), toolCalls: new LiveToolCalls(), captureContent: capture }).filter((e) => e.kind === 'tool_call');
        const backfill = normalizeTranscriptSession([{ file: 'f.jsonl', lines: raw }], { captureContent: capture }).filter((e) => e.kind === 'tool_call');
        assert.ok(hook.taskOp, `${tool} from the hook`);
        assert.deepStrictEqual(live[0].taskOp, hook.taskOp, `${tool}: live, capture ${capture}`);
        assert.deepStrictEqual(backfill[0].taskOp, hook.taskOp, `${tool}: backfill, capture ${capture}`);
      });
    }
    // An errored result records nothing.
    const errored = lines('TaskUpdate', 'toolu_e', { taskId: '9', status: 'completed' }, 'Error: no task 9', 0, { is_error: true });
    assert.ok(!normalizeTranscriptSession([{ file: 'f.jsonl', lines: errored }], { captureContent: true }).some((e) => e.taskOp));
    // Two results on one line: toolUseResult can't be told apart, so each block's own text is read.
    const two = [
      JSON.stringify({ type: 'assistant', uuid: 'a2', sessionId: 's', timestamp: iso(0), message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_x', name: 'TaskCreate', input: { subject: 'A' } }, { type: 'tool_use', id: 'toolu_y', name: 'TaskCreate', input: { subject: 'B' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: 'user', uuid: 'u2', sessionId: 's', timestamp: iso(1), toolUseResult: { task: { id: '5' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'Task #5 created successfully: A' }, { type: 'tool_result', tool_use_id: 'toolu_y', content: [{ type: 'text', text: 'Task #6 created successfully: B' }] }] } }),
    ];
    const both = normalizeTranscriptSession([{ file: 'f.jsonl', lines: two }], { captureContent: true }).filter((e) => e.taskOp);
    assert.deepStrictEqual(both.map((e) => e.taskOp), [{ op: 'create', id: '5', subject: 'A' }, { op: 'create', id: '6', subject: 'B' }]);
  });

  test('task tools: the plan is what replaying the changes leaves (create, update, complete, delete, list)', () => {
    const create = (n: number, subject: string) => taskHook(`c${n}`, 'TaskCreate', { subject, description: 'd' }, { task: { id: String(n), subject } }, true, iso(n));
    const update = (n: number, minute: number, input: object) => taskHook(`u${minute}`, 'TaskUpdate', input, { success: true }, true, iso(minute));
    const events = [
      create(1, 'Read the adapter'),
      create(2, 'Write the replay'),
      create(3, 'Test it'),
      create(4, 'Gold-plate it'),
      update(1, 5, { taskId: '1', status: 'in_progress' }),
      update(1, 6, { taskId: '1', status: 'completed' }),
      update(2, 7, { id: '2', status: 'in_progress', active_form: 'Writing the replay' }),
      update(4, 8, { task_id: '4', status: 'deleted' }),
      update(3, 9, { taskId: '3', subject: 'Test it all' }),
    ];
    assert.deepStrictEqual(planAhead(events, T0 + 10 * 60_000), {
      source: 'plan', sessionId: 's', live: true, text: true,
      inProgress: ['Write the replay'], next: 'Test it all', pending: 1, inProgressCount: 1, completed: 1,
    });
    // The log's order doesn't matter: changes are replayed by time.
    assert.deepStrictEqual(planAhead([...events].reverse(), T0 + 10 * 60_000), planAhead(events, T0 + 10 * 60_000));

    // Capture off: counts only.
    const off = planAhead(events.map(withoutCapturedText), T0 + 10 * 60_000)!;
    assert.deepStrictEqual([off.text, off.inProgress, off.next, off.pending, off.inProgressCount, off.completed], [false, [], undefined, 1, 1, 1]);
    assert.ok(events.some(hasCapturedText) && !events.map(withoutCapturedText).some(hasCapturedText));
    assert.deepStrictEqual(withoutCapturedText(events[0]).taskOp, { op: 'create', id: '1' }, "the id stays");

    // TaskList is the whole list: it replaces what came before.
    const listed = taskHook('l', 'TaskList', {}, { tasks: [{ id: '2', subject: 'Write the replay', status: 'completed', blockedBy: [] }, { id: '5', subject: 'Ship it', status: 'pending', blockedBy: [] }] }, true, iso(11));
    const synced = planAhead([...events, listed], T0 + 12 * 60_000)!;
    assert.deepStrictEqual([synced.inProgress, synced.next, synced.pending, synced.inProgressCount, synced.completed], [[], 'Ship it', 1, 0, 1]);
    const strippedList = withoutCapturedText(listed);
    assert.deepStrictEqual(strippedList.taskOp, { op: 'list', tasks: [{ id: '2', status: 'completed' }, { id: '5', status: 'pending' }] });

    // An update for a task whose create wasn't recorded adds it; a create's lost id leaves it out.
    assert.deepStrictEqual(replayTasks([{ op: 'update', id: '9', status: 'in_progress' }, { op: 'update', id: '9', subject: 'Found it' }]), { pending: 0, inProgress: 1, completed: 0, items: [{ text: 'Found it', status: 'in_progress' }] });
    assert.deepStrictEqual(replayTasks([{ op: 'create', id: '1' }, { op: 'update', id: '1', status: 'deleted' }]), { pending: 0, inProgress: 0, completed: 0 }, 'all deleted: empty');
  });

  test('a session with both TodoWrite and task tools: whichever it used last', () => {
    const todo = (minute: number) => ev({ eventId: `t${minute}`, sessionId: 's', ts: iso(minute), toolName: 'TodoWrite', todos: todosOf('TodoWrite', { todos: [{ content: 'From TodoWrite', status: 'pending' }] }, true)! });
    const created = taskHook('c', 'TaskCreate', { subject: 'From tasks' }, { task: { id: '1' } }, true, iso(2));
    const done = taskHook('u', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true }, true, iso(4));
    assert.deepStrictEqual(planAhead([todo(1), created, done], T0 + 5 * 60_000)!.inProgress, ['From tasks'], 'tasks last');
    assert.strictEqual(planAhead([todo(1), created, done, todo(5)], T0 + 6 * 60_000)!.next, 'From TodoWrite', 'TodoWrite last');
    const later = taskHook('u2', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true }, true, iso(7));
    const back = planAhead([todo(1), created, done, todo(5), later], T0 + 8 * 60_000)!;
    assert.deepStrictEqual([back.completed, back.pending, back.next], [1, 0, undefined], 'back to tasks: the replay keeps every change');
    // A session with only task tools is a plan too, and the most recent live session still wins.
    const other = taskHook('o', 'TaskCreate', { subject: 'Elsewhere' }, { task: { id: '1' } }, true, iso(-120), 'old');
    assert.strictEqual(planAhead([other, created], T0 + 3 * 60_000)!.sessionId, 's');
    assert.strictEqual(planAhead([other], T0)!.next, 'Elsewhere');
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
