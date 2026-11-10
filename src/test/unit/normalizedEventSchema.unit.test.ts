import * as assert from 'assert';
import * as path from 'path';
import { NormalizedEvent, NormalizedEventKind, normalizedEventSchema, normalizedEventSchemaV1, TOOL_CATEGORY_LABELS } from '@snagboat/schema';
import { sessionEvents } from '../../scripts/replayHeuristics';
import { syntheticEvents } from '../../web/synthetic';

// The JSON Schema in @snagboat/schema (normalizedEvent.v2.schema.json) must describe the
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
      tool_call: true, edit: true, turn_start: true, turn_stop: true, user_prompt: true, compaction: true, session_name: true,
    };
    const statuses: Record<NormalizedEvent['status'], true> = { success: true, failure: true, unknown: true };
    const triggers: Record<NonNullable<NormalizedEvent['compaction']>['trigger'], true> = { auto: true, manual: true, unknown: true };
    const sorted = (xs: string[]) => [...xs].sort();
    assert.deepStrictEqual(sorted(props.kind.enum), sorted(Object.keys(kinds)));
    assert.deepStrictEqual(sorted(props.status.enum), sorted(Object.keys(statuses)));
    assert.deepStrictEqual(sorted(props.compaction.properties.trigger.enum), sorted(Object.keys(triggers)));
    assert.deepStrictEqual(sorted(props.toolCategory.anyOf[0].enum), sorted(Object.keys(TOOL_CATEGORY_LABELS)));
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
    assert.deepStrictEqual(validate(schema, tagged), []);
    assert.ok(validate(v1, tagged).length > 0, 'version 1 has no workspace');
    assert.deepStrictEqual(Object.keys(props).filter((k) => !(k in v1.properties)), ['workspace']);
    assert.deepStrictEqual(Object.keys(v1.properties).filter((k) => !(k in props)), []);
    for (const e of syntheticEvents()) {
      const event = JSON.parse(JSON.stringify(e));
      assert.deepStrictEqual(validate(v1, event), [], e.eventId);
      assert.deepStrictEqual(validate(schema, event), [], e.eventId);
    }
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
