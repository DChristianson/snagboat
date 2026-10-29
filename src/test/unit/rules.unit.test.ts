import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../../core/eventStore';
import { classifyCommand, parseShellSubCategory, setShellSubCategories, ShellSubCategory, toolCategoryLabel } from '../../core/toolCategory';
import { NormalizedEvent } from '../../core/types';
import { backtrackingHeuristic } from '../../heuristics/backtracking';
import { FindingReplay } from '../../heuristics/replay';
import { buildRuleSet, parseRule, Rule } from '../../heuristics/rule';
import { ruleHeuristic } from '../../heuristics/ruleHeuristic';
import { RuleStore } from '../../heuristics/ruleStore';
import { runawayTurnHeuristic } from '../../heuristics/runawayTurn';
import { toolChurnHeuristic } from '../../heuristics/toolChurn';
import { Finding, Heuristic } from '../../heuristics/types';
import { sessionEvents } from '../../scripts/replayHeuristics';

const FIXTURE = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();

function ev(overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind'>): NormalizedEvent {
  return { sessionId: 'session-1', agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}
const prompt = (turnId: string, min: number) => ev({ eventId: `prompt-${turnId}-${min}`, kind: 'user_prompt', ts: at(min), turnId });
const call = (eventId: string, min: number, extra: Partial<NormalizedEvent> = {}) =>
  ev({ eventId, kind: 'turn_stop', ts: at(min), turnId: 't1', model: 'm', tokens: { input: 10, cacheRead: 1000, output: 5 }, ...extra });
const tool = (eventId: string, min: number, target: string | undefined, extra: Partial<NormalizedEvent> = {}) =>
  ev({ eventId, kind: 'tool_call', ts: at(min), turnId: 't1', target, toolName: 'Read', toolCategory: 'file-read', ...extra });

function rule(doc: Record<string, unknown>): Rule {
  const { value, errors } = parseRule(doc);
  assert.deepStrictEqual(errors, []);
  return value!;
}

/** Evaluates a rule over these events at `now`. */
function evaluate(doc: Record<string, unknown>, events: NormalizedEvent[], now: string, contextLimit?: (m: string | undefined) => number | undefined): Finding[] {
  const store = new EventStore({ windowMs: 24 * 60 * 60_000, maxEvents: 10_000 });
  for (const e of events) store.ingest(e);
  return ruleHeuristic(rule(doc)).evaluate({ now, store, settings: {}, contextLimit });
}

const base = { id: 'user:test', title: 'Test', scope: 'turn', severity: 'info', summary: 'fired' };

/** Replays events through a heuristic and returns when it fired: [start, end, severity] per episode. */
function episodes(heuristic: Heuristic, events: NormalizedEvent[]): Array<[string, string, string]> {
  const replay = new FindingReplay([heuristic], () => ({}));
  for (const e of events) replay.ingest(e);
  return replay.episodes().map((e) => [e.startTs, e.endTs, e.severity]);
}

// The design's check on expressiveness: three built-ins written as rules, with their default thresholds.
const RUNAWAY_TURN = {
  id: 'port:runaway-turn',
  title: 'Runaway turn',
  scope: 'turn',
  measures: {
    calls: { type: 'count', filter: { kind: 'turn_stop', hasTokens: true } },
    tools: { type: 'count', filter: { kind: 'tool_call' } },
  },
  when: { any: [{ measure: 'calls', gte: 100 }, { measure: 'tools', gte: 100 }] },
  severity: 'warn',
  summary: 'One prompt has driven {calls} model calls and {tools} tool calls',
};
const TOOL_CHURN = {
  id: 'port:tool-churn',
  title: 'Tool churn',
  scope: 'window',
  windowMinutes: 5,
  filter: { kind: 'tool_call', hasTarget: true },
  measures: { calls: { type: 'count' }, share: { type: 'topShare', n: 2 } },
  when: { all: [{ measure: 'calls', gte: 8 }, { measure: 'share', gte: 0.9 }] },
  severity: 'warn',
  summary: '{share} of {calls} tool calls in the last {windowMinutes} minutes hit the same targets',
};
const BACKTRACKING = {
  id: 'port:backtracking',
  title: 'Backtracking',
  scope: 'turn',
  filter: { kind: 'tool_call', hasTarget: true },
  measures: {
    failures: { type: 'maxPerTarget', filter: { status: 'failure' } },
    edits: { type: 'maxPerTarget', filter: { toolCategory: 'file-edit' } },
  },
  when: { any: [{ measure: 'failures', gte: 3 }, { measure: 'edits', gte: 10 }] },
  severity: 'warn',
  summary: '{target} failed {failures} times or was edited {edits} times in this turn',
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test("the design's example rule parses, with its measure named value", () => {
    const r = rule({
      id: 'user:read-loop',
      title: 'Re-reading the same files',
      scope: 'turn',
      filter: { kind: 'tool_call', toolCategory: ['file-read'] },
      measure: { type: 'maxPerTarget' },
      when: { gte: 6 },
      severity: 'info',
      summary: '{target} read {value} times in this turn',
      suggestedAction: "The agent may be losing track of the file's contents; consider pointing it at the relevant lines.",
    });
    assert.deepStrictEqual(Object.keys(r.measures), ['value']);
    assert.deepStrictEqual(r.when, { measure: 'value', gte: 6 });
    assert.deepStrictEqual(r.filter.kind, ['tool_call']);
  });

  test('invalid rules report every problem', () => {
    const { value, errors } = parseRule({
      id: 'Read Loop',
      scope: 'forever',
      measure: { type: 'average' },
      measures: {},
      when: { gte: 'six' },
      severity: 'error',
      summary: '{nope}',
      colour: 'red',
    });
    assert.strictEqual(value, undefined);
    for (const expected of ['unknown field "colour"', 'id must look like', 'title must be', 'scope must be', 'severity must be', 'not both']) {
      assert.ok(errors.some((e) => e.includes(expected)), `${expected} in ${JSON.stringify(errors)}`);
    }
  });

  test('conditions must name a measure when there are several, and need a threshold', () => {
    const doc = { ...base, measures: { a: { type: 'count' }, b: { type: 'count' } } };
    assert.ok(parseRule({ ...doc, when: { gte: 1 } }).errors.some((e) => e.includes('must name one of the rule\'s measures: a, b')));
    assert.ok(parseRule({ ...doc, when: { measure: 'a' } }).errors.some((e) => e.includes('needs a threshold')));
    assert.ok(parseRule({ ...doc, when: { all: [] } }).errors.some((e) => e.includes('non-empty list')));
    assert.deepStrictEqual(parseRule({ ...doc, when: { all: [{ measure: 'a', gte: 1 }, { any: [{ measure: 'b', lt: 3 }] }] } }).errors, []);
  });

  test('filters check their values', () => {
    const errors = parseRule({ ...base, filter: { kind: 'edit', status: 'broken', toolCategory: 'shel', subagent: 'yes', path: 'x' }, measure: { type: 'count' }, when: { gte: 1 } }).errors;
    for (const expected of ['filter.kind has "edit"', 'filter.status has "broken"', 'filter.toolCategory has unknown "shel"', 'filter.subagent must be true or false', 'unknown field "path"']) {
      assert.ok(errors.some((e) => e.includes(expected)), `${expected} in ${JSON.stringify(errors)}`);
    }
  });

  test('summaries may use only the placeholders the rule provides', () => {
    const doc = { ...base, measure: { type: 'count' }, when: { gte: 1 } };
    assert.ok(parseRule({ ...doc, summary: '{target}' }).errors.some((e) => e.includes('uses {target}')));
    assert.ok(parseRule({ ...doc, summary: '{windowMinutes}' }).errors.some((e) => e.includes('uses {windowMinutes}')));
    assert.deepStrictEqual(parseRule({ ...doc, scope: 'window', windowMinutes: 5, summary: '{value} in {windowMinutes}' }).errors, []);
    assert.ok(parseRule({ ...doc, scope: 'window' }).errors.some((e) => e.includes('windowMinutes must be a positive number')));
  });

  test('count, distinctTargets, and maxPerTarget over the current turn', () => {
    const events = [prompt('t1', 0), tool('a1', 1, 'a.ts'), tool('a2', 2, 'a.ts'), tool('b1', 3, 'b.ts'), tool('a3', 4, 'a.ts'), call('c1', 5)];
    const doc = { ...base, filter: { kind: 'tool_call' }, measures: { n: { type: 'count' }, d: { type: 'distinctTargets' }, m: { type: 'maxPerTarget' } }, when: { measure: 'n', gte: 4 }, summary: '{n} calls, {d} targets, {m.target} {m} times' };
    const [f] = evaluate(doc, events, at(6));
    assert.strictEqual(f.summary, '4 calls, 2 targets, a.ts 3 times');
    assert.strictEqual(f.eventRefs[0], 'prompt-t1-0');
    // A new prompt starts a new turn, which clears it.
    assert.deepStrictEqual(evaluate(doc, [...events, prompt('t2', 7)], at(8)), []);
  });

  test('topShare, failureRate, and sumTokens', () => {
    const events = [
      prompt('t1', 0),
      tool('a1', 1, 'a', { status: 'failure' }),
      tool('a2', 1, 'a', { status: 'success' }),
      tool('a3', 1, 'a', { status: 'failure' }),
      tool('b1', 2, 'b', { status: 'success' }),
      call('c1', 3),
      call('c2', 4),
    ];
    const doc = {
      ...base,
      measures: { share: { type: 'topShare', filter: { kind: 'tool_call' } }, fail: { type: 'failureRate', filter: { kind: 'tool_call' } }, tokens: { type: 'sumTokens' } },
      when: { all: [{ measure: 'share', gte: 0.75 }, { measure: 'fail', gte: 0.5 }] },
      summary: '{target} took {share}, {fail} failed, {tokens} tokens',
    };
    assert.strictEqual(evaluate(doc, events, at(5))[0].summary, 'a took 75%, 50% failed, 2K tokens');
  });

  test('contextPercent uses the call\'s reported limit, else the lowest seen for the model', () => {
    const doc = { ...base, measure: { type: 'contextPercent' }, when: { gte: 50 }, summary: 'context at {value}' };
    const events = [prompt('t1', 0), call('c1', 1, { tokens: { input: 600, cacheRead: 0, output: 1 } })];
    assert.deepStrictEqual(evaluate(doc, events, at(2)), []);
    assert.strictEqual(evaluate(doc, events, at(2), () => 1000)[0].summary, 'context at 60%');
  });

  test('consecutive counts runs among events of the filtered kind, so model calls in between don\'t break them', () => {
    const events = [
      prompt('t1', 0),
      tool('f1', 1, 'x', { status: 'failure' }),
      call('c1', 1),
      tool('f2', 2, 'y', { status: 'failure' }),
      call('c2', 2),
      tool('f3', 3, 'z', { status: 'failure' }),
      tool('ok', 4, 'z', { status: 'success' }),
      tool('f4', 5, 'z', { status: 'failure' }),
    ];
    const doc = { ...base, measure: { type: 'consecutive', filter: { kind: 'tool_call', status: 'failure' } }, when: { gte: 3 }, summary: '{value} failures in a row' };
    const [f] = evaluate(doc, events, at(6));
    assert.strictEqual(f.summary, '3 failures in a row');
    assert.deepStrictEqual(f.eventRefs, ['prompt-t1-0', 'f1', 'f2', 'f3']);
  });

  test('idleMinutes depends on the time, so the rule is re-run on timer ticks', () => {
    const doc = { ...base, scope: 'session', measure: { type: 'idleMinutes', filter: { kind: 'tool_call' } }, when: { gte: 10 }, summary: 'no tool calls for {value} minutes' };
    const events = [prompt('t1', 0), tool('a', 1, 'a'), call('c1', 2)];
    assert.deepStrictEqual(evaluate(doc, events, at(5)), []);
    assert.strictEqual(evaluate(doc, events, at(13))[0].summary, 'no tool calls for 12 minutes');
    assert.strictEqual(ruleHeuristic(rule(doc)).onlyChangesWithEvents, false);
    assert.strictEqual(ruleHeuristic(rule({ ...doc, measure: { type: 'count' } })).onlyChangesWithEvents, true);
  });

  test('window scope only counts recent events, per session', () => {
    const doc = { ...base, scope: 'window', windowMinutes: 5, measure: { type: 'count', filter: { kind: 'tool_call' } }, when: { gte: 3 }, summary: '{value} in {windowMinutes} minutes' };
    const events = [tool('a', 0, 'a'), tool('b', 4, 'a'), tool('c', 5, 'a'), tool('d', 5, 'a', { sessionId: 'session-2' })];
    assert.strictEqual(evaluate(doc, events, at(6)).length, 0);
    assert.deepStrictEqual(evaluate(doc, events, at(5)).map((f) => f.summary), ['3 in 5 minutes']);
  });

  test('filters: subagent, tool name patterns, agent, and status', () => {
    const events = [
      prompt('t1', 0),
      tool('m1', 1, 'a', { toolName: 'mcp__github__get_issue', toolCategory: 'mcp' }),
      tool('m2', 1, 'a', { toolName: 'mcp__github__list', toolCategory: 'mcp', agentId: 'agent-1' }),
      tool('m3', 1, 'a', { toolName: 'mcp__slack__post', toolCategory: 'mcp', status: 'failure' }),
    ];
    const count = (filter: Record<string, unknown>) => evaluate({ ...base, filter, measure: { type: 'count' }, when: { gte: 0 }, summary: '{value}' }, events, at(2))[0].summary;
    assert.strictEqual(count({ toolName: 'mcp__github__*' }), '2');
    assert.strictEqual(count({ toolName: 'mcp__github__*', subagent: false }), '1');
    assert.strictEqual(count({ kind: 'tool_call', status: ['failure'] }), '1');
    assert.strictEqual(count({ agent: 'copilot' }), '0');
  });

  test('ported runaway-turn fires exactly when the built-in does, over the redacted fixture', () => {
    const events = sessionEvents(FIXTURE);
    // Loosened to 4 so it fires on this ordinary session, as fixtureReplay does for the built-in.
    const loose = { ...RUNAWAY_TURN, when: { any: [{ measure: 'calls', gte: 4 }, { measure: 'tools', gte: 4 }] } };
    const builtIn = new FindingReplay([runawayTurnHeuristic], () => ({ maxModelCalls: 4, maxToolCalls: 4 }));
    for (const e of events) builtIn.ingest(e);
    const expected = builtIn.episodes().map((e) => [e.startTs, e.endTs, e.severity]);
    assert.strictEqual(expected.length, 3);
    assert.deepStrictEqual(episodes(ruleHeuristic(rule(loose)), events), expected);
  });

  test('ported tool-churn fires exactly when the built-in does', () => {
    const events: NormalizedEvent[] = [prompt('t1', 0)];
    // Churn on two files, a spread-out stretch, then churn again with a targetless call mixed in.
    for (let i = 0; i < 10; i++) events.push(tool(`a${i}`, 1 + i * 0.2, i % 2 ? 'a.ts' : 'b.ts'));
    for (let i = 0; i < 10; i++) events.push(tool(`s${i}`, 10 + i, `f${i}.ts`));
    for (let i = 0; i < 9; i++) events.push(tool(`c${i}`, 30 + i * 0.1, 'a.ts'));
    events.push(tool('none', 31, undefined, { toolName: 'TodoWrite', toolCategory: 'other' }));
    const expected = episodes(toolChurnHeuristic, events);
    assert.strictEqual(expected.length, 2);
    assert.deepStrictEqual(episodes(ruleHeuristic(rule(TOOL_CHURN)), events), expected);
  });

  test('ported backtracking fires exactly when the built-in does', () => {
    const events: NormalizedEvent[] = [prompt('t1', 0)];
    for (let i = 0; i < 3; i++) events.push(tool(`f${i}`, 1 + i, 'npm test', { status: 'failure', toolName: 'Bash', toolCategory: 'tests-builds' }), call(`c${i}`, 1 + i));
    events.push(prompt('t2', 10));
    for (let i = 0; i < 11; i++) events.push(tool(`e${i}`, 11 + i, 'src/x.ts', { turnId: 't2', toolName: 'Edit', toolCategory: 'file-edit', status: 'success' }));
    events.push(prompt('t3', 30), tool('quiet', 31, 'src/x.ts', { turnId: 't3', toolName: 'Edit', toolCategory: 'file-edit' }));
    const expected = episodes(backtrackingHeuristic, events);
    assert.strictEqual(expected.length, 2);
    assert.deepStrictEqual(episodes(ruleHeuristic(rule(BACKTRACKING)), events), expected);
  });

  const packageInstall: ShellSubCategory = { id: 'user:shell/package-install', parent: 'shell', label: 'Package installs', match: ['npm install', 'pip', 'brew install'] };
  const network: ShellSubCategory = { id: 'user:shell/network', parent: 'shell', label: 'Network', match: ['curl', 'npm'] };

  test('shell sub-categories refine plain shell commands only, longest match first', () => {
    const subs = [network, packageInstall];
    assert.strictEqual(classifyCommand('npm install left-pad', subs), 'user:shell/package-install');
    assert.strictEqual(classifyCommand('npm outdated', subs), 'user:shell/network');
    assert.strictEqual(classifyCommand('cd x && FOO=1 curl -s https://example.com | jq .', subs), 'user:shell/network');
    assert.strictEqual(classifyCommand('npm test', subs), 'tests-builds');
    assert.strictEqual(classifyCommand('ls -la', subs), 'shell');
    assert.strictEqual(classifyCommand('npm install', []), 'shell');
  });

  test('sub-categories in use label events and are matched by a filter on shell', () => {
    setShellSubCategories([packageInstall]);
    try {
      assert.strictEqual(classifyCommand('brew install jq'), 'user:shell/package-install');
      assert.strictEqual(toolCategoryLabel('user:shell/package-install'), 'Package installs');
      const events = [prompt('t1', 0), tool('i', 1, 'npm install', { toolName: 'Bash', toolCategory: 'user:shell/package-install' }), tool('l', 1, 'ls', { toolName: 'Bash', toolCategory: 'shell' })];
      const count = (toolCategory: string) => evaluate({ ...base, filter: { toolCategory }, measure: { type: 'count' }, when: { gte: 0 }, summary: '{value}' }, events, at(2))[0].summary;
      assert.strictEqual(count('shell'), '2');
      assert.strictEqual(count('user:shell/package-install'), '1');
    } finally {
      setShellSubCategories([]);
    }
    assert.strictEqual(toolCategoryLabel('user:shell/package-install'), 'package-install');
  });

  test('invalid sub-categories say why, including prefixes that could never apply', () => {
    const { errors } = parseShellSubCategory({ id: 'shell/x', parent: 'git', label: '', match: ['git push', 'a b c', 'npm  i'] });
    for (const expected of ['id must look like', 'parent must be "shell"', 'label must be', 'already classified as Version control', '"a b c" must be one or two words', '"npm  i" must be one or two words']) {
      assert.ok(errors.some((e) => e.includes(expected)), `${expected} in ${JSON.stringify(errors)}`);
    }
    assert.deepStrictEqual(parseShellSubCategory(packageInstall), { value: packageInstall, errors: [] });
  });

  test('a later source replaces an earlier rule with the same id, and invalid documents are reported', () => {
    const saved = { origin: 'saved', rules: [{ ...RUNAWAY_TURN }, { id: 'user:broken' }], categories: [packageInstall] };
    const settings = { origin: 'settings', rules: [{ ...RUNAWAY_TURN, severity: 'info' }], categories: [{ ...packageInstall, match: ['git'] }] };
    const set = buildRuleSet([saved, settings]);
    assert.deepStrictEqual(set.rules.map((r) => [r.id, r.severity]), [['port:runaway-turn', 'info']]);
    assert.deepStrictEqual(set.categories, [packageInstall]);
    assert.strictEqual(set.problems.length, 2);
    assert.ok(set.problems[0].startsWith('saved rule user:broken: '));
    assert.ok(set.problems[1].startsWith('settings tool category user:shell/package-install: '));
  });

  test('the rule store saves, replaces, and removes by id, and never overwrites a file it can\'t read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-rules-'));
    try {
      const provenance = { proposedBy: 'you' as const, addedAt: at(0) };
      const store = new RuleStore(dir);
      await store.load();
      await store.save('rules', { ...TOOL_CHURN }, provenance);
      await store.save('rules', { ...BACKTRACKING }, provenance);
      await store.save('rules', { ...TOOL_CHURN, severity: 'info' }, { ...provenance, replay: { episodes: 4, sessions: 2 } });
      await store.save('categories', { ...packageInstall }, provenance);
      // Another window's store sees the same file.
      const other = new RuleStore(dir);
      await other.load();
      assert.deepStrictEqual(other.list('rules').map((r) => [r.doc.id, r.doc.severity, r.provenance.replay?.episodes]), [['port:backtracking', 'warn', undefined], ['port:tool-churn', 'info', 4]]);
      await other.remove('rules', 'port:backtracking');
      await store.save('rules', { ...RUNAWAY_TURN }, provenance);
      assert.deepStrictEqual(store.source().rules.map((r) => (r as { id: string }).id), ['port:tool-churn', 'port:runaway-turn']);
      assert.strictEqual(store.source().categories.length, 1);

      fs.writeFileSync(path.join(dir, 'rules.json'), '{ not json');
      await assert.rejects(store.load());
      assert.deepStrictEqual(store.source().rules, []);
      await assert.rejects(store.save('rules', { ...RUNAWAY_TURN }, provenance));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'), '{ not json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
  if (failures > 0) process.exit(1);
}

main();
