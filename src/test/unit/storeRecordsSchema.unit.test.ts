import * as assert from 'assert';
import {
  BranchRecord,
  CheckoutRecord,
  CommitRecord,
  currentLinks,
  ExportManifest,
  exportManifestSchema,
  FindingRecord,
  findingRecordSchema,
  foldStoreRecords,
  GitRecord,
  gitRecordSchema,
  LinkEndType,
  LinkKind,
  LinkRecord,
  linkRecordSchema,
  PlanItemKind,
  PlanItemRecord,
  PlanItemStatus,
  PlanItemTouch,
  PlanRecord,
  planRecordSchema,
  SessionRecord,
  sessionRecordSchema,
  SessionSummary,
  STORE_RECORD_FILES,
  storeRecordKey,
  TransitionRecord,
  TransitionType,
} from '@snagboat/schema';

// The store's git, plan, link and finding records and the export's session and manifest records
// in @snagboat/schema (snagboat-93b.10.1, docs/design/export.md). A compile-time check in
// jsonSchema.ts keeps each schema's field list equal to its type's; this test checks the values:
// enums against the TypeScript unions, and example records (the design's own) against the
// schemas. As with events, nothing validates at run time.

type Schema = Record<string, any>;

/** Validates the subset of JSON Schema the record schemas use, $ref to $defs included; returns the problems found. */
function validate(schema: Schema, value: unknown, at = '$', root: Schema = schema): string[] {
  const problems: string[] = [];
  if (schema.$ref) {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    if (!name || !root.$defs?.[name]) return [`${at}: unresolved ${schema.$ref}`];
    return validate(root.$defs[name], value, at, root);
  }
  if (schema.const !== undefined && value !== schema.const) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))) problems.push(`${at}: does not match ${schema.pattern}`);
  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== schema.type) problems.push(`${at}: expected ${schema.type}, got ${actual}`);
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => problems.push(...validate(schema.items, v, `${at}[${i}]`, root)));
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => validate(s, value, at, root).length === 0)) problems.push(`${at}: matches none of anyOf`);
  if (schema.type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${at}.${key}: required`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) problems.push(...validate(sub, v, `${at}.${key}`, root));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key}: not in schema`);
      else if (typeof schema.additionalProperties === 'object') problems.push(...validate(schema.additionalProperties, v, `${at}.${key}`, root));
    }
  }
  return problems;
}

const ok = (schema: unknown, value: unknown) => assert.deepStrictEqual(validate(schema as Schema, JSON.parse(JSON.stringify(value))), []);
const bad = (schema: unknown, value: unknown, why: string) => assert.ok(validate(schema as Schema, JSON.parse(JSON.stringify(value))).length > 0, why);
const sorted = (xs: string[]) => [...xs].sort();

