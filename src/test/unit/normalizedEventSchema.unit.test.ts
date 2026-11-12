import * as assert from 'assert';
import * as path from 'path';
import { EventOutcome, NormalizedEvent, NormalizedEventKind, normalizedEventSchema, normalizedEventSchemaV1, normalizedEventSchemaV2, TOOL_CATEGORY_LABELS } from '@snagboat/schema';
import { sessionEvents } from '../../scripts/replayHeuristics';
import { syntheticEvents } from '@snagboat/viz/web';
import { normalizeHookPayload } from '../../adapters/claude-code/normalize';

// The JSON Schema in @snagboat/schema (normalizedEvent.v3.schema.json) must describe the
// events Snagboat actually writes. A compile-time check in jsonSchema.ts keeps its field
// list equal to NormalizedEvent's; this test checks the values: enums against the
// TypeScript unions, and real events (the Claude Code fixture, the web demo's
// synthetic sessions) against the schema.

type Schema = Record<string, any>;

/** Validates the subset of JSON Schema the event schema uses; returns the problems found. */
function validate(schema: Schema, value: unknown, at = '$'): string[] {
  const problems: string[] = [];
  if (schema.const !== undefined && value !== schema.const) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))) problems.push(`${at}: does not match ${schema.pattern}`);
  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== schema.type) problems.push(`${at}: expected ${schema.type}, got ${actual}`);
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => problems.push(...validate(schema.items, v, `${at}[${i}]`)));
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => validate(s, value, at).length === 0)) problems.push(`${at}: matches none of anyOf`);
  if (schema.type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${at}.${key}: required`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) problems.push(...validate(sub, v, `${at}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key}: not in schema`);
    }
  }
  return problems;
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const schema = normalizedEventSchema as Schema;
  const props = schema.properties;

  test('enums match the TypeScript unions', () => {
    // A Record over the union is exhaustive at compile time, so these key lists are complete.
    const kinds: Record<NormalizedEventKind, true> = {
      tool_call: true, edit: true, turn_start: true, turn_stop: true, user_prompt: true, compaction: true, session_name: true, outcome: true,
    };
    const outcomeTypes: Record<EventOutcome['type'], true> = { tests_green: true, finding_response: true, commit_kept: true, commit_reverted: true, code_survival: true, milestone: true, approval: true, notified: true };
    const responses: Record<NonNullable<EventOutcome['response']>, true> = { useful: true, muted: true, acknowledged: true, passed: true };
    const decisions: Record<NonNullable<EventOutcome['decision']>, true> = { asked: true, denied: true };
    const statuses: Record<NormalizedEvent['status'], true> = { success: true, failure: true, unknown: true };
    const triggers: Record<NonNullable<NormalizedEvent['compaction']>['trigger'], true> = { auto: true, manual: true, unknown: true };
    const sorted = (xs: string[]) => [...xs].sort();
    assert.deepStrictEqual(sorted(props.kind.enum), sorted(Object.keys(kinds)));
    assert.deepStrictEqual(sorted(props.status.enum), sorted(Object.keys(statuses)));
    assert.deepStrictEqual(sorted(props.compaction.properties.trigger.enum), sorted(Object.keys(triggers)));
    assert.deepStrictEqual(sorted(props.toolCategory.anyOf[0].enum), sorted(Object.keys(TOOL_CATEGORY_LABELS)));
    assert.deepStrictEqual(sorted(props.outcome.properties.type.enum), sorted(Object.keys(outcomeTypes)));
    assert.deepStrictEqual(sorted(props.outcome.properties.response.enum), sorted(Object.keys(responses)));
    assert.deepStrictEqual(sorted(props.outcome.properties.decision.enum), sorted(Object.keys(decisions)));
    // The compile-time check covers the event's fields; this covers the outcome's.
    const outcomeFields: Record<keyof EventOutcome, true> = { type: true, refs: true, failures: true, afterMs: true, heuristicId: true, response: true, commit: true, files: true, linesWritten: true, linesSurviving: true, days: true, decision: true, advisor: true };
    assert.deepStrictEqual(sorted(Object.keys(props.outcome.properties)), sorted(Object.keys(outcomeFields)));
  });

  test('the validator rejects what the schema forbids', () => {
    const ok = { eventId: 'e', sessionId: 's', agent: 'claude-code', ts: '2026-11-09T00:00:00Z', kind: 'edit', status: 'success', raw: { adapter: 'a', ref: 'r' } };
    assert.deepStrictEqual(validate(schema, ok), []);
    assert.ok(validate(schema, { ...ok, kind: 'nap' }).length > 0);
    assert.ok(validate(schema, { ...ok, agent: 'cursor' }).length > 0);
    assert.ok(validate(schema, { ...ok, agent: 'custom:cursor' }).length === 0);
    assert.ok(validate(schema, { ...ok, extra: 1 }).length > 0);
    assert.ok(validate(schema, { ...ok, toolCategory: 'acme:shell/deploy' }).length === 0);
    const { raw: _raw, ...noRaw } = ok;
    assert.ok(validate(schema, noRaw).length > 0);
  });

  test('every event from the Claude Code fixture is valid', () => {
    const fixture = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');
    const events = sessionEvents(fixture);
    assert.ok(events.length > 0);
    for (const e of events) assert.deepStrictEqual(validate(schema, JSON.parse(JSON.stringify(e))), [], e.eventId);
  });

  test('version 2 adds workspace; every version 1 event is a valid version 2 event', () => {
    const v1 = normalizedEventSchemaV1 as Schema;
    const ok = { eventId: 'e', sessionId: 's', agent: 'claude-code', ts: '2026-11-09T00:00:00Z', kind: 'edit', status: 'success', raw: { adapter: 'a', ref: 'r' } };
    const tagged = { ...ok, workspace: '/w/project' };
    const v2 = normalizedEventSchemaV2 as Schema;
    assert.deepStrictEqual(validate(v2, tagged), []);
    assert.ok(validate(v1, tagged).length > 0, 'version 1 has no workspace');
    assert.deepStrictEqual(Object.keys(v2.properties).filter((k) => !(k in v1.properties)), ['workspace']);
    assert.deepStrictEqual(Object.keys(v1.properties).filter((k) => !(k in v2.properties)), []);
    for (const e of syntheticEvents()) {
      const event = JSON.parse(JSON.stringify(e));
      assert.deepStrictEqual(validate(v1, event), [], e.eventId);
      assert.deepStrictEqual(validate(schema, event), [], e.eventId);
    }
  });

  test('version 3 adds outcome events; every version 2 event is a valid version 3 event', () => {
    const v2 = normalizedEventSchemaV2 as Schema;
    const green = {
      eventId: 'outcome:tests_green:t2', sessionId: 's', agent: 'claude-code', ts: '2026-11-09T00:00:00Z', kind: 'outcome', status: 'success',
      outcome: { type: 'tests_green', refs: ['t1', 't2'], failures: 1, afterMs: 60000 }, raw: { adapter: 'snagboat-outcomes', ref: 'tests:t2' },
    };
    assert.deepStrictEqual(validate(schema, green), []);
    assert.ok(validate(v2, green).length > 0, 'version 2 has no outcome');
    assert.ok(validate(schema, { ...green, outcome: { type: 'mood' } }).length > 0);
    assert.ok(validate(schema, { ...green, outcome: { type: 'finding_response', response: 'loved' } }).length > 0);
    // Approvals, as normalized from Claude Code's permission hooks.
    for (const payload of [
      { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } },
      { session_id: 's', hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/build' }, tool_use_id: 'toolu_1', reason: '[x]' },
    ]) {
      assert.deepStrictEqual(validate(schema, JSON.parse(JSON.stringify(normalizeHookPayload(payload)))), [], payload.hook_event_name);
    }
    assert.ok(validate(schema, { ...green, outcome: { type: 'approval', decision: 'maybe' } }).length > 0);
    assert.deepStrictEqual(Object.keys(props).filter((k) => !(k in v2.properties)).sort(), ['outcome', 'taskOp', 'todos']);
    assert.deepStrictEqual(Object.keys(v2.properties).filter((k) => !(k in props)), []);
    for (const e of syntheticEvents()) assert.deepStrictEqual(validate(v2, JSON.parse(JSON.stringify(e))), [], e.eventId);
  });

  test("version 3 adds todos: a TodoWrite call's list, counts always, items' text only with capture", () => {
    const payload = { session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_t', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Write it', status: 'in_progress', activeForm: 'Writing it' }, { content: 'Test it', status: 'pending' }] } };
    for (const capture of [true, false]) {
      const e = JSON.parse(JSON.stringify(normalizeHookPayload(payload, undefined, undefined, capture)));
      assert.ok(e.todos, 'has its list');
      assert.deepStrictEqual(validate(schema, e), [], `capture ${capture}`);
    }
    const ok = { eventId: 'e', sessionId: 's', agent: 'claude-code', ts: '2026-11-09T00:00:00Z', kind: 'tool_call', status: 'success', raw: { adapter: 'a', ref: 'r' } };
    assert.ok(validate(schema, { ...ok, todos: { pending: 1, inProgress: 0, completed: 0, items: [{ text: 'x', status: 'later' }] } }).length > 0);
    assert.ok(validate(schema, { ...ok, todos: { pending: 1, inProgress: 0, completed: 0, items: [{ text: 'x', status: 'pending', activeForm: 'y' }] } }).length > 0);
    assert.ok(validate(schema, { ...ok, todos: { pending: 1 } }).length > 0);
  });

  test("version 3 adds taskOp: a task tool call's change to the plan, subjects only with capture", () => {
    const payloads = [
      { session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_c', tool_name: 'TaskCreate', tool_input: { subject: 'Write it', description: 'd' }, tool_response: { task: { id: '1', subject: 'Write it' } } },
      { session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_u', tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'deleted' }, tool_response: { success: true, taskId: '1', updatedFields: ['status'] } },
      { session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_l', tool_name: 'TaskList', tool_input: {}, tool_response: { tasks: [{ id: '2', subject: 'Test it', status: 'pending', blockedBy: [] }] } },
    ];
    for (const payload of payloads) {
      for (const capture of [true, false]) {
        const e = JSON.parse(JSON.stringify(normalizeHookPayload(payload, undefined, undefined, capture)));
        assert.ok(e.taskOp, `${payload.tool_name} has its op`);
        assert.deepStrictEqual(validate(schema, e), [], `${payload.tool_name}, capture ${capture}`);
      }
    }
    const ok = { eventId: 'e', sessionId: 's', agent: 'claude-code', ts: '2026-11-09T00:00:00Z', kind: 'tool_call', status: 'success', raw: { adapter: 'a', ref: 'r' } };
    assert.ok(validate(schema, { ...ok, taskOp: { op: 'remove', id: '1' } }).length > 0);
    assert.ok(validate(schema, { ...ok, taskOp: { id: '1' } }).length > 0);
    assert.ok(validate(schema, { ...ok, taskOp: { op: 'list', tasks: [{ id: '1', status: 'deleted' }] } }).length > 0, 'a listed task is never deleted');
    assert.ok(validate(schema, { ...ok, taskOp: { op: 'create', id: '1', description: 'd' } }).length > 0);
  });

  test("every event in the web demo's synthetic sessions is valid", () => {
    const events = syntheticEvents();
    assert.ok(events.length > 0);
    for (const e of events) assert.deepStrictEqual(validate(schema, JSON.parse(JSON.stringify(e))), [], e.eventId);
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
