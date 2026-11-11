import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { EventLog } from '../../core/eventLog';
import { GitOutcomesJob } from '../../core/service/gitOutcomesJob';
import { StoreWriter } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';
import { gitOutcomes, GitRunner, runGit } from '../../outcomes/gitOutcomes';

// Git outcomes (RFC step 4b): commits made in a session, kept or reverted at 7 days, their
// lines' survival at 7 and 30 days, and milestones, from a real repository with dated commits.

const DAY = 86_400_000;
const MIN = 60_000;

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-git-')));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const git = (args: string[], at?: number) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', ...(at ? { GIT_AUTHOR_DATE: `@${Math.floor(at / 1000)}`, GIT_COMMITTER_DATE: `@${Math.floor(at / 1000)}` } : {}) },
    }).toString();
  git(['init', '-q', '-b', 'main']);
  const commit = (at: number, files: Record<string, string>, message: string) => {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], at);
    return git(['rev-parse', 'HEAD']).trim();
  };
  return { root, dir, git, commit };
}

let n = 0;
const ev = (sessionId: string, at: number, extra: Partial<NormalizedEvent>): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId,
  agent: 'claude-code',
  ts: new Date(at).toISOString(),
  kind: 'tool_call',
  status: 'success',
  raw: { adapter: 'test', ref: `r${n}` },
  ...extra,
});
const edit = (sessionId: string, at: number, file: string) => ev(sessionId, at, { toolName: 'Edit', toolCategory: 'file-edit', target: file });
const testRun = (sessionId: string, at: number, passed: boolean) => ev(sessionId, at, { toolName: 'Bash', toolCategory: 'tests-builds', target: 'npm test', status: passed ? 'success' : 'failure' });
const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join('\n') + '\n';

/** A runner that counts git commands, around the real one. */
function counting(): { git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  return { calls, git: (args, cwd) => (calls.push(args[0]), runGit(args, cwd)) };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a session\'s commits: a milestone, kept or reverted at 7 days, and their lines\' survival at 7 and 30', async () => {
    const { dir, commit } = repo();
    const t0 = Date.now() - 40 * DAY;
    commit(t0 - DAY, { 'a.ts': '', 'b.ts': '' }, 'start');
    // Session s1: edits a.ts, tests fail then pass, commits 10 lines; a later commit rewrites 3 of them.
    const events = [edit('s1', t0, path.join(dir, 'a.ts')), testRun('s1', t0 + 5 * MIN, false), testRun('s1', t0 + 10 * MIN, true)];
    const c1 = commit(t0 + 15 * MIN, { 'a.ts': lines(10, 'mine') }, 'feature');
    commit(t0 + DAY, { 'a.ts': lines(3, 'theirs') + lines(10, 'mine').split('\n').slice(3).join('\n') }, 'tweak');
    // Session s2: edits b.ts, no tests, commits; reverted the next day.
    events.push(edit('s2', t0 + 2 * DAY, path.join(dir, 'b.ts')));
    const c3 = commit(t0 + 2 * DAY + 5 * MIN, { 'b.ts': lines(4, 'risky') }, 'risky change');
    commit(t0 + 3 * DAY, { 'b.ts': '' }, `Revert "risky change"\n\nThis reverts commit ${c3}.`);
    // A commit no session made.
    commit(t0 + 20 * DAY, { 'c.ts': 'x\n' }, 'unrelated');

    const out = await gitOutcomes({ repo: dir, events, now: Date.now(), workspace: dir });
    const by = (type: string, sha: string) => out.filter((e) => e.outcome?.type === type && e.outcome.commit === sha);
    assert.strictEqual(by('milestone', c1).length, 1, 'c1: tests passed before it');
    assert.strictEqual(by('milestone', c3).length, 0, 'c3: no test run');
    assert.strictEqual(by('commit_kept', c1).length, 1);
    assert.strictEqual(by('commit_reverted', c3).length, 1);
    assert.strictEqual(by('commit_reverted', c3)[0].ts, new Date(Date.parse(by('commit_reverted', c3)[0].ts)).toISOString());
    const survival = by('code_survival', c1).map((e) => [e.outcome!.days, e.outcome!.linesWritten, e.outcome!.linesSurviving]);
    assert.deepStrictEqual(survival, [[7, 10, 7], [30, 10, 7]], '3 of its 10 lines rewritten');
    assert.deepStrictEqual(by('code_survival', c3).map((e) => e.outcome!.linesSurviving), [0, 0], 'reverted: none left');
    assert.ok(out.every((e) => e.kind === 'outcome' && e.workspace === dir && (e.sessionId === 's1' || e.sessionId === 's2')));
    assert.ok(!out.some((e) => e.outcome?.commit?.startsWith(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim())), 'the unrelated commit: nothing');
    assert.deepStrictEqual(by('milestone', c1)[0].outcome!.refs, [events[0].eventId], 'refs: the edits');

    // Again, with those outcomes in the log: nothing new, and no blame.
    const { git, calls } = counting();
    assert.deepStrictEqual(await gitOutcomes({ repo: dir, events: [...events, ...out], now: Date.now(), git }), []);
    assert.ok(!calls.includes('blame') && !calls.includes('show'), calls.join(' '));
  });

  test('checks not due yet wait: before 7 days only the milestone', async () => {
    const { dir, commit } = repo();
    const t0 = Date.now() - 2 * DAY;
    commit(t0 - DAY, { 'a.ts': '' }, 'start');
    const events = [edit('s1', t0, path.join(dir, 'a.ts')), testRun('s1', t0 + MIN, true)];
    commit(t0 + 2 * MIN, { 'a.ts': lines(2, 'x') }, 'work');
    const out = await gitOutcomes({ repo: dir, events, now: Date.now() });
    assert.deepStrictEqual(out.map((e) => e.outcome!.type), ['milestone']);
  });

  test('the core\'s job records them for workspaces in a repository, unless outcomes.git is off', async () => {
    const { root, dir, commit } = repo();
    const home = path.join(root, '.snagboat');
    const t0 = Date.now() - 10 * DAY;
    commit(t0 - DAY, { 'a.ts': '' }, 'start');
    const events = [edit('s1', t0, path.join(dir, 'a.ts')), testRun('s1', t0 + MIN, true)].map((e) => ({ ...e, workspace: dir }));
    commit(t0 + 2 * MIN, { 'a.ts': lines(5, 'y') }, 'work');
    const writer = new StoreWriter(home);
    await writer.write(events);
    saveConfig(home, { version: 1, defaults: {}, projects: { [dir]: { 'outcomes.git': false } } });
    const job = new GitOutcomesJob(home, writer);
    assert.strictEqual(await job.run(), 0, 'off for this project');
    saveConfig(home, { version: 1, defaults: {}, projects: {} });
    assert.strictEqual(await job.run(), 3, 'milestone, kept, survival at 7 days');
    assert.strictEqual(await job.run(), 0, 'nothing twice');
    const stored = (await new EventLog(workspaceStoreDir(home, dir)).readAll()).filter((e) => e.kind === 'outcome').map((e) => e.outcome!.type).sort();
    assert.deepStrictEqual(stored, ['code_survival', 'commit_kept', 'milestone']);
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
