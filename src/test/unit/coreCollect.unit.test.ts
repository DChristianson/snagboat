import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { saveConfig } from '../../core/config';
import { EventLog } from '../../core/eventLog';
import { AggregateStore } from '../../core/retention';
import { claimWorkspace } from '../../core/service/claims';
import { projectDirOf } from '../../core/service/claudeCollector';
import { CoreService } from '../../core/service/server';
import { spoolDir, StoreWriter } from '../../core/service/storeWriter';
import { collectedWorkspace, workspaceOfProject } from '../../core/service/workspaces';
import { openWorkspaceStore, workspaceStoreDir } from '../../core/userStore';
import { spawn } from 'child_process';

// The core collecting Claude Code transcripts for every project (docs/design/handoff-3c.md,
// 3c-3b): which workspace a project belongs to, whether it's recorded, per-project capture
// settings, a window's claim, checkpoints across restarts, and retention for what the core owns.

function machine() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-collect-')));
  const home = path.join(root, 'home', '.snagboat');
  const projects = path.join(root, 'home', '.claude', 'projects');
  const repo = path.join(root, 'src', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'pkg', 'app'), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  return { root, home, projects, repo };
}

/** A transcript in Claude Code's layout: a prompt and a reply, each line carrying the session's cwd. */
function transcript(projects: string, cwd: string, session: string, n = 1, day = new Date().toISOString().slice(0, 10)): string {
  const dir = path.join(projects, sanitizeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = `${day}T10:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(JSON.stringify({ type: 'user', uuid: `${session}-u${i}`, sessionId: session, cwd, timestamp: ts, promptId: `${session}-p${i}`, message: { role: 'user', content: [{ type: 'text', text: `please fix bug ${i}` }] } }));
    lines.push(
      JSON.stringify({
        type: 'assistant', uuid: `${session}-a${i}`, parentUuid: `${session}-u${i}`, sessionId: session, cwd, timestamp: ts,
        message: { id: `${session}-m${i}`, model: 'claude-sonnet-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `fixed ${i}` }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      })
    );
  }
  const file = path.join(dir, `${session}.jsonl`);
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return file;
}

const read = (home: string, workspace: string) => new EventLog(workspaceStoreDir(home, workspace)).readAll();

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const start = (home: string, projects: string) => CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, claudeProjectsDir: projects });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a project belongs to the nearest known workspace, else its repository, else its own folder', () => {
    const { root, repo } = machine();
    const app = path.join(repo, 'pkg', 'app');
    assert.deepStrictEqual(workspaceOfProject(app, []), { workspace: repo, known: false });
    assert.deepStrictEqual(workspaceOfProject(app, [repo, path.join(repo, 'pkg')]), { workspace: path.join(repo, 'pkg'), known: true });
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose);
    assert.deepStrictEqual(workspaceOfProject(loose, []), { workspace: loose, known: false });
  });

  test('"collect": false and collect.unopened decide what is recorded', () => {
    const { home, repo, root } = machine();
    assert.strictEqual(collectedWorkspace(home, repo, []), repo);
    fs.writeFileSync(path.join(repo, '.snagboat.json'), JSON.stringify({ settings: { collect: false } }));
    assert.strictEqual(collectedWorkspace(home, repo, []), undefined, 'the project opted out');
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    saveConfig(home, { version: 1, defaults: { 'collect.unopened': false }, projects: {} });
    assert.strictEqual(collectedWorkspace(home, other, []), undefined, 'unknown project, unopened off');
    assert.strictEqual(collectedWorkspace(home, other, [other]), other, 'known projects still recorded');
  });

  test('the project of a transcript folder is the cwd its lines report', () => {
    const { projects, repo } = machine();
    transcript(projects, repo, 's1');
    assert.strictEqual(projectDirOf(path.join(projects, sanitizeCwd(repo))), repo);
  });

  test('the core records every project, tagged with its workspace, live and without duplicates across restarts', async () => {
    const { home, projects, repo, root } = machine();
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose);
    const app = path.join(repo, 'pkg', 'app');
    const file = transcript(projects, app, 'sa', 2);
    transcript(projects, loose, 'sb', 1);
    let core = await start(home, projects);
    try {
      await waitFor(async () => (await read(home, repo)).length === 4 && (await read(home, loose)).length === 2);
      const events = await read(home, repo);
      assert.ok(events.every((e) => e.workspace === repo), 'a session in a subfolder is recorded under its repository');
      assert.ok(events.some((e) => e.kind === 'user_prompt' && e.promptText === 'please fix bug 0'), 'text captured by default');
      // A new line is picked up live.
      fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'sa-u9', sessionId: 'sa', cwd: app, timestamp: new Date().toISOString(), promptId: 'sa-p9', message: { role: 'user', content: [{ type: 'text', text: 'one more' }] } }) + '\n');
      await waitFor(async () => (await read(home, repo)).length === 5);
    } finally {
      await core.stop();
    }
    core = await start(home, projects);
    try {
      await new Promise((r) => setTimeout(r, 1000));
      assert.strictEqual((await read(home, repo)).length, 5, 'a restart resumes from its checkpoints');
      const day = new Date().toISOString().slice(0, 10);
      const lines = fs.readFileSync(path.join(workspaceStoreDir(home, repo), 'events', `${day}.jsonl`), 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 5, 'and writes nothing twice');
    } finally {
      await core.stop();
    }
  });

  test("a project's settings turn off text capture, or recording altogether", async () => {
    const { home, projects, repo, root } = machine();
    const quiet = path.join(root, 'quiet');
    fs.mkdirSync(quiet);
    saveConfig(home, { version: 1, defaults: {}, projects: { [repo]: { captureContent: false }, [quiet]: { collect: false } } });
    transcript(projects, repo, 'sc');
    transcript(projects, quiet, 'sd');
    const core = await start(home, projects);
    try {
      await waitFor(async () => (await read(home, repo)).length === 2);
      assert.ok((await read(home, repo)).every((e) => e.promptText === undefined && e.textExcerpt === undefined), 'no text kept');
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(!fs.existsSync(workspaceStoreDir(home, quiet)), 'not recorded at all');
    } finally {
      await core.stop();
    }
  });

  test("a claimed workspace: what the window reads itself is dropped; a subfolder session it doesn't read is spooled", async () => {
    const { home, projects, repo } = machine();
    const window = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      claimWorkspace(await openWorkspaceStore(home, { workspace: repo, folder: repo }), window.pid!);
      transcript(projects, repo, 'se');
      transcript(projects, path.join(repo, 'pkg', 'app'), 'sf');
      const core = await start(home, projects);
      try {
        await waitFor(() => fs.existsSync(spoolDir(home)) && fs.readdirSync(spoolDir(home)).length === 1);
        const spooled = fs.readFileSync(path.join(spoolDir(home), fs.readdirSync(spoolDir(home))[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as NormalizedEvent);
        assert.deepStrictEqual([...new Set(spooled.map((e) => e.sessionId))], ['sf'], "only the subfolder session; the window's own is dropped");
        assert.strictEqual((await read(home, repo)).length, 0, 'nothing written while claimed');
      } finally {
        await core.stop();
      }
    } finally {
      window.kill();
    }
  });

  test('retention runs for the workspaces the core owns, and leaves claimed ones alone', async () => {
    const { home } = machine();
    const now = Date.parse('2026-11-11T12:00:00Z');
    const writer = new StoreWriter(home, () => now);
    const ev = (id: string, ts: string, workspace: string): NormalizedEvent => ({ eventId: id, sessionId: 's', agent: 'claude-code', ts, kind: 'user_prompt', status: 'unknown', promptText: 'secret-ish', raw: { adapter: 'test', ref: id }, workspace });
    saveConfig(home, { version: 1, defaults: { 'retention.rawDays': 10, 'retention.textDays': 3 }, projects: {} });
    await writer.write([ev('old', '2026-10-20T00:00:00Z', '/w/mine'), ev('mid', '2026-11-05T00:00:00Z', '/w/mine'), ev('new', '2026-11-11T00:00:00Z', '/w/mine')]);
    // Written on the 5th, while its text was still within textDays; retention runs on the 11th.
    await new StoreWriter(home, () => Date.parse('2026-11-05T12:00:00Z')).write([ev('theirs', '2026-11-05T00:00:00Z', '/w/theirs')]);
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      claimWorkspace(workspaceStoreDir(home, '/w/theirs'), live.pid!);
      await writer.runRetention();
      const mine = await read(home, '/w/mine');
      assert.deepStrictEqual(mine.map((e) => [e.eventId, e.promptText]), [['mid', undefined], ['new', 'secret-ish']], 'old day rolled up; text past 3 days removed');
      assert.deepStrictEqual(await new AggregateStore(workspaceStoreDir(home, '/w/mine')).listDays(), ['2026-10-20']);
      assert.deepStrictEqual((await read(home, '/w/theirs')).map((e) => e.promptText), ['secret-ish'], "a window's workspace is the window's to prune: its text past 3 days is left to the window");
      // A late event for a rolled-up day merges into its aggregate instead of a new raw file.
      await writer.write([ev('late', '2026-10-20T05:00:00Z', '/w/mine')]);
      assert.ok(!(await read(home, '/w/mine')).some((e) => e.eventId === 'late'));
    } finally {
      live.kill();
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
  process.exit(failures > 0 ? 1 : 0);
}

main();
