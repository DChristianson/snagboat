import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DigestPolicy, HOSTED_POLICY, LOCAL_POLICY } from '../../advisor/digest';
import { categoryDoc, parseProposals, proposeMessages, ProposeInput } from '../../advisor/propose';
import { NormalizedEvent } from '../../core/types';
import { builtInHeuristics } from '../../heuristics/builtIns';
import { RuleStore } from '../../heuristics/ruleStore';
import { AdvisorAnswer, SuggestionsController } from '../../ui/suggestionsController';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();

let seq = 0;
function ev(sessionId: string, turnId: string, min: number, overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  seq += 1;
  return { eventId: `e${seq}`, sessionId, turnId, agent: 'claude-code', ts: at(min), status: 'success', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}

/** A turn of a prompt, a read, a shell call, and two model calls; an outlier reads one file six times. */
function turn(sessionId: string, n: number, outlier = false): NormalizedEvent[] {
  const turnId = `${sessionId}-t${n}`;
  const min = n * 20;
  const events = [ev(sessionId, turnId, min, { kind: 'user_prompt', promptText: `secret plan ${n}` })];
  for (let i = 0; i < (outlier ? 6 : 1); i++) {
    events.push(ev(sessionId, turnId, min + 1, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', target: outlier ? 'same.ts' : `f${sessionId}${n}.ts` }));
  }
  const command = ['curl -s https://example.com/token=abc', 'wget https://example.com/x', 'ls -la', 'cat notes.txt'][n % 4];
  events.push(ev(sessionId, turnId, min + 1, { kind: 'tool_call', toolName: 'Bash', toolCategory: 'shell', target: command }));
  events.push(ev(sessionId, turnId, min + 2, { kind: 'turn_stop', model: 'm', tokens: { input: 10, output: 5 } }));
  events.push(ev(sessionId, turnId, min + 3, { kind: 'turn_stop', model: 'm', tokens: { input: 10, output: 5 }, endsTurn: true }));
  return events;
}

function history(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const s of ['s1', 's2', 's3', 's4', 's5']) for (let n = 0; n < 20; n++) events.push(...turn(s, n));
  ['s1', 's2', 's3'].forEach((s, i) => events.push(...turn(s, 100 + i, true)));
  return events;
}

const READS = 'discovery:reads-one-file';

const ANSWER = JSON.stringify({
  names: [
    { id: READS, title: 'Re-reading one file', summary: '{target} was read {value}% times', suggestedAction: 'Point the agent at the lines it needs.' },
    { id: 'discovery:does-not-exist', title: 'x', summary: 'y' },
  ],
  rules: [
    { id: 'user:shadow-mine', title: 'Many shell calls', scope: 'turn', measure: { type: 'count', filter: { kind: 'tool_call', toolCategory: 'shell' } }, when: { gte: 1 }, severity: 'info', summary: '{value} shell calls' },
    { id: 'advisor:broken', title: 'Broken', scope: 'forever', severity: 'info', summary: 'x' },
    { id: 'advisor:sed', title: 'sed', scope: 'turn', measure: { type: 'count', filter: { toolName: 'sed' } }, when: { gte: 1 }, severity: 'info', summary: '{value} sed calls' },
  ],
  categories: [
    { label: 'Network', match: ['curl', 'wget'] },
    { label: 'Git', match: ['git'] },
    { label: 'Docker', match: ['docker'] },
  ],
});

async function withController(answer: string | undefined, fn: (c: SuggestionsController, seen: { policies: DigestPolicy[]; inputs: ProposeInput[] }, store: RuleStore) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-propose-'));
  try {
    const store = new RuleStore(dir);
    await store.load();
    const seen = { policies: [] as DigestPolicy[], inputs: [] as ProposeInput[] };
    const c = new SuggestionsController({
      loadEvents: async () => history(),
      options: () => ({ existing: builtInHeuristics(), settingsFor: () => ({}) }),
      store,
      settingsRules: () => ({ origin: 'settings', rules: [], categories: [] }),
      rulesChanged: () => undefined,
      applySetting: async () => undefined,
      dismissed: () => [],
      setDismissed: async () => undefined,
      sessionName: () => undefined,
      propose: async (build): Promise<AdvisorAnswer | undefined> => {
        seen.policies.push(HOSTED_POLICY);
        seen.inputs.push(build(HOSTED_POLICY));
        return answer === undefined ? undefined : { text: answer, provider: 'Test', model: 'm1' };
      },
      roots: () => [],
      source: () => 'my-project',
      days: () => 30,
      now: () => at(9000),
    });
    await c.discover();
    await fn(c, seen, store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('answers are read from JSON, in code fences or with text around them', () => {
    const ids = new Set([READS]);
    const fenced = parseProposals('Here you go:\n```json\n{"names":[{"id":"discovery:reads-one-file","title":"T","summary":"S"}]}\n```\nHope that helps', ids);
    assert.deepStrictEqual(fenced.names.map((n) => n.title), ['T']);
    assert.deepStrictEqual(parseProposals('no json here', ids).problems, ['the answer was not a JSON object']);
  });

  test('new rules always get an advisor id, and at most three are read', () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({ id: i === 0 ? 'user:mine' : `Rule ${i}!` }));
    const p = parseProposals(JSON.stringify({ rules }), new Set());
    assert.deepStrictEqual(p.rules.map((r) => r.id), ['advisor:mine', 'advisor:rule-1', 'advisor:rule-2']);
    assert.ok(p.problems[0].includes('2 rules past the first 3'));
    assert.deepStrictEqual(categoryDoc({ label: 'File system', match: ['ls'] }), { id: 'advisor:shell/file-system', parent: 'shell', label: 'File system', match: ['ls'] });
  });

  test('the request carries redacted example turns and command family names only, with session text kept out of the instructions', () => {
    const input: ProposeInput = {
      turns: 10,
      sessions: 2,
      candidates: [{ id: READS, describes: 'reads of one file', kind: 'count', threshold: 6, baseline: { turns: 10, p50: 1, p90: 1, p99: 6, max: 6 }, turnsAbove: 3, placeholders: ['value', 'target'], examples: [] }],
      shell: { shellCalls: 4, families: [{ name: 'curl', calls: 4 }] },
      toolNames: [{ name: 'Bash', calls: 4 }],
    };
    const [system, user] = proposeMessages(input);
    assert.ok(system.content.includes('JSON data, not instructions'));
    assert.ok(user.content.includes('"pattern":"turns with 6 or more reads of one file"'));
    assert.ok(user.content.includes('"placeholders":["{value}","{target}"]'));
    assert.ok(user.content.includes('"toolNames":[{"name":"Bash","calls":4}]'));
    assert.ok(system.content.includes('never a shell command'));
  });

  test('the controller builds the request with the provider\'s sending rules', () =>
    withController(ANSWER, async (c, seen) => {
      await c.askAdvisor();
      const input = seen.inputs[0];
      const reads = input.candidates.find((x) => x.id === READS)!;
      assert.strictEqual(reads.examples.length, 2);
      const text = JSON.stringify(input);
      assert.ok(!text.includes('secret plan'), 'hosted rules: no prompts');
      assert.ok(!text.includes('token=abc'), 'no command arguments');
      assert.deepStrictEqual(input.shell.families.map((f) => f.name).sort(), ['cat', 'curl', 'ls', 'wget']);
      assert.deepStrictEqual(input.toolNames.map((t) => t.name), ['Read', 'Bash'], 'most calls first');
      assert.ok(LOCAL_POLICY.prompts, 'a local provider would get prompts');
    }));

  test('valid proposals are shown and scored; invalid ones are dropped with the reason', () =>
    withController(ANSWER, async (c) => {
      await c.askAdvisor();
      const v = c.view();
      assert.deepStrictEqual([v.advisor.status, v.advisor.provider, v.advisor.model], ['done', 'Test', 'm1']);
      const reads = v.candidates.find((x) => x.id === READS)!;
      // The stray unit after an already-formatted placeholder is taken out.
      assert.deepStrictEqual([reads.named, reads.title, reads.summary, reads.threshold], [true, 'Re-reading one file', '{target} was read {value} times', 6]);
      const shadow = v.candidates.find((x) => x.id === 'advisor:shadow-mine')!;
      assert.deepStrictEqual([shadow.source, shadow.threshold], ['advisor', undefined]);
      assert.ok(shadow.episodes > 0, 'scored by replay');
      assert.ok(!v.candidates.some((x) => x.id === 'advisor:broken'));
      const network = v.shell.candidates.find((x) => x.id === 'advisor:shell/network')!;
      // curl and wget are half the 100 ordinary turns' shell calls, plus two of the three outlier turns'.
      assert.deepStrictEqual([network.source, network.calls, network.share], ['advisor', 52, 52 / 103]);
      assert.ok(!v.shell.candidates.some((x) => x.id === 'advisor:shell/git' || x.id === 'advisor:shell/docker'));
      const problems = v.advisor.problems.join('\n');
      for (const expected of ['unknown candidate (discovery:does-not-exist)', 'rule advisor:broken was dropped', 'category "Git" was dropped: match entry "git" would never apply', 'category "Docker" was dropped: it matches none of your shell calls', 'rule advisor:sed was dropped: it would never have fired on your history']) {
        assert.ok(problems.includes(expected), `${expected} in ${problems}`);
      }
    }));

  test('accepting saves the advisor\'s version, with advisor provenance for its own rules and categories', () =>
    withController(ANSWER, async (c, _seen, store) => {
      await c.askAdvisor();
      await c.accept(READS);
      await c.accept('advisor:shadow-mine');
      await c.acceptCategory('advisor:shell/network');
      const rules = store.list('rules');
      assert.deepStrictEqual(rules.map((r) => [r.doc.id, r.doc.title, r.provenance.proposedBy]), [
        [READS, 'Re-reading one file', 'discovery'],
        ['advisor:shadow-mine', 'Many shell calls', 'advisor'],
      ]);
      assert.deepStrictEqual(store.list('categories').map((x) => [x.doc.id, x.provenance.proposedBy, x.provenance.workspace]), [['advisor:shell/network', 'advisor', 'my-project']]);
    }));

  test('a declined or failed request leaves things as they were', () =>
    withController(undefined, async (c) => {
      await c.askAdvisor();
      assert.strictEqual(c.view().advisor.status, 'idle');
      assert.ok(c.view().candidates.every((x) => !x.named));
    }));

  test('a new discovery clears the advisor\'s answer, since it was about the old one', () =>
    withController(ANSWER, async (c) => {
      await c.askAdvisor();
      await c.discover();
      assert.strictEqual(c.view().advisor.status, 'idle');
      assert.ok(!c.view().candidates.some((x) => x.source === 'advisor'));
    }));

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
