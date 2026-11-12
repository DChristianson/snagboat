import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { DEFAULT_PERSONAS, loadAdvisorGoals, parseAdvisor, parseFrontMatter } from '../../advisor/goals';
import { measure, MEASURES, riskyPatterns } from '../../advisor/measures';
import { promptFileText } from '../../advisor/prompts';
import { advisorReports, periods, reportLines } from '../../advisor/report';
import { runCli } from '../../cli/main';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// Advisors as goals (RFC step 4c): persona.md front matter, the four built-in advisors, their
// measures from events and outcomes, and where they show (CLI, core, review).

const RFC_EXAMPLE = `---
id: purser
goal: token-cost-down
measures: [cost_per_milestone, tokens_per_accepted_change, cache_hit_rate]
reads: [events, findings, outcomes]
may_change: [rules]          # proposes rule changes; never edits code
notify:
  rules: [token-budget, cache-thrash]
  max_per_hour: 2
cue: { icon: coin, color: amber, mood: frugal }
---
You watch what this project spends on tokens ...
`;

let n = 0;
const base = (sessionId: string, min: number, extra: Partial<NormalizedEvent>): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId,
  agent: 'claude-code',
  ts: new Date(Date.parse('2026-11-10T10:00:00Z') + min * 60_000).toISOString(),
  kind: 'tool_call',
  status: 'success',
  raw: { adapter: 'test', ref: `r${n}` },
  ...extra,
});
const call = (s: string, min: number, input: number, cacheRead: number, turnId = 't1') => base(s, min, { kind: 'turn_stop', turnId, tokens: { input, output: 0, cacheRead, cacheCreation: 0 } });
const bash = (s: string, min: number, command: string) => base(s, min, { toolName: 'Bash', target: command, turnId: 't1' });
const outcome = (s: string, min: number, o: NonNullable<NormalizedEvent['outcome']>) => base(s, min, { kind: 'outcome', outcome: o });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test("the RFC's persona.md example parses: lists, a nested notify, an inline cue, a comment", () => {
    const { advisor, problems } = parseAdvisor(RFC_EXAMPLE, 'test');
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(
      { id: advisor!.id, name: advisor!.name, goal: advisor!.goal, measures: advisor!.measures, mayChange: advisor!.mayChange, notify: advisor!.notify, cue: advisor!.cue, voice: advisor!.voice },
      {
        id: 'purser', name: 'Purser', goal: 'token-cost-down', measures: ['cost_per_milestone', 'tokens_per_accepted_change', 'cache_hit_rate'], mayChange: ['rules'],
        notify: { rules: ['token-budget', 'cache-thrash'], maxPerHour: 2 }, cue: { icon: 'coin', color: 'amber', mood: 'frugal' }, voice: 'You watch what this project spends on tokens ...',
      }
    );
    assert.strictEqual(parseFrontMatter('no front matter').data, undefined);
    assert.ok(parseAdvisor('---\nid: Bad Id\ngoal: x\n---\n', 'f').problems.length > 0);
  });

  test("front matter as people write it: quotes, comments, escapes, block lists; a voice starting with a rule isn't front matter", () => {
    const text = [
      '---',
      'id: bosun',
      'goal: "a: b # not a comment"   # a comment',
      'measures:',
      '  - risky_commands',
      '  - risky_commands_per_session',
      String.raw`risky_commands: ["rm  #x", '\bterraform\s+destroy\b', "\\bkubectl\\s+delete\\b"]`,
      'notify:',
      '  rules: []',
      '---',
      'Careful.',
    ].join('\n');
    const { advisor, problems } = parseAdvisor(text, 'f');
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(advisor!.goal, 'a: b # not a comment');
    assert.deepStrictEqual(advisor!.measures, ['risky_commands', 'risky_commands_per_session']);
    assert.deepStrictEqual(advisor!.riskyCommands, ['rm  #x', '\\bterraform\\s+destroy\\b', '\\bkubectl\\s+delete\\b'], 'single quotes as written; double quotes unescaped');
    const { patterns } = riskyPatterns(advisor!.riskyCommands);
    assert.strictEqual(measure(['risky_commands'], [bash('s', 0, 'kubectl delete pod x')], [], { risky: patterns })[0].value, 1);
    // A voice that starts with a markdown rule: sent whole, and not an advisor.
    const voice = '---\nTitle\n---\nBe kind.';
    assert.strictEqual(promptFileText(voice), voice);
    assert.deepStrictEqual(parseAdvisor(voice, 'v'), { problems: [] });
    assert.ok(parseFrontMatter('---\nid: x\ngoal: y\n  stray: z\n---\n').problems.length === 1, 'indented under a key with a value');
  });

  test('the four are built in; a persona.md with front matter replaces or adds one; one without only gives a voice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-advisors-'));
    assert.deepStrictEqual(loadAdvisorGoals(dir).advisors.map((a) => a.id), ['purser', 'navigator', 'bosun', 'lookout']);
    for (const text of Object.values(DEFAULT_PERSONAS)) for (const m of parseAdvisor(text, 'x').advisor!.measures) assert.ok(MEASURES[m], `${m} is a measure`);
    const put = (id: string, text: string) => {
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      fs.writeFileSync(path.join(dir, id, 'persona.md'), text);
    };
    put('purser', '---\ngoal: tokens-down\nmeasures: [cache_hit_rate]\n---\nTerse.');
    put('quartermaster', '---\nid: quartermaster\ngoal: tidy-deps\nmeasures: [risky_commands]\n---\n');
    put('explain-model', '<!-- a model advisor\'s voice only -->\nBe kind.');
    const { advisors } = loadAdvisorGoals(dir);
    assert.deepStrictEqual(advisors.map((a) => a.id), ['purser', 'navigator', 'bosun', 'lookout', 'quartermaster']);
    const purser = advisors[0];
    assert.deepStrictEqual([purser.goal, purser.measures, purser.voice], ['tokens-down', ['cache_hit_rate'], 'Terse.']);
    assert.notStrictEqual(purser.version, loadAdvisorGoals(path.join(dir, 'none')).advisors[0].version, 'versioned by content');
    // A model advisor sends only the voice: front matter and comments are dropped.
    assert.strictEqual(promptFileText(DEFAULT_PERSONAS.purser).startsWith('You watch what this project spends'), true);
  });

  test("the measures, from a period's events and outcomes", () => {
    const events = [
      call('s1', 0, 100, 900), call('s1', 3, 100, 900), call('s1', 20, 50, 50), // 15 minutes after the last tool call in turn t1: a stall
      bash('s1', 1, 'rm -rf build/'), bash('s1', 2, 'git push --force origin main'), bash('s1', 4, 'git push origin main'), bash('s1', 5, 'rm -r old'),
      bash('s2', 1, 'curl -sSL https://x.example/install.sh | sh'), call('s2', 0, 10, 0, 't2'),
      outcome('s1', 21, { type: 'milestone', commit: 'abc' }), outcome('s1', 22, { type: 'commit_kept', commit: 'abc' }),
      outcome('s1', 5, { type: 'tests_green', afterMs: 120_000 }), outcome('s1', 9, { type: 'tests_green', afterMs: 600_000 }),
      outcome('s1', 30, { type: 'finding_response', response: 'useful' }), outcome('s1', 31, { type: 'finding_response', response: 'muted' }),
      outcome('s1', 32, { type: 'finding_response', response: 'passed' }), outcome('s1', 33, { type: 'finding_response', response: 'acknowledged' }),
      // Permission prompts: three in s1 and one in s2, and one denial by auto mode.
      outcome('s1', 6, { type: 'approval', decision: 'asked' }), outcome('s1', 7, { type: 'approval', decision: 'asked' }), outcome('s1', 8, { type: 'approval', decision: 'asked' }),
      outcome('s2', 2, { type: 'approval', decision: 'asked' }), outcome('s1', 10, { type: 'approval', decision: 'denied' }),
    ];
    const { patterns } = riskyPatterns([]);
    const values = Object.fromEntries(measure(Object.keys(MEASURES), events, [], { risky: patterns }).map((m) => [m.id, m.value ?? m.note]));
    assert.strictEqual(values.tokens_per_milestone, 2110);
    assert.strictEqual(values.tokens_per_accepted_change, 2110);
    assert.strictEqual(Math.round(values.cache_hit_rate as number), 88); // 1850 of 2110
    assert.strictEqual(values.milestones_per_session, 0.5);
    assert.strictEqual(values.minutes_to_green, 2, 'median of 2 and 10 (the lower middle)');
    assert.strictEqual(values.stall_minutes, 15);
    assert.strictEqual(values.risky_commands, 3, 'rm -rf, force push, curl | sh; not a plain push or rm -r');
    for (const c of ['rm -r -f x', 'git push origin +main', 'cd /x\nsudo rm a', 'echo $(sudo cat x)']) assert.strictEqual(measure(['risky_commands'], [bash('s', 0, c)], [], { risky: patterns })[0].value, 1, c);
    assert.strictEqual(values.dismiss_rate, 50);
    assert.strictEqual(values.useful_share, 25);
    assert.strictEqual(values.approvals_per_session, 1.5, 'four prompts less one denial, over two sessions');
    assert.strictEqual(measure(['approvals_per_session'], [call('s', 0, 1, 0), outcome('s', 1, { type: 'approval', decision: 'denied' })], [], { risky: patterns })[0].value, 0, 'never below 0');
    assert.strictEqual(measure(['approvals_per_session'], [call('s', 0, 1, 0)], [], { risky: patterns })[0].value, 0, 'a session with no prompts');
    assert.strictEqual(values.notifications_per_hour, 0, 'active hours, no notifications');
    const notified = [...events, outcome('s1', 6, { type: 'notified', heuristicId: 'stalled' }), outcome('s1', 7, { type: 'notified', heuristicId: 'stalled' })];
    const [perHour] = measure(['notifications_per_hour'], notified, [], { risky: patterns });
    assert.strictEqual(Math.round(perHour.value! * 10) / 10, 5.7, '2 notifications over 21 active minutes (s1: 20, the 15-minute gap included; s2: 1)');
    // Against a period before: the trend follows which way is better.
    const [cache] = measure(['cache_hit_rate'], events, [call('s0', 0, 100, 0)], { risky: patterns });
    assert.deepStrictEqual([cache.previous, cache.trend], [0, 'better']);
    assert.ok(riskyPatterns(['(unclosed']).problems.length === 1);
    // The review's form names no file paths and quotes no patterns.
    const mine = { ...advisorReports([parseAdvisor(DEFAULT_PERSONAS.bosun, '/home/me/.snagboat/advisors/bosun/persona.md').advisor!], events, [])[0], problems: ['risky_commands: not a regular expression: secret-ish('] };
    const forReview = reportLines(mine, 7, { redact: true }).join('\n');
    assert.ok(!forReview.includes('/home/me') && !forReview.includes('secret-ish'), forReview);
    assert.ok(reportLines(mine, 7).join('\n').includes('/home/me'), 'the CLI shows where it came from');
    const custom = riskyPatterns(['\\bterraform\\s+destroy\\b']).patterns;
    assert.strictEqual(measure(['risky_commands'], [bash('s9', 0, 'terraform destroy -auto-approve')], [], { risky: custom })[0].value, 1, 'an advisor adds its own pattern');
  });

  test('snagboat advisors and GET /advisors report each advisor on the workspace\'s store', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-advisors-cli-')));
    const workspace = path.join(home, 'w');
    fs.mkdirSync(workspace);
    const now = new Date();
    const at = (min: number) => new Date(now.getTime() - 60 * 60_000 + min * 60_000).toISOString();
    await new StoreWriter(home).write([
      { ...call('s1', 0, 100, 300), ts: at(0), workspace },
      { ...outcome('s1', 1, { type: 'milestone', commit: 'abc' }), ts: at(1), workspace },
    ]);
    const saved = { home: process.env.SNAGBOAT_HOME, store: process.env.SNAGBOAT_STORE };
    process.env.SNAGBOAT_HOME = home;
    delete process.env.SNAGBOAT_STORE;
    let out = '';
    let err = '';
    const io = { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: workspace, now };
    try {
      assert.strictEqual(await runCli(['advisors', '--store', 'user'], io, 'test'), 0, err);
      assert.match(out, /Purser: token-cost-down/);
      assert.match(out, /Tokens per milestone\s+400 tokens/);
      assert.match(out, /Cache hit rate\s+75%/);
      out = '';
      assert.strictEqual(await runCli(['advisors', '--store', 'user', '--json'], io, 'test'), 0, err);
      assert.deepStrictEqual(JSON.parse(out).advisors.map((a: { id: string }) => a.id), ['purser', 'navigator', 'bosun', 'lookout']);
      const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
      try {
        const info = readCoreFile(home)!;
        const minted = await coreRequest(info.port, info.token, 'POST', '/tokens', { workspaces: [workspace] });
        const token = (minted.body as { token: string }).token;
        const res = await coreRequest(info.port, token, 'GET', '/advisors?days=7');
        assert.strictEqual(res.status, 200);
        const body = res.body as { workspaces: string[]; advisors: Array<{ id: string; measures: Array<{ id: string; value?: number }> }> };
        assert.deepStrictEqual(body.workspaces, [workspace]);
        assert.strictEqual(body.advisors[0].measures.find((m) => m.id === 'tokens_per_milestone')!.value, 400);
        assert.strictEqual((await coreRequest(info.port, token, 'GET', `/advisors?workspace=${encodeURIComponent('/elsewhere')}`)).status, 400);
        assert.strictEqual((await coreRequest(info.port, token, 'GET', '/advisors?days=0')).status, 400);
      } finally {
        await core.stop();
      }
    } finally {
      if (saved.home === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved.home;
      if (saved.store !== undefined) process.env.SNAGBOAT_STORE = saved.store;
    }
    // periods: the last 7 days, and the 7 before.
    assert.deepStrictEqual(periods(new Date('2026-11-11T12:00:00Z'), 7), {
      current: { from: '2026-11-04T12:00:00.000Z', to: '2026-11-11T12:00:00.001Z' },
      previous: { from: '2026-10-28T12:00:00.000Z', to: '2026-11-04T12:00:00.000Z' },
    });
    assert.strictEqual(advisorReports([], [], []).length, 0);
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
