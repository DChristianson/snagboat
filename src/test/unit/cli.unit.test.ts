import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { NormalizedEvent } from '@snagboat/schema';
import { parseArgs, runCli } from '../../cli/main';
import { EXTENSION_ID, findStores, isInside, selectStores, Store, userDirs } from '../../cli/stores';
import { workspaceOfVsCodeStore, workspaceStoreDir, WORKSPACE_MARKER } from '../../core/userStore';
import { syntheticEvents } from '../fixtures/synthetic';
import { StoreWriter } from '../../core/service/storeWriter';

function writeStore(dir: string, events: NormalizedEvent[]): void {
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)]);
  }
  for (const [day, lines] of byDay) fs.writeFileSync(path.join(dir, 'events', `${day}.jsonl`), lines.join('\n') + '\n');
}

/** A fake Linux home with two workspace stores (one nested in the other) and a global store. */
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-home-'));
  const user = path.join(home, '.config', 'Code', 'User');
  const outer = path.join(home, 'src', 'outer');
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  const ws = (hash: string, folder: string) => {
    fs.mkdirSync(path.join(user, 'workspaceStorage', hash), { recursive: true });
    fs.writeFileSync(path.join(user, 'workspaceStorage', hash, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }));
    return path.join(user, 'workspaceStorage', hash, EXTENSION_ID);
  };
  const outerStore = ws('h-outer', outer);
  const innerStore = ws('h-inner', inner);
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'h-other', 'some.other-extension', 'events'), { recursive: true });
  writeStore(outerStore, syntheticEvents().slice(0, 40));
  writeStore(innerStore, syntheticEvents().slice(40));
  writeStore(path.join(user, 'globalStorage', EXTENSION_ID), []);
  return { home, outer, inner, outerStore, innerStore };
}

function capture() {
  let out = '';
  let err = '';
  return { io: { out: (t: string) => (out += t), err: (t: string) => (err += t) }, get: () => ({ out, err }) };
}

