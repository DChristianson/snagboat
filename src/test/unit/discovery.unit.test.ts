import * as assert from 'assert';
import { NormalizedEvent } from '../../core/types';
import { discover, MIN_TURNS, pastTurns } from '../../discovery/discover';
import { formatDiscovery } from '../../discovery/report';
import { discoverShellCategories } from '../../discovery/shellCategories';
import { builtInHeuristics } from '../../heuristics/builtIns';
import { parseRule } from '../../heuristics/rule';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();

let seq = 0;
function ev(sessionId: string, turnId: string, min: number, overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  seq += 1;
  return { eventId: `e${seq}`, sessionId, turnId, agent: 'claude-code', ts: at(min), status: 'unknown', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}

/** A turn: a prompt, two model calls, and one read of a file of its own; or, for an outlier, six reads of one file. */
function turn(sessionId: string, n: number, outlier = false): NormalizedEvent[] {
  const turnId = `${sessionId}-t${n}`;
  const min = n * 10;
  const reads = outlier ? 6 : 1;
  const events = [ev(sessionId, turnId, min, { kind: 'user_prompt' })];
  for (let i = 0; i < reads; i++) {
    events.push(ev(sessionId, turnId, min + 1, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', status: 'success', target: outlier ? 'secret/path.ts' : `f${sessionId}${n}.ts` }));
  }
  events.push(ev(sessionId, turnId, min + 2, { kind: 'turn_stop', model: 'm', tokens: { input: 10, output: 5 } }));
  events.push(ev(sessionId, turnId, min + 3, { kind: 'turn_stop', model: 'm', tokens: { input: 10, output: 5 }, endsTurn: true }));
  return events;
}

/** 100 ordinary turns over 5 sessions, plus outliers in the given sessions. */
function history(outlierSessions: string[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const s of ['s1', 's2', 's3', 's4', 's5']) for (let n = 0; n < 20; n++) events.push(...turn(s, n));
  outlierSessions.forEach((s, i) => events.push(...turn(s, 100 + i, true)));
  return events;
}

const opts = { existing: builtInHeuristics(), settingsFor: () => ({}) };

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('past turns are grouped by session and turn, and need their prompt', () => {
    const events = [...turn('a', 0), ...turn('b', 0), ev('a', 'orphan', 50, { kind: 'turn_stop' })];
    assert.deepStrictEqual(pastTurns(events).map((t) => [t.sessionId, t.events.length]), [['a', 4], ['b', 4]]);
  });

  test('a recurring outlier becomes a candidate rule at your tail, scored by replay', () => {
    const result = discover(history(['s1', 's2', 's3']), opts);
    assert.strictEqual(result.turns, 103);
    const reads = result.candidates.find((c) => c.rule.id === 'discovery:reads-one-file');
    assert.ok(reads, JSON.stringify(result.candidates.map((c) => c.rule.id)));
    assert.strictEqual(reads.threshold, 6);
    assert.deepStrictEqual([reads.turnsAbove, reads.sessionsAbove, reads.baseline.p50], [3, 3, 1]);
    assert.deepStrictEqual(parseRule(reads.rule).errors, []);
    assert.deepStrictEqual([reads.score.episodes, reads.score.sessions], [3, 3]);
  });

  test('an outlier in only one session is not a pattern yet', () => {
    const result = discover(history(['s1', 's1', 's1']), opts);
    assert.ok(!result.candidates.some((c) => c.rule.id === 'discovery:reads-one-file'));
  });

  test("built-ins get threshold suggestions instead of candidates, and none when every turn looks alike", () => {
    const result = discover(history(['s1', 's2', 's3']), opts);
    assert.ok(!result.candidates.some((c) => c.rule.id === 'discovery:model-calls'));
    const calls = result.thresholds.find((t) => t.heuristic === 'runaway-turn' && t.setting === 'maxModelCalls')!;
    assert.deepStrictEqual([calls.current, calls.currentShare, calls.baseline.p50], [100, 0, 2]);
    // Every turn has 2 model calls: no tail to suggest.
    assert.strictEqual(calls.suggested, undefined);
    const custom = discover(history(['s1', 's2', 's3']), { ...opts, settingsFor: (id: string) => (id === 'runaway-turn' ? { maxModelCalls: 2 } : {}) });
    assert.strictEqual(custom.thresholds.find((t) => t.setting === 'maxModelCalls')!.currentShare, 1);
  });

  test('too little history says so instead of guessing', () => {
    const result = discover(turn('s1', 0), opts);
    assert.deepStrictEqual(result.candidates, []);
    assert.ok(result.notes[0].includes(`at least ${MIN_TURNS}`));
    assert.ok(!formatDiscovery(result, 'x').some((l) => l.includes('Candidate heuristics')));
  });

  test('shell families taking a large share become sub-category candidates', () => {
    const bash = (sessionId: string, command: string, toolCategory: NormalizedEvent['toolCategory'] = 'shell') =>
      ev(sessionId, 't', 0, { kind: 'tool_call', toolName: 'Bash', toolCategory, target: command });
    const events = [
      ...Array.from({ length: 10 }, (_, i) => bash(i % 2 ? 's1' : 's2', `curl -s https://example.com/${i}`)),
      ...Array.from({ length: 5 }, (_, i) => bash(i % 2 ? 's1' : 's2', `FOO=1 npm install pkg${i}`)),
      ...Array.from({ length: 4 }, () => bash('s1', 'ls -la')),
      bash('s1', 'echo hi'),
      bash('s1', 'npm test', 'tests-builds'),
    ];
    const shell = discoverShellCategories(events);
    assert.strictEqual(shell.shellCalls, 20);
    assert.deepStrictEqual(
      shell.candidates.map((c) => [c.category.id, c.category.match, c.share]),
      [
        ['discovery:shell/curl', ['curl'], 0.5],
        ['discovery:shell/npm-install', ['npm install'], 0.25],
      ]
    );
    assert.ok(Math.abs(shell.leftShare - 0.25) < 1e-9);
  });

  test('the report names heuristics and command families, never targets', () => {
    const lines = formatDiscovery(discover(history(['s1', 's2', 's3']), opts), 'test').join('\n');
    assert.ok(lines.includes('discovery:reads-one-file: turns with 6 or more reads of one file'));
    assert.ok(!lines.includes('secret/path.ts'));
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
