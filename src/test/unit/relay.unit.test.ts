import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { runCli } from '../../cli/main';
import { loadConfig, relayAllowed, saveConfig, withRelayFolder, withVsCodeSettings } from '../../core/config';
import { EventLog } from '../../core/eventLog';
import { formatRelayInfo, outboxFileName, parseRelayInfo, relayDir, relayInfoPath, relayOutboxDir, RELAY_MAX_LINE_BYTES } from '../../core/relay';
import { hostProjectDir, readRelayStatus, RelayIngest } from '../../core/service/relayIngest';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { collectedWorkspace, knownWorkspaceFolders } from '../../core/service/workspaces';
import { workspaceStoreDir } from '../../core/userStore';

// The host side of the dev container relay (bead snagboat-xe5): the core reads the outboxes of
// folders allowed in config.json, refuses what isn't safe to read, maps the container's paths
// to the host's, and writes each event once.

const ROOT = '/workspaces/proj';

function machine() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-relay-')));
  const home = path.join(root, 'home', '.snagboat');
  const project = path.join(root, 'src', 'proj');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, 'pkg', 'app'), { recursive: true });
  return { root, home, project };
}

/** The container's side: relay.json, and an outbox file of events, written as the contract says. */
function relayed(project: string, events: Array<Partial<NormalizedEvent> | string>, seq = 1, info = { version: 1 as const, root: ROOT, host: 'c0ffee' }): string {
  fs.mkdirSync(relayOutboxDir(project), { recursive: true });
  fs.writeFileSync(path.join(relayDir(project), '.gitignore'), '*\n');
  fs.writeFileSync(relayInfoPath(project), formatRelayInfo(info));
  const name = outboxFileName(Date.now(), 4242, seq);
  const lines = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
  const temp = path.join(relayOutboxDir(project), `.${name}.tmp`);
  fs.writeFileSync(temp, lines.join('\n') + '\n');
  fs.renameSync(temp, path.join(relayOutboxDir(project), name));
  return path.join(relayOutboxDir(project), name);
}

let n = 0;
function ev(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  n += 1;
  return {
    eventId: `relay-${n}`,
    sessionId: 's1',
    agent: 'claude-code',
    ts: new Date().toISOString(),
    kind: 'turn_stop',
    status: 'success',
    workspace: ROOT,
    tokens: { input: 10, output: 5 },
    raw: { adapter: 'claude-code', ref: `ref-${n}` },
    ...over,
  } as NormalizedEvent;
}

function allow(home: string, ...folders: string[]) {
  let config = loadConfig(home).config;
  for (const f of folders) config = withRelayFolder(config, f, true);
  saveConfig(home, config);
}

function ingester(home: string, logs: string[] = []) {
  const writer = new StoreWriter(home);
  const relay = new RelayIngest({
    home,
    writer,
    workspaceFor: (dir) => collectedWorkspace(home, dir, knownWorkspaceFolders(home)),
    captureContent: () => true,
    log: (line) => logs.push(line),
  });
  return { writer, relay, logs };
}

