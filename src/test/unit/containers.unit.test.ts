import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { runCli } from '../../cli/main';
import { containersAllowed, loadConfig, saveConfig, SnagboatConfig, withContainerFolder, withVsCodeSettings } from '../../core/config';
import { containerProjectFor, containerProjectsDir, containerStatusPath, openBelow, readContainerStatus } from '../../core/containerTranscripts';
import { EventLog } from '../../core/eventLog';
import { LineTailer } from '../../core/lineTailer';
import { CoreService } from '../../core/service/server';
import { listUserStores, workspaceStoreDir } from '../../core/userStore';

// Dev container transcripts (bead snagboat-xe5): the core reads <folder>/.snagboat/claude-projects
// (a container's ~/.claude/projects, bind-mounted there) only for folders allowed in config.json,
// refuses symlinks on the way to each transcript, and files each project inside the folder.

function machine() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-containers-')));
  const home = path.join(root, 'home', '.snagboat');
  const hostProjects = path.join(root, 'home', '.claude', 'projects');
  const folder = path.join(root, 'src', 'proj');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'pkg', 'app'), { recursive: true });
  fs.mkdirSync(hostProjects, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { root, home, hostProjects, folder, outside };
}

function lines(cwd: string, session: string, extra: Record<string, unknown> = {}): string {
  const ts = new Date().toISOString();
  return (
    [
      JSON.stringify({ type: 'user', uuid: `${session}-u`, sessionId: session, cwd, timestamp: ts, promptId: `${session}-p`, message: { role: 'user', content: [{ type: 'text', text: `prompt in ${session}` }] }, ...extra }),
      JSON.stringify({
        type: 'assistant', uuid: `${session}-a`, parentUuid: `${session}-u`, sessionId: session, cwd, timestamp: ts, ...extra,
        message: { id: `${session}-m`, model: 'claude-sonnet-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }),
    ].join('\n') + '\n'
  );
}

/** A transcript in Claude Code's layout under projectsDir; returns its project folder. */
function transcript(projectsDir: string, cwd: string, session: string): string {
  const dir = path.join(projectsDir, sanitizeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), lines(cwd, session));
  return dir;
}

function allow(home: string, ...folders: string[]): void {
  let config: SnagboatConfig = loadConfig(home).config;
  for (const f of folders) config = withContainerFolder(config, f, true);
  saveConfig(home, config);
}

const read = (home: string, workspace: string) => new EventLog(workspaceStoreDir(home, workspace)).readAll();

/** Every event in every workspace store, with the workspace it's filed under. */
async function everything(home: string): Promise<NormalizedEvent[]> {
  const all: NormalizedEvent[] = [];
  for (const store of listUserStores(home)) all.push(...(await new EventLog(store.dir).readAll()));
  return all;
}

const sessionsIn = (events: NormalizedEvent[]) => new Set(events.map((e) => e.sessionId));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 1_000));

