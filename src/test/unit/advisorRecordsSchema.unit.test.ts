import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Experiment, experimentSchema, PeriodReport, periodReportSchema, ProposalEvent, proposalEventSchema, SetupEvent, setupEventSchema, Verdict } from '@snagboat/schema';
import { PeriodJob } from '../../core/service/periodJob';
import { StoreWriter } from '../../core/service/storeWriter';

// The goal tracking lifecycle's records in @snagboat/schema (snagboat-79f.7.3): a compile-time check in
// jsonSchema.ts keeps each schema's field list equal to its type's; this test checks the values: enums
// against the TypeScript unions, and real records (period reports the core writes, the design's W46
// example as proposals and experiments) against the schemas. As with events, nothing validates at run time.

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

const ok = (schema: unknown, value: unknown) => assert.deepStrictEqual(validate(schema as Schema, value), []);

const W46 = 'p-w46-1';
const proposals: ProposalEvent[] = [
  {
    version: 1, at: '2026-11-16T09:02:00.000Z', proposal: W46, advisor: 'purser', type: 'proposed', report: '2026-W46', rev: 1,
    title: 'Catch smaller cache rewrites',
    change: { kind: 'setting', key: 'heuristics.cacheThrash.minTokens', before: 50000, after: 30000 },
    scope: 'global',
    what: 'The nudge will also fire on cache rewrites of 30–50k tokens.',
    why: 'The cache hit rate fell 7 points, and 9 of the week\'s 14 rewrites were in that range.',
    prediction: { measure: 'cache_hit_rate', text: 'Cache hit rate back above 66% at the next report.', target: { direction: 'above', value: 66 } },
  },
  {
    version: 1, at: '2026-11-16T09:02:00.000Z', proposal: 'p-w46-2', advisor: 'purser', type: 'proposed', report: '2026-W46', rev: 1,
    title: 'Warn earlier on context', change: { kind: 'setting', key: 'heuristics.contextPressure.percent', before: 90, after: 80 },
    scope: { workspace: '/Users/dave/workspace/snagboat' }, what: 'The warning will fire at 80% context instead of 90%.', why: '4 of 6 compactions followed turns past 82%.',
    prediction: { measure: 'tokens_per_milestone', text: 'Tokens / milestone below 41.2k.' },
  },
  { version: 1, at: '2026-11-16T09:20:00.000Z', proposal: W46, advisor: 'purser', type: 'accepted', report: '2026-W46', rev: 1 },
  { version: 1, at: '2026-11-16T09:21:00.000Z', proposal: 'p-w46-2', advisor: 'purser', type: 'revised', report: '2026-W46', rev: 1, note: 'The RFC sessions need long context. Try a session budget.' },
  {
    version: 1, at: '2026-11-16T09:23:00.000Z', proposal: 'p-w46-2b', advisor: 'purser', type: 'proposed', report: '2026-W46', rev: 2, replaces: 'p-w46-2',
    title: "Cap a session's spend", change: { kind: 'setting', key: 'tokenBudget.session', after: 600000 }, scope: { workspace: '/Users/dave/workspace/snagboat' },
    what: 'A new nudge fires when a session passes 600k tokens.', why: 'The 3 sessions that passed 600k ended without a commit.',
    prediction: { measure: 'tokens_per_milestone', text: 'Tokens / milestone in snagboat below 41.2k.', target: { direction: 'below', value: 41200 } },
  },
  { version: 1, at: '2026-11-16T09:30:00.000Z', proposal: 'p-w46-x', advisor: 'purser', type: 'proposed', report: '2026-W46', rev: 2,
    title: 'A new rule', change: { kind: 'rule', rule: { id: 'long-reads', match: { toolName: 'Read' } } }, scope: 'global', what: 'w', why: 'y', prediction: { measure: 'cache_hit_rate', text: 't' } },
  { version: 1, at: '2026-11-16T09:31:00.000Z', proposal: 'p-w46-x', advisor: 'purser', type: 'discarded', report: '2026-W46', rev: 2 },
  { version: 1, at: '2026-11-23T09:00:00.000Z', proposal: W46, advisor: 'purser', type: 'kept', report: '2026-W47', rev: 1 },
  { version: 1, at: '2026-11-30T09:00:00.000Z', proposal: 'p-w46-2', advisor: 'purser', type: 'closed' },
];