const read = (home: string, workspace: string) => new EventLog(workspaceStoreDir(home, workspace)).readAll();
const outboxFiles = (project: string) => fs.readdirSync(relayOutboxDir(project));

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('relay.json: parsed and checked', () => {
    assert.deepStrictEqual(parseRelayInfo('{"version":1,"root":"/workspaces/x","host":"h"}'), { version: 1, root: '/workspaces/x', host: 'h' });
    for (const bad of ['nope', '[]', '{"version":2,"root":"/w","host":"h"}', '{"version":1,"root":"w","host":"h"}', '{"version":1,"root":"/w/../x","host":"h"}', '{"version":1,"root":"/w/","host":"h"}', '{"version":1,"root":"/w"}']) {
      assert.throws(() => parseRelayInfo(bad), bad);
    }
  });

  test("a container path under relay.json's root maps to the same path under the folder; anything else to the folder", () => {
    const info = { version: 1 as const, root: ROOT, host: 'h' };
    assert.strictEqual(hostProjectDir(ROOT, info, '/Users/me/proj'), '/Users/me/proj');
    assert.strictEqual(hostProjectDir(`${ROOT}/pkg/app`, info, '/Users/me/proj'), path.join('/Users/me/proj', 'pkg', 'app'));
    assert.strictEqual(hostProjectDir(`${ROOT}/pkg/../../../etc`, info, '/Users/me/proj'), '/Users/me/proj');
    assert.strictEqual(hostProjectDir('/workspaces/proj2/x', info, '/Users/me/proj'), '/Users/me/proj');
    assert.strictEqual(hostProjectDir('/Users/me/other', info, '/Users/me/proj'), '/Users/me/proj');
    assert.strictEqual(hostProjectDir(undefined, info, '/Users/me/proj'), '/Users/me/proj');
    assert.strictEqual(hostProjectDir('relative/path', info, '/Users/me/proj'), '/Users/me/proj');
  });

  test('a folder not allowed is not read', async () => {
    const { home, project } = machine();
    const file = relayed(project, [ev()]);
    const { relay } = ingester(home);
    assert.deepStrictEqual(await relay.ingest(), []);
    assert.ok(fs.existsSync(file), 'left alone');
    assert.strictEqual((await read(home, project)).length, 0);
  });

  test("an allowed folder's events are written under the host's workspaces, and the file deleted", async () => {
    const { home, project } = machine();
    const top = ev();
    const sub = ev({ workspace: `${ROOT}/pkg/app` });
    const elsewhere = ev({ workspace: '/home/vscode/.ssh' });
    relayed(project, [top, sub, elsewhere]);
    allow(home, project);
    const { relay } = ingester(home);
    const [result] = await relay.ingest();
    assert.strictEqual(result.files, 1);
    assert.strictEqual(result.written, 3);
    assert.deepStrictEqual(outboxFiles(project), []);
    // pkg/app is in the repository at project, so all three are the project's workspace; none is kept under a container path.
    const events = await read(home, project);
    assert.deepStrictEqual(events.map((e) => e.eventId).sort(), [top.eventId, sub.eventId, elsewhere.eventId].sort());
    assert.ok(events.every((e) => e.workspace === project));
    assert.strictEqual(readRelayStatus(home)[project]?.events, 3);
  });

  test("a subfolder that's a known workspace of its own gets its events", async () => {
    const { home, project } = machine();
    const app = path.join(project, 'pkg', 'app');
    saveConfig(home, { version: 1, defaults: {}, projects: { [app]: { captureContent: false } } });
    allow(home, project);
    const sub = ev({ workspace: `${ROOT}/pkg/app`, kind: 'user_prompt', promptText: 'secret prompt' });
    relayed(project, [sub, ev()]);
    const writer = new StoreWriter(home);
    const relay = new RelayIngest({
      home,
      writer,
      workspaceFor: (dir) => collectedWorkspace(home, dir, knownWorkspaceFolders(home)),
      captureContent: (dir) => dir !== app,
      log: () => undefined,
    });
    await relay.ingest();
    const inApp = await read(home, app);
    assert.deepStrictEqual(inApp.map((e) => e.eventId), [sub.eventId]);
    assert.strictEqual(inApp[0].promptText, undefined, "the project's captureContent: false applies");
    assert.strictEqual((await read(home, project)).length, 1);
  });

  test("a project whose settings say collect: false isn't recorded, and its file still goes", async () => {
    const { home, project } = machine();
    saveConfig(home, { version: 1, defaults: {}, projects: { [project]: { collect: false } } });
    allow(home, project);
    relayed(project, [ev(), ev()]);
    const [result] = await ingester(home).relay.ingest();
    assert.strictEqual(result.notRecorded, 2);
    assert.strictEqual(result.written, 0);
    assert.deepStrictEqual(outboxFiles(project), []);
    assert.strictEqual((await read(home, project)).length, 0);
  });

  test('oversized and garbled lines are skipped, and their contents never logged', async () => {
    const { home, project } = machine();
    allow(home, project);
    const good = ev();
    const long = JSON.stringify(ev({ textExcerpt: 'x'.repeat(RELAY_MAX_LINE_BYTES) }));
    relayed(project, [
      good,
      'not json SECRET-1',
      long,
      JSON.stringify({ eventId: 'e', sessionId: 's', ts: 'SECRET-2', kind: 'turn_stop', agent: 'a', raw: { adapter: 'a', ref: 'r' } }),
      JSON.stringify({ ...ev(), sessionId: 7 }),
      '[1,2]',
      '',
    ]);
    const { relay, logs } = ingester(home);
    const [result] = await relay.ingest();
    assert.strictEqual(result.events, 1);
    assert.strictEqual(result.skippedLines, 5);
    assert.deepStrictEqual((await read(home, project)).map((e) => e.eventId), [good.eventId]);
    assert.ok(!logs.join('\n').includes('SECRET'), logs.join('\n'));
    assert.deepStrictEqual(outboxFiles(project), []);
  });

  test("fields outside the schema are dropped, and the event's workspace is the host's", async () => {
    const { home, project } = machine();
    allow(home, project);
    relayed(project, [{ ...ev({ workspace: '/etc' }), injected: 'x' } as unknown as NormalizedEvent]);
    await ingester(home).relay.ingest();
    const [stored] = await read(home, project);
    assert.strictEqual((stored as unknown as Record<string, unknown>).injected, undefined);
    assert.strictEqual(stored.workspace, project);
  });

  test('a symlinked outbox file is refused and left alone, as is what it points to', async () => {
    const { root, home, project } = machine();
    allow(home, project);
    relayed(project, [ev()]);
    const target = path.join(root, 'outside.jsonl');
    fs.writeFileSync(target, JSON.stringify(ev()) + '\n');
    const link = path.join(relayOutboxDir(project), outboxFileName(1, 1, 99));
    fs.symlinkSync(target, link);
    const { relay, logs } = ingester(home);
    const [result] = await relay.ingest();
    assert.strictEqual(result.refused, 1);
    assert.strictEqual(result.files, 1, 'the real file is still read');
    assert.ok(fs.existsSync(target) && fs.lstatSync(link).isSymbolicLink());
    assert.strictEqual((await read(home, project)).length, 1);
    assert.ok(logs.some((l) => l.includes('symlink')));
  });

  test('a symlinked outbox or relay folder is refused', async () => {
    const { root, home, project } = machine();
    allow(home, project);
    // The outbox a symlink to a folder elsewhere with an outbox file in it.
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const file = path.join(elsewhere, outboxFileName(1, 1, 1));
    fs.writeFileSync(file, JSON.stringify(ev()) + '\n');
    relayed(project, []);
    fs.rmSync(relayOutboxDir(project), { recursive: true });
    fs.symlinkSync(elsewhere, relayOutboxDir(project));
    let [result] = await ingester(home).relay.ingest();
    assert.match(result.problem ?? '', /symlink/);
    assert.ok(fs.existsSync(file));
    // The whole .snagboat folder a symlink to another project's.
    const other = machine().project;
    relayed(other, [ev()]);
    fs.rmSync(path.join(project, '.snagboat'), { recursive: true });
    fs.symlinkSync(path.join(other, '.snagboat'), path.join(project, '.snagboat'));
    [result] = await ingester(home).relay.ingest();
    assert.match(result.problem ?? '', /symlink/);
    assert.strictEqual(outboxFiles(other).length, 1);
    assert.strictEqual((await read(home, project)).length, 0);
  });

  test('a symlinked relay.json and a FIFO in the outbox are refused', async () => {
    const { root, home, project } = machine();
    allow(home, project);
    relayed(project, [ev()]);
    const info = path.join(root, 'info.json');
    fs.writeFileSync(info, formatRelayInfo({ version: 1, root: ROOT, host: 'h' }));
    fs.rmSync(relayInfoPath(project));
    fs.symlinkSync(info, relayInfoPath(project));
    const [result] = await ingester(home).relay.ingest();
    assert.match(result.problem ?? '', /symlink/);
    assert.strictEqual(outboxFiles(project).length, 1);
    if (process.platform !== 'win32') {
      fs.rmSync(relayInfoPath(project));
      fs.writeFileSync(relayInfoPath(project), formatRelayInfo({ version: 1, root: ROOT, host: 'h' }));
      const { execFileSync } = await import('child_process');
      execFileSync('mkfifo', [path.join(relayOutboxDir(project), outboxFileName(2, 2, 2))]);
      const [again] = await ingester(home).relay.ingest();
      assert.strictEqual(again.refused, 1);
      assert.strictEqual(again.files, 1);
    }
  });

  test('a file over the size cap is deleted unread', async () => {
    const { home, project } = machine();
    allow(home, project);
    const file = relayed(project, [ev()]);
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    const [result] = await ingester(home).relay.ingest();
    assert.strictEqual(result.refused, 1);
    assert.strictEqual(result.events, 0);
    assert.deepStrictEqual(outboxFiles(project), []);
  });

  test('re-ingesting the same events (a file that failed part-way, or sent twice) counts each once', async () => {
    const { home, project } = machine();
    allow(home, project);
    const events = [ev(), ev(), ev()];
    relayed(project, events, 1);
    const { relay } = ingester(home);
    await relay.ingest();
    relayed(project, [...events, ev()], 2);
    const [second] = await relay.ingest();
    assert.strictEqual(second.duplicates, 3);
    assert.strictEqual(second.written, 1);
    assert.strictEqual((await read(home, project)).length, 4);
    // A new writer (a restarted core) reads what's on disk.
    relayed(project, events, 3);
    const [third] = await ingester(home).relay.ingest();
    assert.strictEqual(third.duplicates, 3);
    assert.strictEqual((await read(home, project)).length, 4);
  });

  test("a write that fails leaves the file for the next tick", async () => {
    const { home, project } = machine();
    allow(home, project);
    const file = relayed(project, [ev()]);
    const writer = new StoreWriter(home);
    let fail = true;
    const relay = new RelayIngest({
      home,
      writer: { write: (events: NormalizedEvent[]) => (fail ? Promise.reject(new Error('disk full')) : writer.write(events)) } as unknown as StoreWriter,
      workspaceFor: () => project,
      captureContent: () => true,
      log: () => undefined,
    });
    await relay.ingest();
    assert.ok(fs.existsSync(file));
    fail = false;
    const [result] = await relay.ingest();
    assert.strictEqual(result.written, 1);
    assert.ok(!fs.existsSync(file));
  });

  test('without a relay folder there is nothing to say; a bad relay.json leaves the outbox alone', async () => {
    const { home, project } = machine();
    allow(home, project);
    const logs: string[] = [];
    let [result] = await ingester(home, logs).relay.ingest();
    assert.strictEqual(result.files, 0);
    assert.deepStrictEqual(logs, []);
    relayed(project, [ev()]);
    fs.writeFileSync(relayInfoPath(project), '{"version":1,"root":"nope","host":"h"}');
    [result] = await ingester(home, logs).relay.ingest();
    assert.match(result.problem ?? '', /root/);
    assert.strictEqual(outboxFiles(project).length, 1);
  });

  test('relay.allow survives loading, saving, and a VS Code window copying its settings', () => {
    const { home, project } = machine();
    saveConfig(home, { version: 1, defaults: { captureContent: true }, projects: {} });
    allow(home, project, '/Users/me/other');
    const loaded = loadConfig(home).config;
    assert.deepStrictEqual(relayAllowed(loaded), [project, '/Users/me/other']);
    saveConfig(home, withVsCodeSettings(loaded, ['captureContent'], { captureContent: false }, { [project]: {} }));
    assert.deepStrictEqual(relayAllowed(loadConfig(home).config), [project, '/Users/me/other']);
    saveConfig(home, withRelayFolder(withRelayFolder(loadConfig(home).config, project, false), '/Users/me/other', false));
    assert.strictEqual(loadConfig(home).config.relay, undefined);
    // Entries that aren't absolute folders are dropped, and said so.
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, defaults: {}, projects: {}, relay: { allow: [project, 'relative', 3] } }));
    const again = loadConfig(home);
    assert.deepStrictEqual(relayAllowed(again.config), [project]);
    assert.strictEqual(again.problems.length, 1);
  });

  test("a project's .snagboat.json can't allow a relay", async () => {
    const { home, project } = machine();
    fs.writeFileSync(path.join(project, '.snagboat.json'), JSON.stringify({ settings: { relay: { allow: [project] } }, relay: { allow: [project] } }));
    const file = relayed(project, [ev()]);
    assert.deepStrictEqual(await ingester(home).relay.ingest(), []);
    assert.ok(fs.existsSync(file));
  });

  test('the core reads allowed outboxes on its ingest tick', async () => {
    const { root, home, project } = machine();
    allow(home, project);
    const e = ev();
    relayed(project, [e]);
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, claudeProjectsDir: path.join(root, 'claude'), copilotSessionsDir: path.join(root, 'copilot') });
    try {
      const deadline = Date.now() + 8_000;
      while (outboxFiles(project).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual((await read(home, project)).map((x) => x.eventId), [e.eventId]);
    } finally {
      await core.stop();
    }
  });

  test('snagboat relay allow, deny and status', async () => {
    const { home, project } = machine();
    const saved = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = home;
    const capture = () => {
      let out = '';
      let err = '';
      return { io: { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: project, now: new Date() }, get: () => ({ out, err }) };
    };
    try {
      let c = capture();
      assert.strictEqual(await runCli(['relay', 'allow'], c.io, 'test'), 0, c.get().err);
      assert.match(c.get().out, /Changed .*config\.json: added/);
      assert.deepStrictEqual(relayAllowed(loadConfig(home).config), [project]);
      c = capture();
      assert.strictEqual(await runCli(['relay', 'allow', '.', '--json'], c.io, 'test'), 0);
      assert.strictEqual(JSON.parse(c.get().out).changed, false);
      relayed(project, [ev()]);
      c = capture();
      assert.strictEqual(await runCli(['relay', 'status', '--json'], c.io, 'test'), 0);
      const status = JSON.parse(c.get().out) as { folders: Array<{ folder: string; relay: { root: string; host: string }; pending: number; lastIngest: unknown }> };
      assert.deepStrictEqual(status.folders, [{ folder: project, relay: { root: ROOT, host: 'c0ffee' }, pending: 1, lastIngest: null }]);
      c = capture();
      assert.strictEqual(await runCli(['relay', 'status'], c.io, 'test'), 0);
      assert.match(c.get().out, /pending\s+1 outbox file/);
      c = capture();
      assert.strictEqual(await runCli(['relay', 'allow', path.join(project, 'missing')], c.io, 'test'), 1);
      c = capture();
      assert.strictEqual(await runCli(['relay', 'deny', project], c.io, 'test'), 0);
      assert.match(c.get().out, /removed/);
      assert.deepStrictEqual(relayAllowed(loadConfig(home).config), []);
      c = capture();
      assert.strictEqual(await runCli(['relay'], c.io, 'test'), 2);
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