const SHA = '48150b0c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
const PARENT = '15d863c0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const commit: CommitRecord = {
  record: 'commit', version: 1, sha: SHA, parents: [PARENT], kind: 'squash',
  authoredAt: '2026-11-21T01:00:00.000Z', committedAt: '2026-11-21T01:02:00.000Z',
  author: 'Dave <dave@example.com>', committer: 'GitHub <noreply@github.com>', coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>'],
  subject: 'Design: export privacy rules and the normalized schema (snagboat-93b.9) (#162)', body: 'The design.',
  files: [{ path: 'docs/design/export.md', status: 'A', added: 397, deleted: 0 }, { path: 'docs/b.md', status: 'R', added: 1, deleted: 1, from: 'docs/a.md' }],
  pr: 162, onBranches: ['main'],
};
const branch: BranchRecord = {
  record: 'branch', version: 1, id: 'export-design@2026-11-20T18:00:00.000Z', name: 'export-design', firstSeenAt: '2026-11-20T18:00:00.000Z',
  createdAt: '2026-11-20T17:58:00.000Z', from: PARENT, head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  merged: { into: 'main', at: '2026-11-21T01:02:00.000Z', via: 'squash', commit: SHA, pr: 162 }, deletedAt: '2026-11-21T01:10:00.000Z',
};
const checkout: CheckoutRecord = {
  record: 'checkout', version: 1, id: 'checkout-0123456789abcdef', at: '2026-11-20T17:58:00.000Z', from: 'main', to: 'export-design', commit: PARENT, where: '/w/snagboat',
};
const item: PlanItemRecord = {
  record: 'item', version: 1, id: 'snagboat-93b.10.1', kind: 'feature', title: 'Export schema', status: 'in_progress', priority: 2, parent: 'snagboat-93b.10',
  blockedBy: [], labels: [], created: '2026-11-21T02:29:03Z', started: '2026-11-21T03:00:00Z', updated: '2026-11-21T03:00:00Z', assignee: 'DChristianson',
  text: { description: 'In packages/schema...', acceptance: 'Types and JSON Schemas.' }, source: 'beads', confidence: 'observed',
};
const mdItem: PlanItemRecord = {
  record: 'item', version: 1, id: 'md-0123456789ab', kind: 'step', title: 'Schema', status: 'done', labels: [], created: '2026-11-20T00:00:00Z', updated: '2026-11-21T00:00:00Z',
  source: 'markdown', from: { file: 'docs/design/export.md', heading: 'Build order' }, confidence: 'inferred',
};
const transitions: TransitionRecord[] = [
  { record: 'transition', version: 1, id: '7336c94d-b9e9-5aa8-ac58-8a40b4eea90e', item: 'snagboat-93b.10.1', at: '2026-11-21T02:29:03Z', type: 'created', actor: 'DChristianson', confidence: 'observed' },
  { record: 'transition', version: 1, id: 'b1', item: 'snagboat-93b.10.1', at: '2026-11-21T03:00:00Z', type: 'status_changed', from: 'open', to: 'in_progress', actor: 'claude-code', confidence: 'observed' },
  { record: 'transition', version: 1, id: 'b2', item: 'snagboat-93b.10.1', at: '2026-11-21T03:01:00Z', type: 'updated', fields: ['notes'], actor: 'claude-code', confidence: 'observed' },
  { record: 'transition', version: 1, id: 'b3', item: 'snagboat-93b.10.2', at: '2026-11-21T03:02:00Z', type: 'dependency_added', to: 'snagboat-93b.10.1', actor: 'DChristianson', confidence: 'observed' },
  { record: 'transition', version: 1, id: 'md-t-0123456789abcdef', item: 'md-0123456789ab', at: '2026-11-21T00:00:00Z', type: 'status_changed', from: 'open', to: 'done', actor: 'Dave <dave@example.com>', confidence: 'inferred' },
];
const link: LinkRecord = {
  record: 'link', version: 1, id: 'link-0123456789abcdef', from: { type: 'session', id: 's1' }, to: { type: 'plan-item', id: 'snagboat-93b.10.1' }, kind: 'touched', how: 'claimed',
  confidence: 'observed', evidence: [{ rule: 'bd-command', refs: ['tool:toolu_1', 'b1'] }],
};
const finding: FindingRecord = {
  record: 'finding', version: 1, id: 'finding-0123456789abcdef', heuristicId: 'runawayTurn', heuristicVersion: '0.9.0', sessionId: 's1', turnId: 't1', severity: 'warn',
  summary: 'This turn has run 40 tool calls.', firstTs: '2026-11-21T03:00:00Z', lastTs: '2026-11-21T03:10:00Z', eventRefs: ['tool:toolu_1'], earlyWarning: false, response: 'useful',
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const git = gitRecordSchema as Schema;
  const plan = planRecordSchema as Schema;

  test('enums match the TypeScript unions', () => {
    const itemKinds: Record<PlanItemKind, true> = { epic: true, milestone: true, feature: true, task: true, bug: true, step: true, decision: true, question: true, note: true };
    const itemStatuses: Record<PlanItemStatus, true> = { open: true, in_progress: true, blocked: true, done: true, deferred: true, dropped: true };
    const transitionTypes: Record<TransitionType, true> = { created: true, claimed: true, status_changed: true, updated: true, closed: true, reopened: true, dependency_added: true, dependency_removed: true, commented: true, label_added: true, label_removed: true };
    const endTypes: Record<LinkEndType, true> = { session: true, commit: true, branch: true, 'plan-item': true, transition: true };
    const linkKinds: Record<LinkKind, true> = { made: true, 'worked-on': true, touched: true, references: true, merged: true, 'made-in': true };
    const touches: Record<PlanItemTouch, true> = { created: true, claimed: true, updated: true, closed: true, mentioned: true };
    const commitKinds: Record<CommitRecord['kind'], true> = { commit: true, merge: true, squash: true };
    const vias: Record<NonNullable<BranchRecord['merged']>['via'], true> = { merge: true, squash: true, rebase: true, 'fast-forward': true };
    const responses: Record<FindingRecord['response'], true> = { useful: true, muted: true, acknowledged: true, passed: true };
    const defs = { ...git.$defs, ...plan.$defs };
    assert.deepStrictEqual(sorted(defs.item.properties.kind.enum), sorted(Object.keys(itemKinds)));
    assert.deepStrictEqual(sorted(defs.item.properties.status.enum), sorted(Object.keys(itemStatuses)));
    assert.deepStrictEqual(sorted(defs.transition.properties.type.enum), sorted(Object.keys(transitionTypes)));
    assert.deepStrictEqual(sorted(defs.commit.properties.kind.enum), sorted(Object.keys(commitKinds)));
    assert.deepStrictEqual(sorted(defs.branch.properties.merged.properties.via.enum), sorted(Object.keys(vias)));
    const links = linkRecordSchema as Schema;
    assert.deepStrictEqual(sorted(links.properties.from.properties.type.enum), sorted(Object.keys(endTypes)));
    assert.deepStrictEqual(links.properties.to, links.properties.from);
    assert.deepStrictEqual(sorted(links.properties.kind.enum), sorted(Object.keys(linkKinds)));
    assert.deepStrictEqual(sorted(links.properties.how.enum), sorted(Object.keys(touches)));
    assert.deepStrictEqual(sorted((sessionRecordSchema as Schema).properties.planItems.items.properties.how.enum), sorted(Object.keys(touches)));
    assert.deepStrictEqual(sorted((findingRecordSchema as Schema).properties.response.enum), sorted(Object.keys(responses)));
  });

  test('each record names its type in record, and its schema takes only that type', () => {
    const lines: Array<[Schema, Record<string, unknown>, string]> = [
      [git, commit as unknown as Record<string, unknown>, 'commit'],
      [git, branch as unknown as Record<string, unknown>, 'branch'],
      [git, checkout as unknown as Record<string, unknown>, 'checkout'],
      [plan, item as unknown as Record<string, unknown>, 'item'],
      [plan, transitions[0] as unknown as Record<string, unknown>, 'transition'],
      [linkRecordSchema as Schema, link as unknown as Record<string, unknown>, 'link'],
      [findingRecordSchema as Schema, finding as unknown as Record<string, unknown>, 'finding'],
    ];
    for (const [schema, line, type] of lines) {
      assert.strictEqual(line.record, type);
      ok(schema, line);
      bad(schema, { ...line, record: 'other' }, `${type}: an unknown record type`);
      bad(schema, { ...line, version: 2 }, `${type}: an unknown version`);
      const { record: _r, ...untyped } = line;
      bad(schema, untyped, `${type}: no record`);
    }
    // The file each type goes to, and the schema for that file's lines.
    const fileSchemas: Record<string, Schema> = { 'git.jsonl': git, 'plan.jsonl': plan, 'links.jsonl': linkRecordSchema, 'findings.jsonl': findingRecordSchema };
    for (const [schema, line, type] of lines) assert.strictEqual(fileSchemas[STORE_RECORD_FILES[type as keyof typeof STORE_RECORD_FILES]], schema, type);
    assert.deepStrictEqual(sorted(Object.keys(git.$defs)), ['branch', 'checkout', 'commit']);
    assert.deepStrictEqual(sorted(Object.keys(plan.$defs)), ['item', 'transition']);
    for (const [name, def] of Object.entries({ ...git.$defs, ...plan.$defs } as Record<string, Schema>)) assert.strictEqual(def.properties.record.const, name);
    // A commit's fields don't pass as a branch, and so on.
    bad(git, { ...checkout, record: 'branch' }, 'a checkout labeled a branch');
    bad(plan, { ...transitions[0], record: 'item' }, 'a transition labeled an item');
  });

  test('git.jsonl: commits, branches and checkouts as the design has them', () => {
    ok(git, { ...commit, kind: 'merge', parents: [PARENT, SHA], pr: undefined });
    ok(git, { ...commit, body: undefined, reverts: PARENT, coAuthors: [] });
    ok(git, { record: 'branch', version: 1, id: 'wip@2026-11-21T00:00:00.000Z', name: 'wip', firstSeenAt: '2026-11-21T00:00:00.000Z', head: SHA });
    bad(git, { ...commit, kind: 'rebase' }, 'not a commit kind');
    bad(git, { ...commit, files: [{ path: 'a', status: 'C', added: 0, deleted: 0 }] }, 'not a file status');
    bad(git, { ...commit, files: [{ path: 'a', status: 'M', added: 1 }] }, 'a file needs its counts');
    bad(git, { ...commit, timezone: '-0500' }, 'git timezone offsets are not kept');
    bad(git, { ...branch, merged: { into: 'main', at: branch.deletedAt, via: 'cherry-pick', commit: SHA } }, 'not a merge');
    bad(git, { ...branch, firstSeenAt: undefined }, 'a branch is keyed by its first-seen time');
    bad(git, { ...checkout, commit: undefined }, 'a checkout names its commit');
  });

  test('plan.jsonl: items from beads and markdown, and their transitions', () => {
    ok(plan, mdItem);
    for (const t of transitions) ok(plan, t);
    ok(plan, { ...item, status: 'done', closed: '2026-11-22T00:00:00Z', closeReason: 'Done' });
    bad(plan, { ...item, status: 'closed' }, "bd's closed is done here");
    bad(plan, { ...item, kind: 'chore' }, 'not a Factory Clock kind');
    bad(plan, { ...item, source: 'jira' }, 'not a source');
    bad(plan, { ...item, confidence: undefined }, 'items carry confidence');
    bad(plan, { ...mdItem, from: { heading: 'Build order' } }, 'from names its file');
    bad(plan, { ...item, text: { summary: 'x' } }, 'not a text field');
    bad(plan, { ...transitions[0], type: 'moved' }, 'not a transition type');
    bad(plan, { ...transitions[2], old: {}, new: {} }, "an update keeps only the fields' names");
  });

  test('links.jsonl and findings.jsonl', () => {
    const links = linkRecordSchema as Schema;
    ok(links, { ...link, how: undefined, kind: 'made', to: { type: 'commit', id: SHA }, confidence: 'inferred', evidence: [{ rule: 'git-outcomes', refs: ['e1'] }] });
    ok(links, { ...link, supersededBy: 'link-fedcba9876543210' });
    bad(links, { ...link, from: { type: 'person', id: 'x' } }, 'not a record type');
    bad(links, { ...link, kind: 'blocks' }, 'not a link kind');
    bad(links, { ...link, evidence: [{ rule: 'x' }] }, 'evidence names its records');
    const findings = findingRecordSchema as Schema;
    ok(findings, { ...finding, sessionId: undefined, turnId: undefined, summary: undefined, earlyWarning: true, response: 'passed' });
    bad(findings, { ...finding, response: 'loved' }, 'not a response');
    bad(findings, { ...finding, earlyWarning: 'yes' }, 'earlyWarning is a boolean');
    bad(findings, { ...finding, heuristicVersion: undefined }, 'findings carry their heuristic version');
  });

  test('a record is keyed by its type and its SHA or id; the latest line with a key is the record', () => {
    assert.strictEqual(storeRecordKey(commit), `commit:${SHA}`);
    assert.strictEqual(storeRecordKey(branch), `branch:${branch.id}`);
    assert.strictEqual(storeRecordKey(item), 'item:snagboat-93b.10.1');
    const open: BranchRecord = { ...branch, merged: undefined, deletedAt: undefined };
    const gitLines: GitRecord[] = [open, commit, checkout, branch, commit];
    assert.deepStrictEqual(foldStoreRecords(gitLines), [branch, commit, checkout]);
    const closed: PlanItemRecord = { ...item, status: 'done', closed: '2026-11-22T00:00:00Z' };
    const planLines: PlanRecord[] = [item, ...transitions, closed];
    const folded = foldStoreRecords(planLines);
    assert.strictEqual(folded.length, 1 + transitions.length);
    assert.deepStrictEqual(folded[0], closed);
    // An item and a transition never collide, even with the same id.
    assert.strictEqual(foldStoreRecords<PlanRecord>([{ ...transitions[0], id: item.id }, item]).length, 2);
  });

  test('the export writes the current links: the latest of each, and none superseded', () => {
    const inferred: LinkRecord = { ...link, id: 'link-a', confidence: 'inferred', evidence: [{ rule: 'id-in-prompt', refs: ['p1'] }] };
    const observed: LinkRecord = { ...inferred, confidence: 'observed', evidence: [{ rule: 'bd-command', refs: ['tool:toolu_1'] }] };
    const wrong: LinkRecord = { ...link, id: 'link-b', kind: 'made', how: undefined, to: { type: 'commit', id: PARENT }, confidence: 'inferred' };
    const right: LinkRecord = { ...wrong, id: 'link-c', to: { type: 'commit', id: SHA }, confidence: 'observed' };
    assert.deepStrictEqual(currentLinks([inferred, wrong, observed, right, { ...wrong, supersededBy: 'link-c' }]), [observed, right]);
  });

  test("sessions.jsonl: what snagboat sessions --json prints, plus the session's links", () => {
    const summary: SessionSummary = {
      sessionId: 's1', agent: 'claude-code', firstTs: '2026-11-21T03:00:00Z', lastTs: '2026-11-21T04:00:00Z', models: ['claude-opus-5-5'], prompts: 3, modelCalls: 40, toolCalls: 30, tokens: 1_000_000, subagents: 1, days: ['2026-11-21'], name: 'Export schema',
    };
    const session: SessionRecord = {
      ...summary, subagentIds: ['a1'], where: '.', branches: ['main', 'export-schema'],
      commits: [{ sha: SHA, confidence: 'observed' }], planItems: [{ id: 'snagboat-93b.10.1', how: 'claimed', confidence: 'observed' }, { id: 'snagboat-93b.10.1', how: 'mentioned', confidence: 'inferred' }],
    };
    const schema = sessionRecordSchema as Schema;
    ok(schema, session);
    ok(schema, { ...session, name: undefined, where: '[worktree-1]', commits: [], planItems: [] });
    bad(schema, summary, 'a summary alone lacks the links');
    bad(schema, { ...session, subagents: ['a1'] }, 'subagents stays a count; ids are subagentIds');
    bad(schema, { ...session, planItems: [{ id: 'x', how: 'edited', confidence: 'observed' }] }, 'not a way to touch an item');
    bad(schema, { ...session, commits: [{ sha: SHA, confidence: 'maybe' }] }, 'not a confidence');
  });

  test("manifest.json: the export's versions, range, counts, redactions and privacy", () => {
    const manifest: ExportManifest = {
      format: 'snagboat-export', version: 1, eventSchema: 4, generatedAt: '2026-11-21T05:00:00Z', project: 'snagboat',
      range: { since: '2026-11-01', first: '2026-11-01T09:00:00Z', last: '2026-11-21T04:00:00Z' }, text: 'redacted',
      counts: { days: 21, events: 50_000, sessions: 120, findings: 40, commits: 160, branches: 80, checkouts: 300, planItems: 200, transitions: 900, links: 1_500 },
      rulesVersion: 1, snagboatVersion: '0.9.0', redactions: { 'home-path': 12, email: 3 }, flags: 2, repository: { privacy: 'private' },
    };
    const schema = exportManifestSchema as Schema;
    ok(schema, manifest);
    ok(schema, { ...manifest, range: {}, text: 'none', redactions: {}, repository: { privacy: 'public' } });
    bad(schema, { ...manifest, format: 'some-other-export' }, 'not an export');
    bad(schema, { ...manifest, eventSchema: 3 }, 'events are version 4');
    bad(schema, { ...manifest, redactions: { email: 'three' } }, 'redactions are counts');
    bad(schema, { ...manifest, repository: { privacy: 'internal' } }, 'private or public');
    bad(schema, { ...manifest, counts: { ...manifest.counts, links: undefined } }, 'every count');
    bad(schema, { ...manifest, review: '/Users/dave/out.review' }, 'the review folder is never named in the export');
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
