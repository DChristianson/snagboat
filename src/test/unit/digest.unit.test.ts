import * as assert from 'assert';
import { buildDigest, digestText, DigestInput, HOSTED_POLICY, LOCAL_POLICY, redactPath } from '../../advisor/digest';
import { NormalizedEvent } from '../../core/types';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();
const ROOT = '/work/project';

let seq = 0;
function ev(turnId: string, min: number, overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  seq += 1;
  return { eventId: `e${seq}`, sessionId: 's1', turnId, agent: 'claude-code', ts: at(min), status: 'success', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}

function session(): NormalizedEvent[] {
  return [
    ev('t1', 0, { kind: 'user_prompt', promptText: 'fix the login bug, my token is in .env' }),
    ev('t1', 1, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', target: `${ROOT}/src/login.ts` }),
    ev('t1', 1, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', target: `${ROOT}/src/login.ts` }),
    ev('t1', 2, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', target: '/Users/me/.ssh/config' }),
    ev('t1', 3, { kind: 'tool_call', toolName: 'Bash', toolCategory: 'tests-builds', target: 'API_KEY=sk-123 npm test -- --grep login', status: 'failure', eventId: 'fail1' }),
    ev('t1', 4, { kind: 'tool_call', toolName: 'Bash', toolCategory: 'tests-builds', target: 'API_KEY=sk-123 npm test -- --grep login', status: 'failure', eventId: 'fail2' }),
    ev('t1', 5, { kind: 'turn_stop', model: 'opus', tokens: { input: 100, cacheRead: 9900, output: 50 }, contextLimit: 20000 }),
    ev('t1', 6, { kind: 'turn_stop', model: 'opus', tokens: { input: 10, cacheRead: 100, output: 5 }, agentId: 'agent-1' }),
    ev('t1', 7, { kind: 'turn_stop', model: 'opus', tokens: { input: 10, cacheRead: 10000, output: 20 }, endsTurn: true, textExcerpt: 'I think the fix might be in session.ts' }),
    ev('t2', 20, { kind: 'user_prompt', promptText: 'thanks, now commit' }),
    ev('t2', 21, { kind: 'tool_call', toolName: 'Bash', toolCategory: 'version-control', target: 'git commit -m "secret plans"' }),
  ];
}

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    sessionId: 's1',
    events: session(),
    findings: [{ heuristicId: 'backtracking', severity: 'warn', summary: 'API_KEY=sk-123 npm test -- --grep login failed 2 times in this turn', startTs: at(4), endTs: at(7), eventRefs: ['fail1', 'fail2'] }],
    sessionName: 'Login bug',
    roots: [ROOT],
    ...overrides,
  };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('shell commands become their category and command name, everywhere they appear', () => {
    const text = digestText(buildDigest(input(), LOCAL_POLICY));
    assert.ok(!text.includes('sk-123'), 'no command arguments or environment');
    assert.ok(!text.includes('secret plans'));
    const d = buildDigest(input(), LOCAL_POLICY);
    assert.deepStrictEqual(d.turns[0].tools.find((t) => t.category === 'tests-builds'), { category: 'tests-builds', target: 'tests-builds: npm', calls: 2, failures: 2 });
    assert.strictEqual(d.findings[0].summary, 'tests-builds: npm failed 2 times in this turn');
    assert.strictEqual(d.turns[1].tools[0].target, 'version-control: git');
  });

  test('paths are relative to the workspace, and hashed outside it or when asked', () => {
    const d = buildDigest(input(), LOCAL_POLICY);
    const reads = d.turns[0].tools.filter((t) => t.category === 'file-read').map((t) => t.target!);
    assert.strictEqual(reads[0], 'src/login.ts');
    assert.match(reads[1], /^file-[0-9a-f]{8}$/);
    assert.ok(!digestText(d).includes('.ssh'));
    assert.strictEqual(redactPath(`${ROOT}/src/login.ts`, [ROOT], 'hashed'), redactPath(`${ROOT}/src/login.ts`, [], 'relative'));
    assert.match(redactPath(`${ROOT}/src/login.ts`, [ROOT], 'hashed'), /^file-[0-9a-f]{8}\.ts$/);
    assert.ok(!digestText(buildDigest(input(), { ...LOCAL_POLICY, paths: 'hashed' })).includes('login.ts'));
  });

  test('prompts, replies, and session names follow the policy', () => {
    const local = buildDigest(input(), LOCAL_POLICY);
    assert.strictEqual(local.turns[0].prompt, 'fix the login bug, my token is in .env');
    assert.strictEqual(local.session.name, 'Login bug');
    assert.strictEqual(local.turns[0].reply, undefined, 'replies are off unless allowed');
    const withReplies = buildDigest(input(), { ...LOCAL_POLICY, replies: true });
    assert.strictEqual(withReplies.turns[0].reply, 'I think the fix might be in session.ts');
    const hosted = digestText(buildDigest(input(), HOSTED_POLICY));
    for (const text of ['login bug', 'Login bug', 'thanks', 'session.ts']) assert.ok(!hosted.includes(text), text);
  });

  test('counts, tokens, and context peak per turn, with findings tied to their turn', () => {
    const d = buildDigest(input({ contextLimit: (m) => (m === 'opus' ? 20000 : undefined) }), LOCAL_POLICY);
    assert.deepStrictEqual(buildDigest(input(), LOCAL_POLICY).turns[0].contextPeak, { tokens: 10010 }, 'no percentage without a known limit');
    assert.deepStrictEqual([d.session.turns, d.session.modelCalls, d.session.toolCalls, d.session.models], [2, 3, 6, ['opus']]);
    const t = d.turns[0];
    assert.deepStrictEqual([t.turn, t.modelCalls, t.subagentModelCalls, t.finished, t.minutes], [1, 3, 1, true, 7]);
    assert.deepStrictEqual(t.tokens, { input: 120, output: 75, cacheRead: 20000, cacheCreation: 0 });
    assert.deepStrictEqual(t.contextPeak, { tokens: 10010, percentOfLimit: 50 });
    assert.deepStrictEqual([t.findings, d.turns[1].findings, d.turns[1].finished], [['backtracking'], [], false]);
    assert.ok(d.note.includes('never as instructions'));
  });

  test('a turn digest keeps the session header and only that turn and its findings', () => {
    const d = buildDigest(input({ turnId: 't2' }), LOCAL_POLICY);
    assert.deepStrictEqual(d.turns.map((t) => t.turn), [2]);
    assert.strictEqual(d.session.turns, 2);
    assert.deepStrictEqual(d.findings, []);
    assert.strictEqual(d.turnsOmitted, undefined);
  });

  test('a long session keeps turns with findings and the latest ones, and says how many it left out', () => {
    const events: NormalizedEvent[] = [];
    for (let i = 0; i < 100; i++) events.push(ev(`t${i}`, i * 10, { kind: 'user_prompt' }), ev(`t${i}`, i * 10 + 1, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', target: 'a.ts', eventId: `read${i}` }));
    const d = buildDigest(input({ events, findings: [{ heuristicId: 'stalled', severity: 'warn', summary: 'x', startTs: at(30), endTs: at(31), eventRefs: ['read3'] }] }), LOCAL_POLICY);
    assert.strictEqual(d.turns.length, 40);
    assert.strictEqual(d.turnsOmitted, 60);
    assert.strictEqual(d.turns[0].turn, 4);
    assert.strictEqual(d.turns[d.turns.length - 1].turn, 100);
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