async function start(m: ReturnType<typeof machine>, ingestEveryMs = 60_000) {
  const logs: string[] = [];
  const core = await CoreService.start({
    home: m.home,
    version: 'test',
    idleMs: 0,
    ingestEveryMs,
    claudeProjectsDir: m.hostProjects,
    copilotSessionsDir: path.join(m.root, 'copilot'),
    log: (line) => logs.push(line),
  });
  return { core, logs };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('containers.allow survives loading, saving, and a VS Code window copying its settings', () => {
    const { home, folder } = machine();
    saveConfig(home, { version: 1, defaults: { captureContent: true }, projects: {} });
    allow(home, folder, '/Users/me/other');
    const loaded = loadConfig(home).config;
    assert.deepStrictEqual(containersAllowed(loaded), [folder, '/Users/me/other']);
    saveConfig(home, withVsCodeSettings(loaded, ['captureContent'], { captureContent: false }, { [folder]: {} }));
    assert.deepStrictEqual(containersAllowed(loadConfig(home).config), [folder, '/Users/me/other']);
    saveConfig(home, withContainerFolder(withContainerFolder(loadConfig(home).config, folder, false), '/Users/me/other', false));
    assert.strictEqual(loadConfig(home).config.containers, undefined);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, defaults: {}, projects: {}, containers: { allow: [folder, 'relative', 3] } }));
    const again = loadConfig(home);
    assert.deepStrictEqual(containersAllowed(again.config), [folder]);
    assert.strictEqual(again.problems.length, 1);
  });

  test("a transcript's project is its cwd inside the allowed folder, else the folder itself", () => {
    const folder = '/Users/me/src/proj';
    assert.strictEqual(containerProjectFor(folder, folder), folder);
    assert.strictEqual(containerProjectFor(folder, `${folder}/pkg/app`), `${folder}/pkg/app`);
    assert.strictEqual(containerProjectFor(folder, '/workspaces/proj'), folder);
    assert.strictEqual(containerProjectFor(folder, `${folder}/../other`), folder);
    assert.strictEqual(containerProjectFor(folder, '/Users/me/src/proj-other'), folder);
    assert.strictEqual(containerProjectFor(folder, 'relative/path'), folder);
  });

  test('a folder that is not allowed is not read, even if its .snagboat.json asks', async () => {
    const m = machine();
    fs.writeFileSync(path.join(m.folder, '.snagboat.json'), JSON.stringify({ settings: { containers: { allow: [m.folder] } }, containers: { allow: [m.folder] } }));
    transcript(containerProjectsDir(m.folder), m.folder, 'c-none');
    transcript(m.hostProjects, m.outside, 'h-1');
    const { core } = await start(m);
    try {
      await waitFor(async () => (await read(m.home, m.outside)).length === 2);
      await settle();
      assert.ok(!sessionsIn(await everything(m.home)).has('c-none'));
    } finally {
      await core.stop();
    }
  });

  test("an allowed folder's transcripts land under its workspaces; a cwd outside it lands under the folder", async () => {
    const m = machine();
    const sub = path.join(m.folder, 'pkg', 'app');
    const other = path.join(m.root, 'other');
    fs.mkdirSync(other);
    // sub and other are known workspaces of their own.
    saveConfig(m.home, { version: 1, defaults: {}, projects: { [sub]: {}, [other]: {} } });
    allow(m.home, m.folder);
    const projects = containerProjectsDir(m.folder);
    transcript(projects, m.folder, 'c-root');
    transcript(projects, sub, 'c-sub');
    transcript(projects, '/workspaces/proj', 'c-old');
    transcript(projects, other, 'c-escape');
    const { core } = await start(m);
    try {
      await waitFor(async () => (await read(m.home, m.folder)).length === 6 && (await read(m.home, sub)).length === 2);
      await settle();
      assert.deepStrictEqual([...sessionsIn(await read(m.home, m.folder))].sort(), ['c-escape', 'c-old', 'c-root']);
      assert.deepStrictEqual([...sessionsIn(await read(m.home, sub))], ['c-sub'], 'a subfolder cwd resolves like any project');
      assert.ok((await read(m.home, m.folder)).every((e) => e.workspace === m.folder));
      assert.strictEqual((await read(m.home, other)).length, 0, 'never filed outside the allowed folder');
      assert.ok((await read(m.home, m.folder)).some((e) => e.promptText === 'prompt in c-root'), 'text captured by default');
    } finally {
      await core.stop();
    }
  });

  test("the project's captureContent and collect settings apply", async () => {
    const m = machine();
    const sub = path.join(m.folder, 'pkg', 'app');
    saveConfig(m.home, { version: 1, defaults: {}, projects: { [m.folder]: { captureContent: false }, [sub]: { collect: false } } });
    allow(m.home, m.folder);
    transcript(containerProjectsDir(m.folder), m.folder, 'c-quiet');
    transcript(containerProjectsDir(m.folder), sub, 'c-off');
    const { core } = await start(m);
    try {
      await waitFor(async () => (await read(m.home, m.folder)).length === 2);
      await settle();
      assert.ok((await read(m.home, m.folder)).every((e) => e.promptText === undefined && e.textExcerpt === undefined));
      assert.ok(!sessionsIn(await everything(m.home)).has('c-off'));
    } finally {
      await core.stop();
    }
  });

  test('symlinked folders, project folders, session and subagent folders, and transcripts are refused; memory/ is ignored', async () => {
    const m = machine();
    // A second allowed folder whose claude-projects is a symlink, and a third whose .snagboat is.
    const linkedProjects = path.join(m.root, 'src', 'linked-projects');
    const linkedDot = path.join(m.root, 'src', 'linked-dot');
    for (const f of [linkedProjects, linkedDot]) fs.mkdirSync(f, { recursive: true });
    const elsewhere = path.join(m.outside, 'projects');
    transcript(elsewhere, linkedProjects, 'c-linked-projects');
    fs.mkdirSync(path.join(linkedProjects, '.snagboat'));
    fs.symlinkSync(elsewhere, containerProjectsDir(linkedProjects));
    const elsewhereDot = path.join(m.outside, 'dot');
    transcript(path.join(elsewhereDot, 'claude-projects'), linkedDot, 'c-linked-dot');
    fs.symlinkSync(elsewhereDot, path.join(linkedDot, '.snagboat'));
    allow(m.home, m.folder, linkedProjects, linkedDot);

    const projects = containerProjectsDir(m.folder);
    const dir = transcript(projects, m.folder, 'c-ok');
    // A transcript that's a symlink to a file outside.
    const target = path.join(m.outside, 'target.jsonl');
    fs.writeFileSync(target, lines(m.folder, 'c-linked-file'));
    fs.symlinkSync(target, path.join(dir, 'c-linked-file.jsonl'));
    // A project folder that's a symlink.
    const outsideProject = path.join(m.outside, 'project');
    fs.mkdirSync(outsideProject);
    fs.writeFileSync(path.join(outsideProject, 'c-linked-project.jsonl'), lines(m.folder, 'c-linked-project'));
    fs.symlinkSync(outsideProject, path.join(projects, '-linked-project'));
    // A subagents folder that's a symlink, and a session folder that's one.
    const subagent = (cwd: string, session: string) => lines(cwd, session, { isSidechain: true, agentId: `agent-${session}` });
    const outsideSub = path.join(m.outside, 'subagents');
    fs.mkdirSync(outsideSub);
    fs.writeFileSync(path.join(outsideSub, 'agent-x.jsonl'), subagent(m.folder, 'c-linked-subagents'));
    fs.mkdirSync(path.join(dir, 'c-ok'));
    fs.symlinkSync(outsideSub, path.join(dir, 'c-ok', 'subagents'));
    const outsideSession = path.join(m.outside, 'session');
    fs.mkdirSync(path.join(outsideSession, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(outsideSession, 'subagents', 'agent-y.jsonl'), subagent(m.folder, 'c-linked-session'));
    fs.writeFileSync(path.join(dir, 'c-two.jsonl'), lines(m.folder, 'c-two'));
    fs.symlinkSync(outsideSession, path.join(dir, 'c-two'));
    // A real session with a real subagent folder is read.
    fs.writeFileSync(path.join(dir, 'c-three.jsonl'), lines(m.folder, 'c-three'));
    fs.mkdirSync(path.join(dir, 'c-three', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'c-three', 'subagents', 'agent-z.jsonl'), subagent(m.folder, 'c-real-subagent'));
    // memory/ isn't a transcript, even shaped like a session folder.
    fs.mkdirSync(path.join(dir, 'memory', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# notes\n');
    fs.writeFileSync(path.join(dir, 'memory', 'subagents', 'agent-m.jsonl'), subagent(m.folder, 'c-memory'));

    const { core, logs } = await start(m);
    try {
      await waitFor(async () => {
        const seen = sessionsIn(await read(m.home, m.folder));
        return ['c-ok', 'c-two', 'c-three', 'c-real-subagent'].every((s) => seen.has(s));
      });
      await settle();
      const seen = sessionsIn(await everything(m.home));
      for (const refused of ['c-linked-projects', 'c-linked-dot', 'c-linked-file', 'c-linked-project', 'c-linked-subagents', 'c-linked-session', 'c-memory']) {
        assert.ok(!seen.has(refused), `${refused} was read`);
      }
      const refusals = logs.filter((l) => l.includes('refused'));
      assert.ok(refusals.some((l) => l.includes('claude-projects is a symlink')));
      assert.ok(refusals.some((l) => l.includes('.snagboat is a symlink')));
      assert.ok(refusals.some((l) => l.includes('c-linked-file.jsonl is a symlink')));
      assert.ok(refusals.some((l) => l.includes('-linked-project is a symlink')));
      assert.ok(!logs.some((l) => l.includes('prompt in')), 'contents never logged');
    } finally {
      await core.stop();
    }
  });

  test('openBelow refuses a FIFO and a file outside the folder', () => {
    const m = machine();
    const fifo = path.join(m.folder, 'pipe.jsonl');
    require('child_process').execFileSync('mkfifo', [fifo]);
    const r = openBelow(m.folder, fifo);
    assert.ok('problem' in r && /isn't a regular file/.test(r.problem));
    const outside = path.join(m.outside, 'x.jsonl');
    fs.writeFileSync(outside, '{}\n');
    const o = openBelow(m.folder, outside);
    assert.ok('problem' in o && /isn't inside/.test(o.problem));
  });

  test('a line longer than the cap is skipped, never read whole', async () => {
    const m = machine();
    const file = path.join(m.folder, 't.jsonl');
    fs.writeFileSync(file, `short-1\n${'x'.repeat(350)}\nshort-2\n${'y'.repeat(99)}\n`);
    const got: string[] = [];
    let skipped = 0;
    const offsets = new Map<string, number>();
    const tailer = new LineTailer({
      dir: m.folder,
      includeFile: (f) => f.endsWith('.jsonl'),
      getOffset: (f) => offsets.get(f) ?? 0,
      setOffset: (f, o) => offsets.set(f, o),
      onLines: (_f, l) => got.push(...l),
      open: (f) => fs.openSync(f, 'r'),
      maxLineBytes: 100,
      onSkippedLine: () => (skipped += 1),
    });
    tailer.start();
    try {
      await waitFor(() => got.length === 3);
      assert.deepStrictEqual(got, ['short-1', 'short-2', 'y'.repeat(99)]);
      assert.strictEqual(skipped, 1);
      assert.strictEqual(offsets.get(file), fs.statSync(file).size);
    } finally {
      tailer.stop();
    }
  });

  test("a restart resumes from the folder's own checkpoints, apart from the host's", async () => {
    const m = machine();
    allow(m.home, m.folder);
    const projects = containerProjectsDir(m.folder);
    transcript(projects, m.folder, 'c-1');
    // The host has a transcript for the same project, in its own folder: both are read, each once.
    transcript(m.hostProjects, m.folder, 'h-1');
    let { core } = await start(m);
    try {
      await waitFor(async () => (await read(m.home, m.folder)).length === 4);
    } finally {
      await core.stop();
    }
    ({ core } = await start(m));
    try {
      await settle();
      const day = new Date().toISOString().slice(0, 10);
      const stored = fs.readFileSync(path.join(workspaceStoreDir(m.home, m.folder), 'events', `${day}.jsonl`), 'utf8').trim().split('\n');
      assert.strictEqual(stored.length, 4, 'nothing read twice');
      const checkpoints = fs.readdirSync(path.join(m.home, 'data', 'core', 'checkpoints'));
      assert.ok(checkpoints.some((c) => c.startsWith('container-')) && checkpoints.some((c) => c.startsWith('claude-code-')));
    } finally {
      await core.stop();
    }
  });

  test('allowing and denying take effect on the next ingest, without a restart, and the status is saved', async () => {
    const m = machine();
    transcript(containerProjectsDir(m.folder), m.folder, 'c-later');
    const { core } = await start(m, 200);
    try {
      await settle();
      assert.strictEqual((await read(m.home, m.folder)).length, 0);
      allow(m.home, m.folder);
      await waitFor(async () => (await read(m.home, m.folder)).length === 2);
      await waitFor(() => fs.existsSync(containerStatusPath(m.home)));
      assert.strictEqual(readContainerStatus(m.home)[m.folder]?.events, 2);
      saveConfig(m.home, withContainerFolder(loadConfig(m.home).config, m.folder, false));
      await settle();
      transcript(containerProjectsDir(m.folder), m.folder, 'c-after-deny');
      await settle();
      assert.ok(!sessionsIn(await everything(m.home)).has('c-after-deny'));
    } finally {
      await core.stop();
    }
  });

  test('snagboat containers allow, deny and status', async () => {
    const { home, folder } = machine();
    const saved = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = home;
    const capture = () => {
      let out = '';
      let err = '';
      return { io: { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: folder, now: new Date() }, get: () => ({ out, err }) };
    };
    try {
      let c = capture();
      assert.strictEqual(await runCli(['containers', 'allow'], c.io, 'test'), 0, c.get().err);
      assert.match(c.get().out, /Changed .*config\.json: added/);
      assert.deepStrictEqual(containersAllowed(loadConfig(home).config), [folder]);
      c = capture();
      assert.strictEqual(await runCli(['containers', 'allow', '.', '--json'], c.io, 'test'), 0);
      assert.strictEqual(JSON.parse(c.get().out).changed, false);
      c = capture();
      assert.strictEqual(await runCli(['containers', 'status', '--json'], c.io, 'test'), 0);
      assert.deepStrictEqual(JSON.parse(c.get().out).folders, [{ folder, projectsDir: containerProjectsDir(folder), exists: false, projects: 0, sessions: 0, lastRead: null }]);
      transcript(containerProjectsDir(folder), folder, 's1');
      transcript(containerProjectsDir(folder), folder, 's2');
      transcript(containerProjectsDir(folder), path.join(folder, 'pkg'), 's3');
      c = capture();
      assert.strictEqual(await runCli(['containers', 'status', '--json'], c.io, 'test'), 0);
      const [status] = JSON.parse(c.get().out).folders;
      assert.deepStrictEqual([status.exists, status.projects, status.sessions], [true, 2, 3]);
      c = capture();
      assert.strictEqual(await runCli(['containers', 'status'], c.io, 'test'), 0);
      assert.match(c.get().out, /2 project folder\(s\), 3 session file\(s\)/);
      assert.match(c.get().out, /last read\s+never/);
      c = capture();
      assert.strictEqual(await runCli(['containers', 'allow', path.join(folder, 'missing')], c.io, 'test'), 1);
      c = capture();
      assert.strictEqual(await runCli(['containers', 'deny', folder], c.io, 'test'), 0);
      assert.match(c.get().out, /removed/);
      assert.deepStrictEqual(containersAllowed(loadConfig(home).config), []);
      c = capture();
      assert.strictEqual(await runCli(['containers'], c.io, 'test'), 2);
    } finally {
      if (saved === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved;
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
