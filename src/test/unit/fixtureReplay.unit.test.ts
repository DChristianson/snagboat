import * as assert from 'assert';
import * as path from 'path';
import { builtInHeuristics } from '../../heuristics/builtIns';
import { replay, sessionEvents } from '../../scripts/replayHeuristics';

// Replays the redacted real transcript through every built-in heuristic, the
// same way `npm run replay:heuristics` does, and pins what fires and when
// (minutes from the session's first event; an episode still open at the end
// ends at 25). A change that alters these on purpose updates them here.
//
// The fixture is an ordinary 25-minute session: 5 prompts, 17 model calls,
// 21 tool calls, no tool failures, no hedging replies, no reported context
// limit or compaction. So backtracking, verbal-hedge, context-pressure,
// cache-thrash, and tool-churn can't fire on it at any setting; their own
// unit tests cover detection.

const FIXTURE = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl');

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const events = sessionEvents(FIXTURE);
  const fired = (settings: Record<string, Record<string, unknown>>) => replay(events, settings).map((e) => [e.heuristic, e.severity, e.startMin, e.endMin]);

  test('the fixture normalizes to the session it was captured from', () => {
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    assert.deepStrictEqual([count('user_prompt'), count('turn_stop'), count('tool_call')], [5, 17, 21]);
  });

  test('with default settings, an ordinary session raises no findings', () => {
    assert.deepStrictEqual(fired({}), []);
  });

  test('stalled fires at the gaps longer than its threshold', () => {
    assert.deepStrictEqual(fired({ stalled: { minutes: 1 } }), [
      ['stalled', 'warn', 2.8, 3.8],
      ['stalled', 'warn', 10.4, 18.9],
    ]);
  });

  test('token-budget fires once the session passes its budget, and stays open', () => {
    assert.deepStrictEqual(fired({ 'token-budget': { session: 500_000 } }), [['token-budget', 'warn', 8.3, 25]]);
  });

  test('runaway-turn fires on the turns with the most model and tool calls', () => {
    assert.deepStrictEqual(fired({ 'runaway-turn': { maxModelCalls: 4, maxToolCalls: 4 } }), [
      ['runaway-turn', 'warn', 0.1, 4.5],
      ['runaway-turn', 'warn', 19.1, 19.1],
      ['runaway-turn', 'warn', 24.9, 25.1],
    ]);
  });

  test('the heuristics this fixture cannot exercise stay silent even at their loosest', () => {
    const loose = {
      backtracking: { minFailures: 1, minEdits: 1 },
      'verbal-hedge': { minTurns: 1 },
      'context-pressure': { percent: 1 },
      'cache-thrash': { minTokens: 1, minCalls: 1 },
      'tool-churn': { minCalls: 3, minShare: 0.3 },
    };
    assert.deepStrictEqual(fired(loose), []);
  });

  test('every built-in heuristic is accounted for above', () => {
    const covered = ['stalled', 'token-budget', 'runaway-turn', 'backtracking', 'verbal-hedge', 'context-pressure', 'cache-thrash', 'tool-churn'];
    assert.deepStrictEqual(builtInHeuristics().map((h) => h.id).sort(), covered.sort(), 'a new heuristic should be added to this replay');
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
