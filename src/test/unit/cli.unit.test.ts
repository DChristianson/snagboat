import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { NormalizedEvent } from '@snagboat/schema';
import { parseArgs, runCli } from '../../cli/main';
import { EXTENSION_ID, findStores, isInside, selectStores, Store, userDirs } from '../../cli/stores';
import { syntheticEvents } from '../../web/synthetic';

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
