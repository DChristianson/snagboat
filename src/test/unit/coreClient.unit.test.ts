import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { EventLog } from '../../core/eventLog';
import { claimedBy } from '../../core/service/claims';
import { CoreClient } from '../../core/service/client';
import { CoreInfo, coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { spoolDir, StoreWriter } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';

// A VS Code window as a client of the core (docs/design/handoff-3c.md, 3c-3c): the live
// feed scoped to its workspace, the replay that covers a reconnect, posting events the
// window sees (and spooling them when the core is down), and holding the folder for a rewrite.

function machine() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-client-')));
  const home = path.join(root, '.snagboat');
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return { root, home, projects, a: path.join(root, 'a'), b: path.join(root, 'b') };
}

const ev = (id: string, workspace?: string, ts = new Date().toISOString()): NormalizedEvent => ({
  eventId: id,
  sessionId: 's',
  agent: 'copilot',
  ts,
  kind: 'turn_stop',
  status: 'success',
  raw: { adapter: 'test', ref: id },
  ...(workspace ? { workspace } : {}),
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const start = (home: string, extra: Partial<Parameters<typeof CoreService.start>[0]> = {}) =>
  CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, collect: false, ...extra });

/** The running core's core.json, as ensureCore would return it; throws while none runs. */
const running = (home: string) => async (): Promise<CoreInfo> => {
  const info = readCoreFile(home);
  if (!info) throw new Error('no core running');
  return info;
};

