import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommitRecord, foldStoreRecords, GitRecord, PlanItemRecord, PlanRecord } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { GIT_RECORDS_FILE, GitRecordsJob } from '../../core/service/gitRecordsJob';
import { PLAN_RECORDS_FILE, PlanRecordsJob } from '../../core/service/planRecordsJob';
import { removeStoreRecordText, StoreWriter } from '../../core/service/storeWriter';
import { appendStoreRecords, readStoreRecordLines, storeRecordChanged, withoutStoreText } from '../../core/storeRecordFiles';
import { openWorkspaceStore } from '../../core/userStore';

// Commit bodies (git.jsonl) and plan item text (plan.jsonl) are captured text: they follow
// captureContent, retention.textDays, and Snagboat: Remove Captured Text.

const DAY = 86_400_000;

function tmp(prefix = 'snagboat-captext-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A real git repository with a store for it. */
function repo() {
  const root = tmp();
  const home = path.join(root, 'home');
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  let tick = Math.floor(Date.now() / 1000) - 3 * 3600;
  const run = (args: string[], at?: number) => {
    const t = at ?? (tick += 60);
    return execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@example.com', GIT_AUTHOR_DATE: `@${t}`, GIT_COMMITTER_DATE: `@${t}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  };
  run(['init', '-q', '-b', 'main']);
  let n = 0;
  const commit = (message: string, at?: number) => {
    fs.writeFileSync(path.join(dir, `f${(n += 1)}.txt`), `${n}\n`);
    run(['add', '-A'], at);
    run(['commit', '-q', '-m', message], at);
    return run(['rev-parse', 'HEAD']).trim();
  };
  const writer = new StoreWriter(home);
  const file = (store: string) => path.join(store, GIT_RECORDS_FILE);
  const commits = (store: string) => new Map(foldStoreRecords(readStoreRecordLines<GitRecord>(file(store))).filter((r): r is CommitRecord => r.record === 'commit').map((c) => [c.subject, c]));
  return { root, home, dir, commit, writer, file, commits, open: () => openWorkspaceStore(home, { workspace: dir, folder: dir }) };
}

const item = (id: string, updated: string, text?: PlanItemRecord['text']): PlanItemRecord => ({
  record: 'item',
  version: 1,
  id,
  kind: 'task',
  title: `Title of ${id}`,
  status: 'open',
  labels: [],
  created: updated,
  updated,
  ...(text ? { text } : {}),
  source: 'beads',
  confidence: 'observed',
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  // These run git. On Windows (not supported, its CI job a signal only) they're skipped.
  const gitTest = (name: string, fn: () => Promise<void> | void) => test(name, process.platform === 'win32' ? () => undefined : fn);

  test('storeRecordChanged: a stored copy that only lost its text is unchanged; any other difference is a change', () => {
    const at = '2026-11-01T00:00:00.000Z';
    const withText = item('p-1', at, { description: 'secret' });
    const bare = withoutStoreText(withText);
    assert.strictEqual(bare.text, undefined);
    assert.strictEqual(bare.title, 'Title of p-1');
    assert.strictEqual(storeRecordChanged(undefined, withText), true, 'not stored yet');
    assert.strictEqual(storeRecordChanged(withText, withText), false);
    assert.strictEqual(storeRecordChanged(bare, withText), false, 'lost its text: not put back');
    assert.strictEqual(storeRecordChanged(withText, bare), true, 'text to drop (capture off, or past textDays): a change');
    assert.strictEqual(storeRecordChanged(bare, { ...withText, status: 'done' }), true, 'changed otherwise: stored whole again');
    assert.strictEqual(storeRecordChanged(item('p-1', at, { description: 'old' }), withText), true, 'different text');
  });

  gitTest('captureContent off: a commit is stored without its body; co-authors and reverts still come from it', async () => {
    const s = repo();
    s.commit('start');
    s.commit('Add it (#3)\n\nWhy we did this.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    saveConfig(s.home, { version: 1, defaults: {}, projects: { [s.dir]: { captureContent: false } } });
    const store = await s.open();
    assert.ok((await new GitRecordsJob(s.home, s.writer).run()) > 0);
    const c = s.commits(store).get('Add it (#3)')!;
    assert.strictEqual(c.body, undefined);
    assert.deepStrictEqual(c.coAuthors, ['Claude <noreply@anthropic.com>']);
    assert.strictEqual(c.pr, 3);
    assert.ok(!fs.readFileSync(s.file(store), 'utf8').includes('Why we did this'));

    // On again: an unchanged commit isn't stored again for its body; a new one has its body.
    saveConfig(s.home, { version: 1, defaults: {}, projects: {} });
    s.commit('Later\n\nWith a body.');
    await new GitRecordsJob(s.home, s.writer).run();
    assert.strictEqual(s.commits(store).get('Add it (#3)')!.body, undefined);
    assert.strictEqual(s.commits(store).get('Later')!.body, 'With a body.');
  });

  gitTest('Remove Captured Text: commit bodies and plan item text leave the files on disk; the next runs put back none', async () => {
    const s = repo();
    s.commit('start\n\nThe first body.');
    s.commit('second\n\nThe second body.\n\nCo-Authored-By: Bob <bob@example.com>');
    const store = await s.open();
    const job = new GitRecordsJob(s.home, s.writer);
    await job.run();
    assert.strictEqual(s.commits(store).get('second')!.body, 'The second body.\n\nCo-Authored-By: Bob <bob@example.com>');

    // A second workspace's plan, from bd (a fake: no shell), with text.
    const other = path.join(s.root, 'other');
    fs.mkdirSync(path.join(other, '.beads'), { recursive: true });
    const otherStore = await openWorkspaceStore(s.home, { workspace: other, folder: other });
    const updated = new Date(Date.now() - DAY).toISOString();
    const issues = [{ id: 'p-1', title: 'Plan it', status: 'open', issue_type: 'task', description: 'The secret plan', notes: 'Notes too', created_at: updated, updated_at: updated }];
    const plan = new PlanRecordsJob(s.home, s.writer, {
      bd: '/fake/bd',
      git: async () => {
        throw new Error('not a repository');
      },
      runBd: async (_bd, args) => (args[1] === 'export' ? issues.map((i) => JSON.stringify(i)).join('\n') : 'null'),
    });
    assert.strictEqual(await plan.run(), 1);
    const planFile = path.join(otherStore, PLAN_RECORDS_FILE);
    assert.ok(fs.readFileSync(planFile, 'utf8').includes('The secret plan'));

    const removed = await s.writer.removeCapturedText();
    assert.strictEqual(removed, 3, 'two commit bodies and one item text');
    const gitText = fs.readFileSync(s.file(store), 'utf8');
    assert.ok(!gitText.includes('first body') && !gitText.includes('second body'), 'gone from the file, not shadowed');
    const second = s.commits(store).get('second')!;
    assert.strictEqual(second.body, undefined);
    assert.deepStrictEqual(second.coAuthors, ['Bob <bob@example.com>'], 'parsed from the body, kept');
    assert.strictEqual(s.commits(store).size, 2);
    const planText = fs.readFileSync(planFile, 'utf8');
    assert.ok(!planText.includes('secret plan') && !planText.includes('Notes too'));
    const planItem = foldStoreRecords(readStoreRecordLines<PlanRecord>(planFile)).find((r): r is PlanItemRecord => r.record === 'item')!;
    assert.strictEqual(planItem.title, 'Plan it');
    assert.strictEqual(planItem.text, undefined);
    assert.deepStrictEqual(fs.readdirSync(store).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');

    // Capture still on: the jobs run again, and neither the commits nor the item changed.
    const gitLines = readStoreRecordLines(s.file(store)).length;
    assert.strictEqual(await job.run({ force: true }), 0);
    assert.strictEqual(await new GitRecordsJob(s.home, s.writer).run(), 0, 'nor a new job (a restarted core)');
    assert.strictEqual(readStoreRecordLines(s.file(store)).length, gitLines);
    assert.strictEqual(await plan.run({ force: true }), 0);
    assert.ok(!fs.readFileSync(planFile, 'utf8').includes('secret plan'));

    // A changed item is stored whole again, as new text is captured again.
    issues[0] = { ...issues[0], status: 'in_progress', updated_at: new Date().toISOString() };
    assert.strictEqual(await plan.run({ force: true }), 1);
    assert.ok(fs.readFileSync(planFile, 'utf8').includes('The secret plan'));

    // Nothing left to remove: the files aren't rewritten.
    await s.writer.removeCapturedText();
    const before = fs.statSync(s.file(store)).mtimeMs;
    assert.strictEqual(await removeStoreRecordText(s.home, (w) => w === s.dir), 0);
    assert.strictEqual(fs.statSync(s.file(store)).mtimeMs, before);
  });

  gitTest('textDays: old commits are stored without their body, and retention strips bodies from older lines', async () => {
    const s = repo();
    s.commit('old\n\nAn old body.', Math.floor((Date.now() - 20 * DAY) / 1000));
    s.commit('recent\n\nA recent body.');
    saveConfig(s.home, { version: 1, defaults: { 'retention.textDays': 10 }, projects: {} });
    const store = await s.open();
    await new GitRecordsJob(s.home, s.writer).run();
    assert.strictEqual(s.commits(store).get('old')!.body, undefined, 'committed before textDays: no body');
    assert.strictEqual(s.commits(store).get('recent')!.body, 'A recent body.');

    // A body stored before textDays was shortened goes with retention; the commit stays.
    const at = new Date(Date.now() - 15 * DAY).toISOString();
    await appendStoreRecords(s.file(store), [
      { record: 'commit', version: 1, sha: 'e'.repeat(40), parents: [], kind: 'commit', authoredAt: at, committedAt: at, author: 'a', committer: 'a', coAuthors: [], subject: 'stored earlier', body: 'An aged body.', files: [], onBranches: [] },
    ]);
    await s.writer.runRetention();
    assert.ok(!fs.readFileSync(s.file(store), 'utf8').includes('aged body'));
    assert.strictEqual(s.commits(store).get('stored earlier')!.body, undefined);
    assert.strictEqual(s.commits(store).get('recent')!.body, 'A recent body.');
    assert.strictEqual(await new GitRecordsJob(s.home, s.writer).run({ force: true }), 0, 'and the job puts nothing back');
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