// workspaceOfVsCodeStore spells a Windows drive letter the way VS Code does (c:\), Node's tmpdir C:\.
const vs = (p: string) => (/^[A-Z]:[\\/]/.test(p) ? p[0].toLowerCase() + p.slice(1) : p);

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const saved = { ...process.env };
  const restoreEnv = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };

  test('user folders follow each platform', () => {
    const home = '/home/u';
    assert.ok(userDirs('linux', {}, home).some((d) => d.dir === path.join(home, '.config', 'Code', 'User')));
    assert.ok(userDirs('darwin', {}, home).some((d) => d.dir === path.join(home, 'Library', 'Application Support', 'Code', 'User')));
    assert.ok(userDirs('win32', { APPDATA: '/appdata' }, home).some((d) => d.dir === path.join('/appdata', 'Code', 'User')));
    assert.ok(userDirs('linux', { XDG_CONFIG_HOME: '/xdg' }, home).some((d) => d.dir === path.join('/xdg', 'Code', 'User')));
  });

  test("VS Code's server folders are listed on every platform, labelled as servers", () => {
    const home = '/home/u';
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const dirs = userDirs(platform, {}, home);
      assert.ok(dirs.some((d) => d.app === 'Code (server)' && d.dir === path.join(home, '.vscode-server', 'data', 'User')), platform);
      assert.ok(dirs.some((d) => d.app === 'Cursor (server)' && d.dir === path.join(home, '.cursor-server', 'data', 'User')), platform);
    }
    assert.ok(userDirs('linux', { VSCODE_AGENT_FOLDER: '/agent' }, home).some((d) => d.app === 'Code (server)' && d.dir === path.join('/agent', 'data', 'User')));
  });

  test("findStores finds stores under VS Code's server, which writes no workspace.json", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-server-'));
    const user = path.join(home, '.vscode-server', 'data', 'User');
    const plain = path.join(user, 'workspaceStorage', 'h-plain', EXTENSION_ID);
    const remote = path.join(user, 'workspaceStorage', 'h-remote', EXTENSION_ID);
    writeStore(plain, syntheticEvents().slice(0, 10));
    writeStore(remote, syntheticEvents().slice(10, 20));
    fs.writeFileSync(path.join(user, 'workspaceStorage', 'h-remote', 'workspace.json'), JSON.stringify({ folder: 'vscode-remote://dev-container+abc/workspaces/x' }));
    writeStore(path.join(user, 'globalStorage', EXTENSION_ID), []);
    const stores = findStores({ platform: 'linux', env: {}, home });
    assert.strictEqual(stores.length, 3, JSON.stringify(stores));
    assert.ok(stores.every((s) => s.app === 'Code (server)'));
    const byDir = new Map(stores.map((s) => [s.dir, s]));
    assert.deepStrictEqual({ ...byDir.get(plain) }, { kind: 'vscode', dir: plain, app: 'Code (server)', global: false });
    assert.strictEqual(byDir.get(remote)?.uri, 'vscode-remote://dev-container+abc/workspaces/x');
    assert.strictEqual(byDir.get(remote)?.folder, undefined);
    assert.ok(stores.some((s) => s.global));
    // No local folder to match, so only --all reads them.
    assert.deepStrictEqual(selectStores(stores, '/workspaces/x', false), []);
    assert.strictEqual(selectStores(stores, '/workspaces/x', true).length, 3);

    // The CLI says why a cwd found nothing, and lists the stores.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.SNAGBOAT_STORE;
    delete process.env.VSCODE_AGENT_FOLDER;
    process.env.SNAGBOAT_HOME = path.join(home, '.snagboat');
    try {
      const none = capture();
      assert.strictEqual(await runCli(['sessions'], { ...none.io, cwd: '/workspaces/x', now: new Date() }, 'test'), 1);
      assert.ok(none.get().err.includes('1 store with no known workspace'), none.get().err);
      const listed = capture();
      assert.strictEqual(await runCli(['stores'], { ...listed.io, cwd: '/', now: new Date() }, 'test'), 0);
      assert.ok(listed.get().out.includes('Code (server)  (workspace unknown)'), listed.get().out);
      assert.ok(listed.get().out.includes('Code (server)  vscode-remote://dev-container+abc/workspaces/x'), listed.get().out);
      const dry = capture();
      assert.strictEqual(await runCli(['migrate', '--dry-run'], { ...dry.io, cwd: '/', now: new Date() }, 'test'), 0);
      assert.ok(dry.get().out.includes("no window has recorded it yet"), dry.get().out);
      assert.ok(dry.get().out.includes('Code (server)  vscode-remote://dev-container+abc/workspaces/x'), dry.get().out);
      assert.ok(!fs.existsSync(path.join(home, '.snagboat')), 'a dry run writes nothing');
    } finally {
      restoreEnv();
    }
  });

  test("a server store with Snagboat's marker is matched by its folder, labelled with it, and migrated under it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-marker-'));
    const user = path.join(home, '.vscode-server', 'data', 'User');
    const project = path.join(home, 'workspaces', 'x');
    const other = path.join(home, 'workspaces', 'y');
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    const marked = path.join(user, 'workspaceStorage', 'h-marked', EXTENSION_ID);
    const both = path.join(user, 'workspaceStorage', 'h-both', EXTENSION_ID);
    writeStore(marked, syntheticEvents().slice(0, 10));
    writeStore(both, syntheticEvents().slice(10, 20));
    fs.writeFileSync(path.join(marked, WORKSPACE_MARKER), JSON.stringify({ folder: project }));
    // workspace.json (the desktop app's) wins over the marker when both are there.
    fs.writeFileSync(path.join(both, WORKSPACE_MARKER), JSON.stringify({ folder: project }));
    fs.writeFileSync(path.join(user, 'workspaceStorage', 'h-both', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(other).href }));
    const stores = findStores({ platform: 'linux', env: {}, home });
    const byDir = new Map(stores.map((s) => [s.dir, s]));
    assert.strictEqual(byDir.get(marked)?.folder, project);
    assert.strictEqual(byDir.get(both)?.folder, other);
    assert.deepStrictEqual(selectStores(stores, path.join(project, 'sub'), false).map((s) => s.dir), [marked]);
    assert.deepStrictEqual(workspaceOfVsCodeStore(marked, false), { workspace: vs(project), folder: vs(project), workspaceFile: undefined });
    assert.strictEqual(workspaceOfVsCodeStore(both, false)?.workspace, vs(other));
    // A saved multi-root workspace's marker names its .code-workspace file.
    const multi = path.join(user, 'workspaceStorage', 'h-multi', EXTENSION_ID);
    fs.mkdirSync(multi, { recursive: true });
    fs.writeFileSync(path.join(multi, WORKSPACE_MARKER), JSON.stringify({ workspaceFile: path.join(home, 'both.code-workspace') }));
    assert.strictEqual(workspaceOfVsCodeStore(multi, false)?.workspace, vs(path.join(home, 'both.code-workspace')));

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.SNAGBOAT_STORE;
    delete process.env.VSCODE_AGENT_FOLDER;
    process.env.SNAGBOAT_HOME = path.join(home, '.snagboat');
    try {
      const listed = capture();
      assert.strictEqual(await runCli(['stores'], { ...listed.io, cwd: '/', now: new Date() }, 'test'), 0);
      assert.ok(listed.get().out.includes(`Code (server)  ${project}`), listed.get().out);
      assert.ok(!listed.get().out.includes('(workspace unknown)'), listed.get().out);
      const sessions = capture();
      assert.strictEqual(await runCli(['sessions'], { ...sessions.io, cwd: project, now: new Date() }, 'test'), 0, sessions.get().err);
      const migrated = capture();
      assert.strictEqual(await runCli(['migrate', '--json'], { ...migrated.io, cwd: '/', now: new Date() }, 'test'), 0);
      const report = JSON.parse(migrated.get().out);
      assert.deepStrictEqual(report.skipped, []);
      const dests = new Map<string, string>(report.stores.map((r: { source: string; dest: string }) => [r.source, r.dest]));
      assert.strictEqual(dests.get(marked), workspaceStoreDir(process.env.SNAGBOAT_HOME, vs(project)), JSON.stringify(report.stores));
      assert.strictEqual(dests.get(both), workspaceStoreDir(process.env.SNAGBOAT_HOME, vs(other)));
    } finally {
      restoreEnv();
    }
  });

  test('findStores finds workspace and global stores, and reads their folders', () => {
    const { home, outer, inner, outerStore } = fakeHome();
    const stores = findStores({ platform: 'linux', env: {}, home });
    assert.strictEqual(stores.length, 3, JSON.stringify(stores));
    const byDir = new Map(stores.map((s) => [s.dir, s]));
    assert.strictEqual(byDir.get(outerStore)?.folder, outer);
    assert.ok(stores.some((s) => s.folder === inner));
    assert.ok(stores.some((s) => s.global));
    assert.ok(stores.every((s) => s.app === 'Code'));
  });

  test('a workspace sees only its own store unless --all; nested folders pick the nearest', () => {
    const { home, outer, inner, outerStore, innerStore } = fakeHome();
    const stores = findStores({ platform: 'linux', env: {}, home });
    assert.deepStrictEqual(selectStores(stores, outer, false).map((s) => s.dir), [outerStore]);
    assert.deepStrictEqual(selectStores(stores, path.join(inner, 'src'), false).map((s) => s.dir), [innerStore]);
    assert.deepStrictEqual(selectStores(stores, os.tmpdir(), false), []);
    assert.strictEqual(selectStores(stores, os.tmpdir(), true).length, 3);
  });

  test('sessions --all names the workspace of each session in text; one store needs none', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-all-'));
    const [a, b] = [path.join(home, 'src', 'alpha'), path.join(home, 'src', 'beta')];
    const now = Date.now();
    const at = (e: NormalizedEvent, workspace: string): NormalizedEvent => ({ ...e, ts: new Date(now).toISOString(), workspace });
    const events = syntheticEvents();
    await new StoreWriter(home).write([at({ ...events[1], sessionId: 'sa', eventId: 'ea' }, a), at({ ...events[1], sessionId: 'sb', eventId: 'eb' }, b)]);
    process.env.SNAGBOAT_HOME = home;
    delete process.env.SNAGBOAT_STORE;
    try {
      const all = capture();
      assert.strictEqual(await runCli(['sessions', '--all', '--store', 'user'], { ...all.io, cwd: '/', now: new Date(now) }, 'test'), 0, all.get().err);
      const lines = all.get().out.trim().split('\n');
      assert.ok(lines.find((l) => l.includes(' sa'))?.endsWith(`  ${a}`), all.get().out);
      assert.ok(lines.find((l) => l.includes(' sb'))?.endsWith(`  ${b}`), all.get().out);
      const one = capture();
      assert.strictEqual(await runCli(['sessions', '--store', 'user'], { ...one.io, cwd: a, now: new Date(now) }, 'test'), 0, one.get().err);
      assert.ok(!one.get().out.includes(a), 'the current workspace goes without saying');
    } finally {
      restoreEnv();
    }
  });

  test('isInside', () => {
    assert.ok(isInside('/w/a/b', '/w/a', 'linux'));
    assert.ok(!isInside('/w/ab', '/w/a', 'linux'));
    assert.ok(isInside('/W/A/b', '/w/a', 'darwin'), 'case-insensitive on macOS');
    assert.ok(!isInside('/W/A/b', '/w/a', 'linux'));
  });

  test('parseArgs', () => {
    assert.deepStrictEqual(parseArgs(['sessions', '--json', '--days', '7']), { json: true, all: false, days: 7, args: ['sessions'] });
    assert.strictEqual(typeof parseArgs(['--days']), 'string');
    assert.strictEqual(typeof parseArgs(['--days', 'x']), 'string');
    assert.strictEqual(typeof parseArgs(['--nope']), 'string');
  });

  test('sessions and session read a store without changing it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-store-'));
    const events = syntheticEvents();
    writeStore(dir, events);
    const before = fs.readdirSync(path.join(dir, 'events')).map((f) => [f, fs.readFileSync(path.join(dir, 'events', f), 'utf8')]);
    process.env.SNAGBOAT_STORE = dir;
    try {
      const now = new Date('2026-11-03T00:00:00Z');
      const c = capture();
      assert.strictEqual(await runCli(['sessions', '--json', '--all'], { ...c.io, cwd: dir, now }, 'test'), 0, c.get().err);
      const list = JSON.parse(c.get().out) as Array<{ sessionId: string; lastTs: string }>;
      const ids = new Set(events.map((e) => e.sessionId));
      assert.ok(list.length > 0 && list.every((s) => ids.has(s.sessionId)));
      assert.ok(list.every((s, i) => i === 0 || list[i - 1].lastTs >= s.lastTs), 'newest first');

      const one = capture();
      assert.strictEqual(await runCli(['session', list[0].sessionId, '--json', '--all'], { ...one.io, cwd: dir, now }, 'test'), 0, one.get().err);
      assert.strictEqual(JSON.parse(one.get().out).sessionId, list[0].sessionId);

      const text = capture();
      assert.strictEqual(await runCli(['sessions', '--all'], { ...text.io, cwd: dir, now }, 'test'), 0);
      assert.ok(text.get().out.includes(list[0].sessionId));

      const old = capture();
      assert.strictEqual(await runCli(['sessions', '--json', '--all', '--days', '1'], { ...old.io, cwd: dir, now: new Date('2030-01-01T00:00:00Z') }, 'test'), 0);
      assert.deepStrictEqual(JSON.parse(old.get().out), []);

      const after = fs.readdirSync(path.join(dir, 'events')).map((f) => [f, fs.readFileSync(path.join(dir, 'events', f), 'utf8')]);
      assert.deepStrictEqual(after, before, 'the store is unchanged');
    } finally {
      restoreEnv();
    }
  });

  test('outside any workspace without --all, sessions explains and exits 1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-none-'));
    process.env.SNAGBOAT_STORE = path.join(dir, 'missing');
    try {
      const c = capture();
      assert.strictEqual(await runCli(['sessions'], { ...c.io, cwd: dir, now: new Date() }, 'test'), 1);
      assert.ok(c.get().err.includes('--all'));
    } finally {
      restoreEnv();
    }
  });

  test('usage errors exit 2; version and help exit 0', async () => {
    const bad = capture();
    assert.strictEqual(await runCli(['frobnicate'], { ...bad.io, cwd: '/', now: new Date() }, 'test'), 2);
    assert.ok(bad.get().err.includes('usage'));
    const v = capture();
    assert.strictEqual(await runCli(['version', '--json'], { ...v.io, cwd: '/', now: new Date() }, '1.2.3'), 0);
    assert.deepStrictEqual(JSON.parse(v.get().out), { version: '1.2.3' });
    const h = capture();
    assert.strictEqual(await runCli(['help'], { ...h.io, cwd: '/', now: new Date() }, 'x'), 0);
  });

  test('a Store with SNAGBOAT_STORE is the only one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-cli-env-'));
    writeStore(dir, []);
    const stores: Store[] = findStores({ env: { SNAGBOAT_STORE: dir } });
    assert.deepStrictEqual(stores.map((s) => s.dir), [dir]);
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
