import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { NormalizedEvent, WORKSPACE_NO_FOLDER } from '@snagboat/schema';
import { runCli } from '../../cli/main';
import { EXTENSION_ID, userDirs } from '../../cli/stores';
import { compareToBaseline } from '../../cli/verify';
import { EventLog } from '../../core/eventLog';
import { markerFile, migrate, MigrationSource } from '../../core/migrate';
import { listUserStores, readWorkspaceJson, workspaceKey, workspaceOfVsCodeStore, workspaceStoreDir } from '../../core/userStore';
import { syntheticEvents } from '../../web/synthetic';

// The copy-only migration to the per-user store (docs/design/handoff-3c.md, step 3c-1),
// over fixture VS Code stores laid out as VS Code lays them out on this platform.

function writeDays(dir: string, events: NormalizedEvent[]): void {
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  for (const e of events) fs.appendFileSync(path.join(dir, 'events', `${e.ts.slice(0, 10)}.jsonl`), JSON.stringify(e) + '\n');
}

/** Every file under dir with its contents, to check a store is left exactly as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

async function readAll(dir: string): Promise<NormalizedEvent[]> {
  return new EventLog(dir).readAll();
}

/**
 * A fake home: VS Code's user folder for this platform with two workspace
 * stores (alpha and beta), alpha opened in Cursor too (same folder, overlapping
 * events), a global store, and global files. The environment points os.homedir(),
 * VS Code's folders and SNAGBOAT_HOME into it, as the CLI sees them.
 */
function fakeMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-migrate-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.SNAGBOAT_HOME = path.join(home, '.snagboat');
  delete process.env.SNAGBOAT_STORE;
  const dirs = userDirs(process.platform, process.env, home);
  const code = dirs.find((d) => d.app === 'Code')!.dir;
  const cursor = dirs.find((d) => d.app === 'Cursor')!.dir;
  const alpha = path.join(home, 'src', 'alpha');
  const beta = path.join(home, 'src', 'beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  const ws = (user: string, hash: string, folder: string) => {
    fs.mkdirSync(path.join(user, 'workspaceStorage', hash), { recursive: true });
    fs.writeFileSync(path.join(user, 'workspaceStorage', hash, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }));
    return path.join(user, 'workspaceStorage', hash, EXTENSION_ID);
  };
  const events = syntheticEvents();
  const alphaStore = ws(code, 'h-alpha', alpha);
  const alphaCursor = ws(cursor, 'h-alpha-cursor', alpha);
  const betaStore = ws(code, 'h-beta', beta);
  const globalStore = path.join(code, 'globalStorage', EXTENSION_ID);
  writeDays(alphaStore, events.slice(0, 60));
  writeDays(alphaCursor, events.slice(40, 80)); // 20 events overlap with Code's copy
  writeDays(betaStore, events.slice(80));
  writeDays(globalStore, []);
  fs.mkdirSync(path.join(alphaStore, 'aggregates'), { recursive: true });
  fs.writeFileSync(path.join(alphaStore, 'aggregates', '2026-01-01.json'), '{"date":"2026-01-01"}');
  fs.mkdirSync(path.join(alphaStore, 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(alphaStore, 'checkpoints', 'claude-code.json'), '{"updatedAt":"x","state":{}}');
  fs.writeFileSync(path.join(alphaStore, 'finding-responses.jsonl'), '{"a":1}\n{"a":2}\n');
  fs.writeFileSync(path.join(globalStore, 'rules.json'), '{"from":"code"}');
  fs.writeFileSync(path.join(globalStore, 'context-limits.json'), '{}');
  fs.mkdirSync(path.join(cursor, 'globalStorage', EXTENSION_ID), { recursive: true });
  fs.writeFileSync(path.join(cursor, 'globalStorage', EXTENSION_ID, 'rules.json'), '{"from":"cursor"}');
  return { home, snagboatHome: process.env.SNAGBOAT_HOME, alpha, beta, alphaStore, alphaCursor, betaStore, globalStore, events, vscodeDirs: [code, cursor] };
}

function capture() {
  let out = '';
  let err = '';
  return { io: { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: os.tmpdir(), now: new Date('2026-11-10T00:00:00Z') }, get: () => ({ out, err }) };
}