/** A client following its workspace, collecting what the feed sends. */
async function follower(home: string, workspace: string, changedSince = new Date().toISOString()) {
  const client = await CoreClient.connect({ home, cliPath: '/nowhere', workspace, ensure: running(home) });
  const got: NormalizedEvent[] = [];
  let replays = 0;
  client.follow({ onEvents: (events) => got.push(...events), onReplayed: () => (replays += 1) }, changedSince);
  await waitFor(() => replays > 0);
  return { client, got, ids: () => got.map((e) => e.eventId), replays: () => replays };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test("a window's feed carries what's written to its workspace, and nothing of another's", async () => {
    const { home, a, b } = machine();
    const core = await start(home);
    try {
      const fa = await follower(home, a);
      const fb = await follower(home, b);
      await fa.client.post([ev('a1'), ev('a2')]);
      await fb.client.post([ev('b1')]);
      await waitFor(() => fa.got.length === 2 && fb.got.length === 1);
      assert.deepStrictEqual(fa.ids(), ['a1', 'a2']);
      assert.ok(fa.got.every((e) => e.workspace === a), 'tagged with the workspace');
      assert.deepStrictEqual(fb.ids(), ['b1']);
      // A repeat is a duplicate in the store, and not sent again.
      await fa.client.post([ev('a1')]);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepStrictEqual(fa.ids(), ['a1', 'a2']);
      // The token can't write the other workspace.
      const info = readCoreFile(home)!;
      const minted = await coreRequest(info.port, info.token, 'POST', '/tokens', { workspaces: [a] });
      const res = await coreRequest(info.port, (minted.body as { token: string }).token, 'POST', '/events', ev('x', b));
      assert.strictEqual(res.status, 403);
      fa.client.close();
      fb.client.close();
    } finally {
      await core.stop();
    }
  });

  test('following replays the day files written since the window read its store', async () => {
    const { home, a } = machine();
    const before = new Date(Date.now() - 60_000).toISOString();
    await new StoreWriter(home).write([ev('old', a)]);
    const core = await start(home);
    try {
      const recent = await follower(home, a, before);
      assert.deepStrictEqual(recent.ids(), ['old'], 'written after the read: replayed');
      recent.client.close();
      const later = await follower(home, a, new Date(Date.now() + 60_000).toISOString());
      assert.deepStrictEqual(later.ids(), [], 'nothing changed since: nothing replayed');
      later.client.close();
    } finally {
      await core.stop();
    }
  });

  test('a lost core: posts are spooled, and the client reconnects to the next core with a new token and catches up', async () => {
    const { home, a } = machine();
    let core = await start(home);
    const f = await follower(home, a);
    try {
      await f.client.post([ev('first')]);
      await waitFor(() => f.got.length === 1);
      await core.stop();
      // Down: what the window sees is kept for the next core.
      await f.client.post([ev('while-down')]);
      assert.ok(fs.readdirSync(spoolDir(home)).length === 1, 'spooled');
      // Written while the window was disconnected (by the next core, before the window is back).
      await new StoreWriter(home).write([ev('missed', a)]);
      core = await start(home);
      await waitFor(() => f.replays() >= 2, 15_000);
      await waitFor(() => f.ids().includes('while-down') && f.ids().includes('missed'), 15_000);
      await f.client.post([ev('after')]);
      await waitFor(() => f.ids().includes('after'));
      assert.deepStrictEqual([...new Set(f.ids())].sort(), ['after', 'first', 'missed', 'while-down']);
    } finally {
      f.client.close();
      await core.stop();
    }
  });

  test("holding the folder: the core writes nothing there, keeps (doesn't drop) the window's own project, and catches up after", async () => {
    const { home, projects, a } = machine();
    fs.mkdirSync(a, { recursive: true });
    const core = await start(home, { collect: true, claudeProjectsDir: projects, copilotSessionsDir: path.join(projects, '..', 'no-copilot') });
    const f = await follower(home, a);
    const dir = workspaceStoreDir(home, a);
    const transcript = (session: string) => {
      const folder = path.join(projects, sanitizeCwd(a));
      fs.mkdirSync(folder, { recursive: true });
      const ts = new Date().toISOString();
      fs.appendFileSync(
        path.join(folder, `${session}.jsonl`),
        JSON.stringify({ type: 'user', uuid: `${session}-u`, sessionId: session, cwd: a, timestamp: ts, promptId: `${session}-p`, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n'
      );
    };
    try {
      transcript('before');
      await waitFor(() => f.got.some((e) => e.sessionId === 'before'), 15_000);
      let during: string[] = [];
      await f.client.hold(dir, async () => {
        assert.strictEqual(claimedBy(dir), process.pid, 'held');
        transcript('during');
        await waitFor(() => fs.existsSync(spoolDir(home)) && fs.readdirSync(spoolDir(home)).length === 1, 15_000);
        during = (await new EventLog(dir).readAll()).map((e) => e.sessionId);
        // A rewrite: everything is cleared, as Clear Event Log does.
        await new EventLog(dir).clear();
      });
      assert.ok(!during.includes('during'), 'nothing written while held');
      assert.strictEqual(claimedBy(dir), undefined, 'let go');
      await waitFor(() => f.got.some((e) => e.sessionId === 'during'));
      const stored = (await new EventLog(dir).readAll()).map((e) => e.sessionId);
      assert.deepStrictEqual(stored, ['during'], 'spooled, then written once the hold ended; the cleared events stay cleared');
    } finally {
      f.client.close();
      await core.stop();
    }
  });

  test('an open feed keeps the core from going idle', async () => {
    const { home, a } = machine();
    const core = await start(home, { idleMs: 300 });
    const f = await follower(home, a);
    try {
      // The idle check runs every min(idleMs, 60s); well past idleMs with the feed open, it's still up.
      await new Promise((r) => setTimeout(r, 1_200));
      assert.strictEqual((await coreRequest(core.port, readCoreFile(home)!.token, 'GET', '/health')).status, 200);
    } finally {
      f.client.close();
    }
    await waitFor(() => readCoreFile(home) === undefined, 5_000);
  });

  test('a saved multi-root workspace: projects in its folders are recorded under its .code-workspace file and reach its window', async () => {
    const { home, projects, root } = machine();
    const one = path.join(root, 'one');
    fs.mkdirSync(one, { recursive: true });
    const file = path.join(root, 'both.code-workspace');
    const core = await start(home, { collect: true, claudeProjectsDir: projects, copilotSessionsDir: path.join(projects, '..', 'no-copilot') });
    const client = await CoreClient.connect({ home, cliPath: '/nowhere', workspace: file, folders: [one], ensure: running(home) });
    const got: NormalizedEvent[] = [];
    client.follow({ onEvents: (e) => got.push(...e) }, new Date().toISOString());
    try {
      const folder = path.join(projects, sanitizeCwd(one));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'm.jsonl'), JSON.stringify({ type: 'user', uuid: 'm-u', sessionId: 'm', cwd: one, timestamp: new Date().toISOString(), promptId: 'm-p', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
      await waitFor(() => got.some((e) => e.sessionId === 'm'), 15_000);
      assert.ok(got.every((e) => e.workspace === file));
      assert.ok(!fs.existsSync(workspaceStoreDir(home, one)), 'not under the folder itself');
    } finally {
      client.close();
      await core.stop();
    }
  });

  test("a window's retention request prunes its workspace now", async () => {
    const { home, a, b } = machine();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const withText = (id: string, w: string) => ({ ...ev(id, w, old), kind: 'user_prompt' as const, promptText: 'secret' });
    // Written while the text was young enough to keep (the writer's clock 40 days ago).
    await new StoreWriter(home, () => Date.parse(old)).write([withText('pa', a), withText('pb', b)]);
    const core = await start(home, { retentionEveryMs: 3_600_000 });
    try {
      await new Promise((r) => setTimeout(r, 300)); // the core's own run at start
      const client = await CoreClient.connect({ home, cliPath: '/nowhere', workspace: a, ensure: running(home) });
      await client.retention();
      assert.strictEqual((await new EventLog(workspaceStoreDir(home, a)).readAll())[0].promptText, undefined, 'text past 30 days removed');
      client.close();
    } finally {
      await core.stop();
    }
  });

  test('a core from an older Snagboat (no live feed) is refused, not waited on', async () => {
    const server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, version: '0.0.1' })));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const { home, a } = machine();
      await assert.rejects(
        CoreClient.connect({ home, cliPath: '/nowhere', workspace: a, ensure: async () => ({ port, token: 't', pid: 1, version: '0.0.1', startedAt: '' }) }),
        /older than this extension/
      );
    } finally {
      server.close();
    }
  });

  test('a core stopped on purpose is not started again by its clients; they rejoin the next one', async () => {
    const { home, a } = machine();
    let core = await start(home);
    let ensured = 0;
    const client = await CoreClient.connect({ home, cliPath: '/nowhere', workspace: a, ensure: () => ((ensured += 1), running(home)()) });
    let replays = 0;
    const got: string[] = [];
    client.follow({ onEvents: (e) => got.push(...e.map((x) => x.eventId)), onReplayed: () => (replays += 1) }, new Date().toISOString());
    try {
      await waitFor(() => replays === 1);
      await core.stop({ final: true }); // as POST /shutdown does
      await new Promise((r) => setTimeout(r, 2_500));
      assert.strictEqual(ensured, 1, 'only the first connect asked to start one');
      core = await start(home);
      await waitFor(() => replays === 2, 15_000);
      // Right after the restart, a hold re-authorizes for its flush.
      await client.hold(workspaceStoreDir(home, a), async () => undefined);
      await client.post([ev('back')]);
      await waitFor(() => got.includes('back'));
    } finally {
      client.close();
      await core.stop();
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
