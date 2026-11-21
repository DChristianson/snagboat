import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BranchRecord, CheckoutRecord, CommitRecord, foldStoreRecords, GitRecord } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { checkoutId } from '../../core/gitRecords';
import { GIT_RECORDS_FILE, GIT_RECORDS_IDLE_MS, GitRecordsJob } from '../../core/service/gitRecordsJob';
import { StoreWriter } from '../../core/service/storeWriter';
import { appendStoreRecords, readStoreRecordLines } from '../../core/storeRecordFiles';
import { openWorkspaceStore } from '../../core/userStore';

// The repository job (docs/design/export.md, "The store records it"): git.jsonl's commits,
// branches and checkouts, from scratch repositories built with real git.

const DAY = 86_400_000;

function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-gitrec-')));
  const home = path.join(root, 'home');
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  let tick = Math.floor(Date.now() / 1000) - 3 * 3600;
  const run = (cwd: string, args: string[], at?: number) => {
    const t = at ?? (tick += 60);
    return execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@example.com', GIT_AUTHOR_DATE: `@${t}`, GIT_COMMITTER_DATE: `@${t}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  };
  const git = (...args: string[]) => run(dir, args);
  git('init', '-q', '-b', 'main');
  const commit = (files: Record<string, string>, message: string, cwd = dir, at?: number) => {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, f), text);
    run(cwd, ['add', '-A']);
    run(cwd, ['commit', '-q', '-m', message], at);
    return run(cwd, ['rev-parse', 'HEAD']).trim();
  };
  const writer = new StoreWriter(home);
  const open = async (folder: string) => openWorkspaceStore(home, { workspace: folder, folder });
  const records = (storeDir: string) => readStoreRecordLines<GitRecord>(path.join(storeDir, GIT_RECORDS_FILE));
  const current = (storeDir: string) => foldStoreRecords(records(storeDir));
  const branch = (storeDir: string, name: string) =>
    current(storeDir)
      .filter((r): r is BranchRecord => r.record === 'branch' && r.name === name)
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
      .pop();
  return { root, home, dir, git, run, commit, writer, open, records, current, branch };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('commits: parents, idents, co-authors, files with numstat and renames, pr, reverts, kinds, branches', async () => {
    const s = scratch();
    const c1 = s.commit({ 'a.txt': 'one\ntwo\n', 'keep.txt': 'k\n' }, 'start');
    s.git('mv', 'a.txt', 'b.txt');
    const c2 = s.commit({ 'keep.txt': 'k\nk2\n' }, 'Rename and grow (#7)\n\nWhy it changed.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\nco-authored-by: Bob <bob@example.com>');
    const c3 = s.commit({ 'keep.txt': 'k\n' }, `Revert "Rename and grow (#7)"\n\nThis reverts commit ${c2}.`);
    s.git('checkout', '-q', '-b', 'side');
    const c4 = s.commit({ 's.txt': 's\n' }, 'side work');
    const store = await s.open(s.dir);
    const job = new GitRecordsJob(s.home, s.writer);
    assert.ok((await job.run()) > 0);

    const commits = new Map(s.current(store).filter((r): r is CommitRecord => r.record === 'commit').map((c) => [c.sha, c]));
    assert.strictEqual(commits.size, 4);
    const r2 = commits.get(c2)!;
    assert.deepStrictEqual(r2.parents, [c1]);
    assert.strictEqual(r2.kind, 'squash');
    assert.strictEqual(r2.pr, 7);
    assert.strictEqual(r2.author, 'Ann <ann@example.com>');
    assert.strictEqual(r2.committer, 'Ann <ann@example.com>');
    assert.deepStrictEqual(r2.coAuthors, ['Claude Opus <noreply@anthropic.com>', 'Bob <bob@example.com>']);
    assert.strictEqual(r2.subject, 'Rename and grow (#7)');
    assert.ok(r2.body?.startsWith('Why it changed.'));
    assert.ok(r2.authoredAt.endsWith('Z'));
    const files = [...r2.files].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepStrictEqual(files, [
      { path: 'b.txt', status: 'R', added: 0, deleted: 0, from: 'a.txt' },
      { path: 'keep.txt', status: 'M', added: 1, deleted: 0 },
    ]);
    assert.strictEqual(commits.get(c3)!.reverts, c2);
    assert.strictEqual(commits.get(c3)!.kind, 'commit');
    assert.deepStrictEqual(commits.get(c1)!.files.map((f) => [f.path, f.status, f.added]).sort(), [['a.txt', 'A', 2], ['keep.txt', 'A', 1]]);
    assert.deepStrictEqual(commits.get(c1)!.onBranches, ['main', 'side']);
    assert.deepStrictEqual(commits.get(c4)!.onBranches, ['side']);
    assert.strictEqual(s.records(store).filter((r) => r.record === 'commit')[0].sha, c1, 'oldest first');
  });

  test('a merge commit, a fast-forward, a squash naming its pull request, then the branch deleted', async () => {
    const s = scratch();
    s.commit({ 'a.txt': 'a\n' }, 'start');
    // merge
    s.git('checkout', '-q', '-b', 'feat-merge');
    s.commit({ 'm.txt': 'm\n' }, 'merge work');
    s.git('checkout', '-q', 'main');
    s.commit({ 'other.txt': 'o\n' }, 'main moves on');
    s.git('merge', '-q', '--no-ff', 'feat-merge', '-m', 'Merge pull request #4 from me/feat-merge');
    const mergeSha = s.git('rev-parse', 'HEAD').trim();
    // fast-forward
    s.git('checkout', '-q', '-b', 'feat-ff');
    s.commit({ 'f.txt': 'f\n' }, 'ff work');
    s.git('checkout', '-q', 'main');
    s.git('merge', '-q', '--ff-only', 'feat-ff');
    const ffTip = s.git('rev-parse', 'HEAD').trim();
    // squash
    s.git('checkout', '-q', '-b', 'feat-squash');
    s.commit({ 'q.txt': 'q1\n' }, 'squash one');
    s.commit({ 'q.txt': 'q1\nq2\n', 'q2.txt': 'x\n' }, 'squash two');
    s.git('checkout', '-q', 'main');
    s.commit({ 'unrelated.txt': 'u\n' }, 'meanwhile');
    s.git('merge', '-q', '--squash', 'feat-squash');
    s.git('commit', '-q', '-m', 'Add the squash feature (#12)');
    const squashSha = s.git('rev-parse', 'HEAD').trim();
    // a branch with no commits of its own isn't merged
    s.git('branch', 'idle');

    const store = await s.open(s.dir);
    const job = new GitRecordsJob(s.home, s.writer);
    await job.run();
    assert.deepStrictEqual(s.branch(store, 'feat-merge')!.merged, { into: 'main', at: s.branch(store, 'feat-merge')!.merged!.at, via: 'merge', commit: mergeSha, pr: 4 });
    const ff = s.branch(store, 'feat-ff')!;
    assert.strictEqual(ff.merged?.via, 'fast-forward');
    assert.strictEqual(ff.merged?.commit, squashSha, 'the target\'s head when it was seen');
    assert.notStrictEqual(ffTip, squashSha);
    const sq = s.branch(store, 'feat-squash')!;
    assert.deepStrictEqual([sq.merged?.via, sq.merged?.commit, sq.merged?.pr], ['squash', squashSha, 12]);
    assert.ok(sq.createdAt && sq.from, 'creation from the reflog');
    assert.strictEqual(sq.id, `feat-squash@${sq.firstSeenAt}`);
    assert.strictEqual(s.branch(store, 'idle')!.merged, undefined);
    assert.strictEqual(s.branch(store, 'main')!.merged, undefined);
    const squashCommit = s.current(store).find((r): r is CommitRecord => r.record === 'commit' && r.sha === squashSha)!;
    assert.deepStrictEqual([squashCommit.kind, squashCommit.pr], ['squash', 12]);
    assert.strictEqual(s.current(store).find((r): r is CommitRecord => r.record === 'commit' && r.sha === mergeSha)!.kind, 'merge');

    // Deleted, as this project deletes merged branches: deletedAt, merged kept, same record.
    s.git('branch', '-D', 'feat-squash');
    s.git('branch', '-D', 'idle');
    await job.run({ force: true });
    const gone = s.branch(store, 'feat-squash')!;
    assert.strictEqual(gone.id, sq.id);
    assert.ok(gone.deletedAt);
    assert.strictEqual(gone.merged?.via, 'squash');
    assert.ok(s.branch(store, 'idle')!.deletedAt && !s.branch(store, 'idle')!.merged);

    // Made again under the same name: a new record.
    s.git('branch', 'idle');
    await job.run({ force: true });
    const again = s.current(store).filter((r) => r.record === 'branch' && r.name === 'idle');
    assert.strictEqual(again.length, 2);
    assert.strictEqual(again.filter((r) => !(r as BranchRecord).deletedAt).length, 1);
  });

  test('a deleted branch that was never merged, then found squashed after it was deleted', async () => {
    const s = scratch();
    s.commit({ 'a.txt': 'a\n' }, 'start');
    s.git('checkout', '-q', '-b', 'dropped');
    s.commit({ 'd.txt': 'd\n' }, 'abandoned idea');
    s.git('checkout', '-q', 'main');
    s.git('checkout', '-q', '-b', 'pr-branch');
    s.commit({ 'p.txt': 'p\n' }, 'p work');
    s.git('checkout', '-q', 'main');
    const store = await s.open(s.dir);
    const job = new GitRecordsJob(s.home, s.writer);
    await job.run();
    assert.strictEqual(s.branch(store, 'dropped')!.merged, undefined);
    // The pull request is squash-merged elsewhere and pulled, and the branch deleted, between runs.
    s.commit({ 'p.txt': 'p\n' }, 'Different title for the PR (#21)');
    s.git('branch', '-D', 'dropped', 'pr-branch');
    await job.run({ force: true });
    const dropped = s.branch(store, 'dropped')!;
    assert.ok(dropped.deletedAt);
    assert.strictEqual(dropped.merged, undefined);
    const pr = s.branch(store, 'pr-branch')!;
    assert.ok(pr.deletedAt);
    assert.deepStrictEqual([pr.merged?.via, pr.merged?.pr], ['squash', 21], 'matched by its changes');
  });

  test('rebase: rebased then fast-forwarded locally, or its commits replayed onto main', async () => {
    const s = scratch();
    s.commit({ 'a.txt': 'a\n' }, 'start');
    s.git('checkout', '-q', '-b', 'local-rebase');
    s.commit({ 'l.txt': 'l\n' }, 'local work');
    s.git('checkout', '-q', 'main');
    s.commit({ 'm.txt': 'm\n' }, 'main moves');
    s.git('checkout', '-q', 'local-rebase');
    s.git('rebase', '-q', 'main');
    s.git('checkout', '-q', 'main');
    s.git('merge', '-q', '--ff-only', 'local-rebase');
    // Rebase and merge on a server: the branch's commits replayed onto main as new commits.
    s.git('checkout', '-q', '-b', 'server-rebase');
    s.commit({ 'r1.txt': 'r1\n' }, 'server one');
    s.commit({ 'r2.txt': 'r2\n' }, 'server two');
    s.git('checkout', '-q', 'main');
    s.commit({ 'n.txt': 'n\n' }, 'main moves again');
    s.git('cherry-pick', 'main..server-rebase');
    const tip = s.git('rev-parse', 'HEAD').trim();
    const store = await s.open(s.dir);
    await new GitRecordsJob(s.home, s.writer).run();
    assert.strictEqual(s.branch(store, 'local-rebase')!.merged?.via, 'rebase');
    const server = s.branch(store, 'server-rebase')!;
    assert.deepStrictEqual([server.merged?.via, server.merged?.commit], ['rebase', tip]);
  });

  test('checkouts, detached HEAD included, and nothing appended twice', async () => {
    const s = scratch();
    const c1 = s.commit({ 'a.txt': 'a\n' }, 'start');
    s.commit({ 'a.txt': 'b\n' }, 'second');
    s.git('checkout', '-q', '-b', 'topic');
    s.git('checkout', '-q', '--detach', c1);
    s.git('checkout', '-q', 'main');
    const store = await s.open(s.dir);
    const job = new GitRecordsJob(s.home, s.writer);
    await job.run();
    const checkouts = s.current(store).filter((r): r is CheckoutRecord => r.record === 'checkout');
    assert.deepStrictEqual(
      checkouts.map((c) => [c.from, c.to]),
      [['main', 'topic'], ['topic', c1.slice(0, 7)], [c1.slice(0, 7), 'main']]
    );
    assert.strictEqual(checkouts[1].commit, c1);
    assert.ok(checkouts.every((c) => c.where === s.dir));
    assert.strictEqual(checkouts[1].id, checkoutId('.', checkouts[1].at, c1));

    const size = fs.statSync(path.join(store, GIT_RECORDS_FILE)).size;
    assert.strictEqual(await job.run({ force: true }), 0, 'a second run appends nothing');
    assert.strictEqual(await new GitRecordsJob(s.home, s.writer).run(), 0, 'nor does a new job (a restarted core)');
    assert.strictEqual(fs.statSync(path.join(store, GIT_RECORDS_FILE)).size, size);

    // A new commit on main: the commit, and main's head, and nothing else.
    s.commit({ 'c.txt': 'c\n' }, 'third');
    assert.strictEqual(await job.run({ force: true }), 2);
    const lines = s.records(store);
    assert.deepStrictEqual(lines.slice(-2).map((r) => r.record), ['commit', 'branch']);
  });

  test('two worktrees: shared commits and branches, the same in both stores; each its own checkouts', async () => {
    const s = scratch();
    s.commit({ 'a.txt': 'a\n' }, 'start');
    const wt = path.join(s.root, 'wt2');
    s.git('worktree', 'add', '-q', '-b', 'wt-branch', wt);
    s.commit({ 'w.txt': 'w\n' }, 'in the worktree', wt);
    s.run(wt, ['checkout', '-q', '-b', 'wt-other']);
    s.git('checkout', '-q', '-b', 'main-topic');
    const mainStore = await s.open(s.dir);
    const wtStore = await s.open(wt);
    await new GitRecordsJob(s.home, s.writer).run();
    const shared = (dir: string) => s.current(dir).filter((r) => r.record !== 'checkout').map((r) => JSON.stringify(r)).sort();
    assert.deepStrictEqual(shared(mainStore), shared(wtStore));
    assert.ok(shared(mainStore).length >= 2 + 4, 'commits and branches');
    const where = (dir: string) => s.current(dir).filter((r): r is CheckoutRecord => r.record === 'checkout').map((c) => [c.where, c.to]);
    assert.deepStrictEqual(where(mainStore), [[s.dir, 'main-topic']]);
    assert.deepStrictEqual(where(wtStore), [[wt, 'wt-other']]);
    const wtCheckout = s.current(wtStore).find((r): r is CheckoutRecord => r.record === 'checkout')!;
    assert.strictEqual(wtCheckout.id, checkoutId('wt2', wtCheckout.at, wtCheckout.commit));

    // A third store opened later for the same worktree's subfolder gets the same branch ids.
    const sub = path.join(wt, 'sub');
    fs.mkdirSync(sub);
    const subStore = await s.open(sub);
    await new GitRecordsJob(s.home, s.writer).run();
    assert.deepStrictEqual(shared(subStore), shared(wtStore));
  });

  test('cadence: hourly when idle, every tick while a session in the repository is active; off when outcomes.git is off', async () => {
    const s = scratch();
    s.commit({ 'a.txt': 'a\n' }, 'start');
    await s.open(s.dir);
    let now = Date.now();
    const job = new GitRecordsJob(s.home, s.writer, () => undefined, undefined, () => now);
    saveConfig(s.home, { version: 1, defaults: {}, projects: { [s.dir]: { 'outcomes.git': false } } });
    assert.strictEqual(await job.run(), 0, 'off for this project');
    saveConfig(s.home, { version: 1, defaults: {}, projects: {} });
    assert.ok((await job.run()) > 0);
    s.commit({ 'b.txt': 'b\n' }, 'more');
    now += 5 * 60_000;
    assert.strictEqual(await job.run(), 0, 'idle: not due for an hour');
    await s.writer.write([{ eventId: 'e1', sessionId: 's', agent: 'claude-code', ts: new Date(now).toISOString(), kind: 'tool_call', status: 'success', workspace: s.dir, raw: { adapter: 't', ref: 'r' } }]);
    assert.strictEqual(await job.run(), 2, 'active: read now');
    s.commit({ 'c.txt': 'c\n' }, 'more again');
    now += GIT_RECORDS_IDLE_MS;
    assert.strictEqual(await job.run(), 2, 'an hour on: read');
  });

  test('retention: nothing older than rawDays is appended, and retention drops what aged out', async () => {
    const s = scratch();
    const old = Math.floor((Date.now() - 20 * DAY) / 1000);
    s.commit({ 'a.txt': 'a\n' }, 'old', s.dir, old);
    s.commit({ 'b.txt': 'b\n' }, 'recent');
    saveConfig(s.home, { version: 1, defaults: { 'retention.rawDays': 10 }, projects: {} });
    const store = await s.open(s.dir);
    const job = new GitRecordsJob(s.home, s.writer);
    await job.run();
    assert.deepStrictEqual(s.current(store).filter((r): r is CommitRecord => r.record === 'commit').map((c) => c.subject), ['recent']);

    // Records already stored that aged out: a commit, a checkout, a deleted branch. A live branch stays.
    const file = path.join(store, GIT_RECORDS_FILE);
    const at = new Date(Date.now() - 30 * DAY).toISOString();
    await appendStoreRecords(file, [
      { record: 'commit', version: 1, sha: 'f'.repeat(40), parents: [], kind: 'commit', authoredAt: at, committedAt: at, author: 'a', committer: 'a', coAuthors: [], subject: 'aged', files: [], onBranches: [] },
      { record: 'checkout', version: 1, id: 'checkout-0000000000000000', at, from: 'a', to: 'b', commit: 'f'.repeat(40), where: s.dir },
      { record: 'branch', version: 1, id: `gone@${at}`, name: 'gone', firstSeenAt: at, head: 'f'.repeat(40) },
      { record: 'branch', version: 1, id: `gone@${at}`, name: 'gone', firstSeenAt: at, head: 'f'.repeat(40), deletedAt: at },
      { record: 'branch', version: 1, id: `live@${at}`, name: 'live-but-old', firstSeenAt: at, head: 'f'.repeat(40) },
    ]);
    fs.appendFileSync(file, '{"torn');
    await s.writer.runRetention();
    const left = s.records(store);
    assert.ok(!left.some((r) => (r.record === 'commit' && r.subject === 'aged') || r.record === 'checkout' || (r.record === 'branch' && r.name === 'gone')));
    assert.ok(left.some((r) => r.record === 'branch' && r.name === 'live-but-old'));
    assert.ok(left.some((r) => r.record === 'commit' && r.subject === 'recent'));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('torn'));
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