async function cli(args: string[]) {
  const c = capture();
  const code = await runCli(args, c.io, 'test');
  return { code, ...c.get() };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const saved = { ...process.env };
  const restoreEnv = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };

  test('workspace keys are readable and unique; no folder has its own', () => {
    assert.match(workspaceKey('/home/u/src/alpha'), /^alpha-[0-9a-f]{12}$/);
    assert.notStrictEqual(workspaceKey('/home/u/src/alpha'), workspaceKey('/home/v/src/alpha'));
    assert.match(workspaceKey('/home/u/both.code-workspace'), /^both-[0-9a-f]{12}$/);
    assert.match(workspaceKey('vscode-remote://dev-container+abc/workspaces/x y'), /^x_y-[0-9a-f]{12}$/);
    assert.strictEqual(workspaceKey(WORKSPACE_NO_FOLDER), 'no-folder');
  });

  test("workspace.json names a folder, a .code-workspace file, or a remote URI; the identity lower-cases a drive letter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-wsjson-'));
    const file = path.join(dir, 'workspace.json');
    fs.writeFileSync(file, JSON.stringify({ folder: pathToFileURL(dir).href }));
    assert.strictEqual(readWorkspaceJson(file).folder?.toLowerCase(), dir.toLowerCase());
    fs.writeFileSync(file, JSON.stringify({ folder: 'vscode-remote://dev-container+abc/workspaces/x' }));
    assert.deepStrictEqual(readWorkspaceJson(file), { folder: undefined, workspaceFile: undefined, uri: 'vscode-remote://dev-container+abc/workspaces/x' });
    const store = path.join(dir, EXTENSION_ID);
    assert.strictEqual(workspaceOfVsCodeStore(store, false)?.workspace, 'vscode-remote://dev-container+abc/workspaces/x');
    assert.deepStrictEqual(workspaceOfVsCodeStore(store, true), { workspace: WORKSPACE_NO_FOLDER });
    if (process.platform === 'win32') {
      // Node spells the drive C:, VS Code c:; the identity follows VS Code, the CLI's listing follows Node.
      fs.writeFileSync(file, JSON.stringify({ folder: 'file:///C:/Users/u/alpha' }));
      assert.strictEqual(readWorkspaceJson(file).folder, 'C:\\Users\\u\\alpha');
      assert.strictEqual(workspaceOfVsCodeStore(store, false)?.workspace, 'c:\\Users\\u\\alpha');
    }
    fs.rmSync(file);
    assert.strictEqual(workspaceOfVsCodeStore(store, false), undefined);
  });

  test('an EventLog with a workspace tags what it writes; one without leaves events as they are', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-tag-'));
    const [a, b, c] = syntheticEvents();
    const tagged = new EventLog(path.join(dir, 'user'), { workspace: '/w/alpha' });
    await tagged.init();
    tagged.append(a);
    tagged.append({ ...b, workspace: '/w/other' });
    await tagged.flush();
    await tagged.rewriteDay(c.ts.slice(0, 10), (events) => [...events, c], { create: true });
    const written = await tagged.readAll();
    assert.strictEqual(written.find((e) => e.eventId === a.eventId)?.workspace, '/w/alpha');
    assert.strictEqual(written.find((e) => e.eventId === b.eventId)?.workspace, '/w/other', 'an existing workspace is kept');
    assert.strictEqual(written.find((e) => e.eventId === c.eventId)?.workspace, '/w/alpha', 'rewrites tag too');
    assert.strictEqual(a.workspace, undefined, "the caller's event isn't changed");
    const plain = new EventLog(path.join(dir, 'vscode'));
    await plain.init();
    plain.append(a);
    await plain.flush();
    assert.ok((await plain.readAll()).every((e) => e.workspace === undefined));
  });

  test('migrate copies each store into its workspace, tags and dedupes events, and leaves the sources exactly as they were', async () => {
    try {
      const m = fakeMachine();
      const before = { alpha: snapshot(m.alphaStore), cursor: snapshot(m.alphaCursor), beta: snapshot(m.betaStore), global: snapshot(m.globalStore) };
      const { code, out, err } = await cli(['migrate', '--json']);
      assert.strictEqual(code, 0, err);
      const report = JSON.parse(out);
      assert.strictEqual(report.stores.length, 4, out);

      assert.deepStrictEqual(snapshot(m.alphaStore), before.alpha);
      assert.deepStrictEqual(snapshot(m.alphaCursor), before.cursor);
      assert.deepStrictEqual(snapshot(m.betaStore), before.beta);
      assert.deepStrictEqual(snapshot(m.globalStore), before.global);

      const alphaKey = workspaceOfVsCodeStore(m.alphaStore, false)!.workspace;
      const alpha = await readAll(workspaceStoreDir(m.snagboatHome!, alphaKey));
      assert.deepStrictEqual(alpha.map((e) => e.eventId).sort(), m.events.slice(0, 80).map((e) => e.eventId).sort(), 'Code and Cursor copies merged, overlap once');
      assert.ok(alpha.every((e) => e.workspace === alphaKey));
      assert.strictEqual(alpha.length, new Set(alpha.map((e) => e.eventId)).size, 'no duplicates on disk');
      const beta = await readAll(workspaceStoreDir(m.snagboatHome!, workspaceOfVsCodeStore(m.betaStore, false)!.workspace));
      assert.strictEqual(beta.length, m.events.length - 80);

      const alphaDir = workspaceStoreDir(m.snagboatHome!, alphaKey);
      assert.strictEqual(fs.readFileSync(path.join(alphaDir, 'aggregates', '2026-01-01.json'), 'utf8'), '{"date":"2026-01-01"}');
      assert.ok(fs.existsSync(path.join(alphaDir, 'checkpoints', 'claude-code.json')));
      assert.strictEqual(fs.readFileSync(path.join(alphaDir, 'finding-responses.jsonl'), 'utf8'), '{"a":1}\n{"a":2}\n');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(alphaDir, 'workspace.json'), 'utf8')).workspace, alphaKey);
      assert.strictEqual(fs.readFileSync(path.join(m.snagboatHome!, 'rules.json'), 'utf8'), '{"from":"code"}', "VS Code's rules win over Cursor's");
      assert.ok(fs.existsSync(path.join(m.snagboatHome!, 'data', 'context-limits.json')));
      assert.ok(report.globals.some((g: { name: string; status: string }) => g.name === 'rules.json' && g.status === 'exists'), "Cursor's rules are reported, not copied");
      assert.ok(fs.existsSync(markerFile(m.snagboatHome!, m.alphaStore)));
      assert.strictEqual(listUserStores(m.snagboatHome!).length, 3, 'alpha, beta, no folder');
    } finally {
      restoreEnv();
    }
  });

  test('a rerun is a no-op; after a source grows, a rerun copies only what is new', async () => {
    try {
      const m = fakeMachine();
      assert.strictEqual((await cli(['migrate'])).code, 0);
      const userDir = path.join(m.snagboatHome!, 'data');
      const first = snapshot(userDir);
      const again = JSON.parse((await cli(['migrate', '--json'])).out);
      assert.ok(again.stores.every((s: { status: string }) => s.status === 'up-to-date'), JSON.stringify(again.stores));
      assert.deepStrictEqual(snapshot(userDir), first, 'nothing changed');

      const extra = { ...m.events[0], eventId: 'brand-new-event' };
      writeDays(m.betaStore, [extra]);
      const grown = JSON.parse((await cli(['migrate', '--json'])).out);
      const beta = grown.stores.find((s: { source: string }) => s.source === m.betaStore);
      assert.strictEqual(beta.status, 'copied');
      assert.strictEqual(beta.newEvents, 1);
      assert.ok(grown.stores.filter((s: { source: string }) => s.source !== m.betaStore).every((s: { status: string }) => s.status === 'up-to-date'));
      const betaEvents = await readAll(workspaceStoreDir(m.snagboatHome!, workspaceOfVsCodeStore(m.betaStore, false)!.workspace));
      assert.strictEqual(betaEvents.filter((e) => e.eventId === 'brand-new-event').length, 1);
    } finally {
      restoreEnv();
    }
  });

  test('--dry-run counts per store and writes nothing', async () => {
    try {
      const m = fakeMachine();
      const { code, out } = await cli(['migrate', '--dry-run', '--json']);
      assert.strictEqual(code, 0);
      const report = JSON.parse(out);
      assert.ok(report.dryRun);
      const alpha = report.stores.find((s: { source: string }) => s.source === m.alphaStore);
      assert.strictEqual(alpha.status, 'would-copy');
      assert.strictEqual(alpha.events, 60);
      assert.strictEqual(alpha.newEvents, 60);
      assert.strictEqual(alpha.aggregates, 1);
      const cursor = report.stores.find((s: { source: string }) => s.source === m.alphaCursor);
      assert.strictEqual(cursor.events, 40);
      assert.strictEqual(cursor.newEvents, 20, "the 20 events Code's copy shares are counted once, as the real run copies them");
      assert.ok(!fs.existsSync(m.snagboatHome!), 'nothing written');
      const text = await cli(['migrate', '--dry-run']);
      assert.ok(text.out.startsWith('Dry run: nothing written.'), text.out);
    } finally {
      restoreEnv();
    }
  });

  test('--verify passes against a baseline taken before migrating, and fails when sessions are missing', async () => {
    try {
      const m = fakeMachine();
      const baselineRun = await cli(['sessions', '--all', '--json']);
      assert.strictEqual(baselineRun.code, 0, baselineRun.err);
      const baselineFile = path.join(m.home, 'baseline.json');
      fs.writeFileSync(baselineFile, baselineRun.out);
      assert.ok(JSON.parse(baselineRun.out).length > 0);

      const notYet = await cli(['migrate', '--verify', baselineFile]);
      assert.strictEqual(notYet.code, 1, 'nothing migrated yet');

      assert.strictEqual((await cli(['migrate'])).code, 0);
      const ok = await cli(['migrate', '--verify', baselineFile]);
      assert.strictEqual(ok.code, 0, ok.out);
      assert.ok(ok.out.startsWith('verified:'), ok.out);

      // The per-user store, read with --store user, lists the same sessions.
      const user = JSON.parse((await cli(['sessions', '--all', '--json', '--store', 'user'])).out) as Array<{ sessionId: string }>;
      const base = JSON.parse(baselineRun.out) as Array<{ sessionId: string }>;
      assert.deepStrictEqual([...new Set(user.map((s) => s.sessionId))].sort(), [...new Set(base.map((s) => s.sessionId))].sort());

      // Lose a day from the per-user store: verify fails and names what's missing.
      const betaDir = workspaceStoreDir(m.snagboatHome!, workspaceOfVsCodeStore(m.betaStore, false)!.workspace);
      for (const f of fs.readdirSync(path.join(betaDir, 'events'))) fs.rmSync(path.join(betaDir, 'events', f));
      const bad = await cli(['migrate', '--verify', baselineFile, '--json']);
      assert.strictEqual(bad.code, 1);
      assert.ok(JSON.parse(bad.out).missing.length > 0);

      const unreadable = await cli(['migrate', '--verify', path.join(m.home, 'nope.json')]);
      assert.strictEqual(unreadable.code, 2);
    } finally {
      restoreEnv();
    }
  });

  test('stores lists the per-user stores after the VS Code ones', async () => {
    try {
      fakeMachine();
      await cli(['migrate']);
      const stores = JSON.parse((await cli(['stores', '--json'])).out) as Array<{ kind: string; app: string }>;
      // alpha (Code and Cursor), beta and the global store; then alpha and beta. The global
      // store has no events, so its per-user folder has none to list either.
      assert.deepStrictEqual(stores.map((s) => s.kind), ['vscode', 'vscode', 'vscode', 'vscode', 'user', 'user']);
      assert.ok(stores.filter((s) => s.kind === 'user').every((s) => s.app === 'snagboat'));
    } finally {
      restoreEnv();
    }
  });

  test('compareToBaseline: duplicates count once, later sessions are reported but pass, changed counts fail', () => {
    const s = (sessionId: string, tokens: number) => ({ sessionId, prompts: 1, toolCalls: 2, tokens });
    const ok = compareToBaseline([s('a', 10), s('a', 5), s('b', 1)], [s('a', 10), s('b', 1), s('c', 9)]);
    assert.deepStrictEqual({ ok: ok.ok, baselineSessions: ok.baselineSessions, added: ok.added }, { ok: true, baselineSessions: 2, added: ['c'] });
    const bad = compareToBaseline([s('a', 10), s('b', 1)], [s('a', 11)]);
    assert.strictEqual(bad.ok, false);
    assert.deepStrictEqual(bad.missing, ['b']);
    assert.deepStrictEqual(bad.changed, [{ sessionId: 'a', field: 'tokens', baseline: 10, current: 11 }]);
  });

  test('migrate() with a store whose workspace.json is gone: the CLI reports it skipped', async () => {
    try {
      const m = fakeMachine();
      fs.rmSync(path.join(path.dirname(m.betaStore), 'workspace.json'));
      const { out } = await cli(['migrate', '--json']);
      const report = JSON.parse(out);
      assert.deepStrictEqual(report.skipped, [m.betaStore]);
      // And migrate() itself, for the extension: one source, straight in.
      const sources: MigrationSource[] = [{ dir: m.alphaStore, label: 'this window', info: { workspace: '/elsewhere/alpha' } }];
      const direct = await migrate(sources, [], m.snagboatHome!);
      assert.strictEqual(direct.stores[0].dest, workspaceStoreDir(m.snagboatHome!, '/elsewhere/alpha'));
    } finally {
      restoreEnv();
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
  if (failures > 0) process.exit(1);
}

main();