const experiment: Experiment = {
  version: 1, id: 'x-1', advisor: 'purser', proposal: W46, title: 'Catch smaller cache rewrites',
  change: { kind: 'setting', key: 'heuristics.cacheThrash.minTokens', before: 50000, after: 30000 }, scope: 'global',
  baseline: { report: '2026-W46', measure: 'cache_hit_rate', value: 61 },
  prediction: { measure: 'cache_hit_rate', text: 'Cache hit rate back above 66% at the next report.', target: { direction: 'above', value: 66 } },
  startedAt: '2026-11-16T09:40:00.000Z', reviewAt: '2026-11-23T00:00:00.000Z', status: 'running', keptGoing: 0,
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const sorted = (xs: string[]) => [...xs].sort();

  test('enums match the TypeScript unions', () => {
    const types: Record<ProposalEvent['type'], true> = { proposed: true, accepted: true, discarded: true, revised: true, kept: true, closed: true };
    const results: Record<Verdict['result'], true> = { met: true, 'not-met': true, 'too-early': true, confounded: true };
    const statuses: Record<Experiment['status'], true> = { running: true, ended: true };
    const ended: Record<NonNullable<Experiment['ended']>['how'], true> = { accepted: true, reverted: true, replaced: true };
    const periods: Record<PeriodReport['period'], true> = { daily: true, weekly: true, monthly: true };
    const s = (x: unknown) => x as Schema;
    assert.deepStrictEqual(sorted(s(proposalEventSchema).properties.type.enum), sorted(Object.keys(types)));
    assert.deepStrictEqual(sorted(s(periodReportSchema).properties.revisions.items.properties.verdicts.items.properties.result.enum), sorted(Object.keys(results)));
    assert.deepStrictEqual(sorted(s(experimentSchema).properties.status.enum), sorted(Object.keys(statuses)));
    assert.deepStrictEqual(sorted(s(experimentSchema).properties.ended.properties.how.enum), sorted(Object.keys(ended)));
    assert.deepStrictEqual(sorted(s(periodReportSchema).properties.period.enum), sorted(Object.keys(periods)));
  });

  test('the period reports the core writes match the schema, with a model revision added', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-records-')));
    const w = path.join(home, 'w');
    fs.mkdirSync(w);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, defaults: { 'heuristics.cacheThrash.minTokens': 50000, captureContent: true }, projects: { [w]: { 'heuristics.stalled.minutes': 6 } } }));
    await new StoreWriter(home).write([
      { eventId: 'e1', sessionId: 's1', agent: 'claude-code', ts: new Date(2026, 10, 11, 10).toISOString(), kind: 'turn_stop', status: 'success', turnId: 't1', tokens: { input: 100, output: 0, cacheRead: 300, cacheCreation: 0 }, raw: { adapter: 'test', ref: 'r1' }, workspace: w },
    ]);
    let now = new Date(2026, 10, 18, 10);
    const job = new PeriodJob(home, () => now);
    await job.runDue();
    now = new Date(2026, 10, 25, 10);
    await job.runDue();
    await job.request('bosun');
    const reports = ['purser', 'navigator', 'bosun', 'lookout'].flatMap((a) => job.list(a));
    assert.ok(reports.length >= 9);
    for (const r of reports) ok(periodReportSchema, JSON.parse(JSON.stringify(r)));
    assert.deepStrictEqual(reports[0].rules.defaults, { 'heuristics.cacheThrash.minTokens': 50000 }, 'team settings only');
    const revised: PeriodReport = {
      ...reports[0],
      revisions: [{ rev: 1, createdAt: '2026-11-16T09:02:00.000Z', model: { advisor: 'local', model: 'qwen3' }, summary: 'Improving.', verdicts: [{ experiment: 'x-0', measure: 'cache_hit_rate', baseline: 61, now: 64, result: 'too-early', text: 'Up 3 points; one more week.' }], proposals: [W46, 'p-w46-2'], sent: { at: '2026-11-16T09:21:00.000Z', as: 'revise' } }],
    };
    ok(periodReportSchema, revised);
  });

  test("the design's W46 example, as proposal lines and experiments, matches the schemas", () => {
    for (const p of proposals) ok(proposalEventSchema, p);
    ok(experimentSchema, experiment);
    ok(experimentSchema, { ...experiment, status: 'ended', ended: { at: '2026-11-30T09:00:00.000Z', how: 'replaced', by: 'x-2' }, keptGoing: 1, overlaps: ['x-0'] });
  });

  test('a setup conversation, from start to accepted, matches the schema', () => {
    const types: Record<SetupEvent['type'], true> = { started: true, said: true, answered: true, revised: true, accepted: true, discarded: true };
    assert.deepStrictEqual(sorted((setupEventSchema as Schema).properties.type.enum), sorted(Object.keys(types)));
    const proposal = { name: 'Purser', status: 'Keeping token cost down', goal: 'token-cost-down', measures: ['tokens_per_milestone'], rules: ['cache-thrash'], maxPerHour: 2, period: 'weekly' as const, model: 'local', color: 'amber', icon: 'coin', voice: 'You watch what the work costs.' };
    const lines: SetupEvent[] = [
      { version: 1, at: '2026-11-18T09:00:00.000Z', setup: 's-20261118-abc123', type: 'started', model: { advisor: 'local', model: 'qwen3' } },
      { version: 1, at: '2026-11-18T09:00:10.000Z', setup: 's-20261118-abc123', type: 'said', text: 'I spend too much on tokens.' },
      { version: 1, at: '2026-11-18T09:00:30.000Z', setup: 's-20261118-abc123', type: 'answered', model: { advisor: 'local', model: 'qwen3' }, text: 'Per milestone, or per day?', problems: ['the answer was not the JSON asked for; kept as a reply'] },
      { version: 1, at: '2026-11-18T09:01:00.000Z', setup: 's-20261118-abc123', type: 'said', text: 'Per milestone.', model: { advisor: 'other' } },
      { version: 1, at: '2026-11-18T09:01:30.000Z', setup: 's-20261118-abc123', type: 'answered', model: { advisor: 'other' }, text: 'I propose Purser.', proposal },
      { version: 1, at: '2026-11-18T09:02:00.000Z', setup: 's-20261118-abc123', type: 'revised', text: 'Also watch the cache.' },
      { version: 1, at: '2026-11-18T09:03:00.000Z', setup: 's-20261118-abc123', type: 'accepted', advisor: 'purser' },
      { version: 1, at: '2026-11-18T09:03:00.000Z', setup: 's-20261118-def456', type: 'discarded' },
    ];
    for (const l of lines) ok(setupEventSchema, l);
    const problems = validate(setupEventSchema as Schema, { ...lines[4], proposal: { ...proposal, goal: 'Not An Id', mood: 'grand' } });
    assert.ok(problems.some((p) => /goal: does not match/.test(p)) && problems.some((p) => /mood: not in schema/.test(p)), problems.join(' | '));
  });

  test('a field the schema does not know, or a wrong value, fails', () => {
    const bad = (schema: unknown, value: unknown, re: RegExp) => {
      const problems = validate(schema as Schema, value);
      assert.ok(problems.some((p) => re.test(p)), `${re} in ${problems.join(' | ')}`);
    };
    bad(proposalEventSchema, { ...proposals[0], confidence: 0.9 }, /confidence: not in schema/);
    bad(proposalEventSchema, { ...proposals[0], type: 'maybe' }, /type: "maybe" not in enum/);
    bad(proposalEventSchema, { ...proposals[0], change: { kind: 'setting', key: 'x' } }, /change: matches none of anyOf/);
    bad(proposalEventSchema, { ...proposals[0], scope: 'everywhere' }, /scope: matches none of anyOf/);
    bad(experimentSchema, { ...experiment, keptGoing: undefined }, /keptGoing/);
    bad(experimentSchema, { ...experiment, reviewAt: 'next week' }, /reviewAt: does not match/);
    bad(periodReportSchema, { version: 1 }, /measures: required/);
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
