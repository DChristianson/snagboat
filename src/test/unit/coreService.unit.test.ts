import * as assert from 'assert';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { runCli } from '../../cli/main';
import { EventLog } from '../../core/eventLog';
import { claimWorkspace, claimedBy, releaseClaim } from '../../core/service/claims';
import { coreFilePath, coreRequest, readCoreFile, writeCoreFile } from '../../core/service/coreFile';
import { CoreRunningError, CoreService } from '../../core/service/server';
import { spoolDir } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';
import { syntheticEvents } from '../fixtures/synthetic';

// The core service (docs/design/handoff-3c.md, 3c-2a): core.json, tokens and their
// workspace scopes, writing events, the claim a VS Code window holds on its
// workspace's folder, the spool, idle exit, and starting one in the background.

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-core-'));

/** A pid that was real and has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

/** A process that stays alive until killed, standing in for another core or a VS Code window. */
function liveProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function start(home: string, extra: Partial<Parameters<typeof CoreService.start>[0]> = {}) {
  return CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 50, collect: false, ...extra });
}

const ev = (i: number, sessionId = 's1'): NormalizedEvent => ({ ...syntheticEvents()[i], sessionId, eventId: `e-${sessionId}-${i}` });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('starting writes core.json (owner-only) and answers health only with a token', async () => {
    const home = tempHome();
    const core = await start(home);
    try {
      const info = readCoreFile(home)!;
      assert.deepStrictEqual({ port: info.port, pid: info.pid, version: info.version }, { port: core.port, pid: process.pid, version: 'test' });
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(coreFilePath(home)).mode & 0o777, 0o600);
      assert.strictEqual((await coreRequest(core.port, info.token, 'GET', '/health')).status, 200);
      assert.strictEqual((await coreRequest(core.port, 'nope', 'GET', '/health')).status, 401);
      assert.strictEqual((await coreRequest(core.port, info.token, 'GET', '/nowhere')).status, 404);
    } finally {
      await core.stop();
    }
    assert.ok(!fs.existsSync(coreFilePath(home)), 'core.json removed on stop');
    assert.ok(!fs.existsSync(path.join(home, 'core.lock')), 'lock released on stop');
  });

  test("a second core doesn't start while one runs; a stale core.json and lock are replaced", async () => {
    const home = tempHome();
    const other = liveProcess();
    try {
      writeCoreFile(home, { port: 1, token: 't', pid: other.pid!, version: 'x', startedAt: '' });
      await assert.rejects(start(home), CoreRunningError);
      fs.rmSync(coreFilePath(home));
      fs.writeFileSync(path.join(home, 'core.lock'), String(other.pid));
      await assert.rejects(start(home), CoreRunningError, 'the lock alone keeps a second core out');
    } finally {
      other.kill();
    }
    const dead = deadPid();
    writeCoreFile(home, { port: 1, token: 't', pid: dead, version: 'x', startedAt: '' });
    fs.writeFileSync(path.join(home, 'core.lock'), String(dead));
    const core = await start(home);
    try {
      assert.strictEqual(readCoreFile(home)!.pid, process.pid);
    } finally {
      await core.stop();
    }
  });

  test('workspace tokens write and read only their workspaces; the admin token reads all', async () => {
    const home = tempHome();
    const core = await start(home);
    try {
      const admin = core.token;
      const mint = async (workspaces: string[]) => (await coreRequest(core.port, admin, 'POST', '/tokens', { workspaces })).body as { token: string };
      const alpha = (await mint(['/w/alpha'])).token;
      const beta = (await mint(['/w/beta'])).token;

      const posted = await coreRequest(core.port, alpha, 'POST', '/events', [ev(0, 'a1'), ev(1, 'a1')]);
      assert.deepStrictEqual(posted, { status: 200, body: { written: 2, duplicates: 0, spooled: 0, dropped: 0 } });
      assert.strictEqual((await coreRequest(core.port, beta, 'POST', '/events', ev(2, 'b1'))).status, 200);
      const onDisk = await new EventLog(workspaceStoreDir(home, '/w/alpha')).readAll();
      assert.ok(onDisk.length === 2 && onDisk.every((e) => e.workspace === '/w/alpha'), 'tagged with the token workspace');

      const sessionsOf = async (token: string) => ((await coreRequest(core.port, token, 'GET', '/sessions')).body as Array<{ sessionId: string; workspace: string }>).map((s) => s.sessionId).sort();
      assert.deepStrictEqual(await sessionsOf(alpha), ['a1']);
      assert.deepStrictEqual(await sessionsOf(beta), ['b1']);
      assert.deepStrictEqual(await sessionsOf(admin), ['a1', 'b1']);
      assert.strictEqual((await coreRequest(core.port, alpha, 'GET', '/sessions/a1')).status, 200);
      assert.strictEqual((await coreRequest(core.port, alpha, 'GET', '/sessions/b1')).status, 404, "another workspace's session isn't visible");

      assert.strictEqual((await coreRequest(core.port, alpha, 'POST', '/events', { ...ev(3), workspace: '/w/beta' })).status, 403);
      assert.strictEqual((await coreRequest(core.port, alpha, 'POST', '/tokens', { workspaces: ['/w/beta'] })).status, 403, 'only admin mints');
      assert.strictEqual((await coreRequest(core.port, admin, 'POST', '/events', ev(3))).status, 400, 'admin events must name a workspace');
      assert.strictEqual((await coreRequest(core.port, admin, 'POST', '/events', { eventId: 'x' })).status, 400);
      assert.strictEqual((await coreRequest(core.port, alpha, 'POST', '/shutdown')).status, 403);
    } finally {
      await core.stop();
    }
  });

  test('an event posted twice is written once', async () => {
    const home = tempHome();
    const core = await start(home);
    try {
      const { token } = (await coreRequest(core.port, core.token, 'POST', '/tokens', { workspaces: ['/w/a'] })).body as { token: string };
      await coreRequest(core.port, token, 'POST', '/events', ev(0));
      const again = await coreRequest(core.port, token, 'POST', '/events', [ev(0), ev(1)]);
      assert.deepStrictEqual(again.body, { written: 1, duplicates: 1, spooled: 0, dropped: 0 });
      assert.strictEqual((await new EventLog(workspaceStoreDir(home, '/w/a')).readAll()).length, 2);
    } finally {
      await core.stop();
    }
  });

  test("a window's claim sends events to the spool; once the claim is gone they're written", async () => {
    const home = tempHome();
    const dir = workspaceStoreDir(home, '/w/claimed');
    const window = liveProcess();
    const core = await start(home);
    try {
      claimWorkspace(dir, window.pid!);
      assert.strictEqual(claimedBy(dir), window.pid);
      const { token } = (await coreRequest(core.port, core.token, 'POST', '/tokens', { workspaces: ['/w/claimed'] })).body as { token: string };
      assert.deepStrictEqual((await coreRequest(core.port, token, 'POST', '/events', [ev(0), ev(1)])).body, { written: 0, duplicates: 0, spooled: 2, dropped: 0 });
      assert.strictEqual((await new EventLog(dir).readAll()).length, 0, 'nothing written while claimed');
      assert.ok(fs.readdirSync(spoolDir(home)).length === 1);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(spoolDir(home)).mode & 0o777, 0o700);

      window.kill();
      await waitFor(() => claimedBy(dir) === undefined);
      await waitFor(async () => (await new EventLog(dir).readAll()).length === 2);
      // The spool file is removed just after its events are written, so wait for that too.
      await waitFor(() => fs.readdirSync(spoolDir(home)).length === 0);
    } finally {
      window.kill();
      await core.stop();
    }
    claimWorkspace(dir, 12345);
    releaseClaim(dir, 999);
    assert.ok(fs.existsSync(path.join(dir, 'writer.json')), "release leaves another process's claim");
    releaseClaim(dir, 12345);
    assert.ok(!fs.existsSync(path.join(dir, 'writer.json')));
  });

  test('a spool file left mid-ingest by a core that exited is ingested', async () => {
    const home = tempHome();
    fs.mkdirSync(spoolDir(home), { recursive: true });
    fs.writeFileSync(path.join(spoolDir(home), `x.jsonl.${deadPid()}.ingesting`), JSON.stringify({ ...ev(0), workspace: '/w/left' }) + '\n');
    const core = await start(home);
    try {
      await waitFor(async () => (await new EventLog(workspaceStoreDir(home, '/w/left')).readAll()).length === 1);
      await waitFor(() => fs.readdirSync(spoolDir(home)).length === 0);
    } finally {
      await core.stop();
    }
  });

  test('the core stops by itself after the idle period, and when the admin asks', async () => {
    const home = tempHome();
    const idle = await start(home, { idleMs: 150 });
    await Promise.race([idle.stopped, new Promise((_, reject) => setTimeout(() => reject(new Error('did not stop when idle')), 3_000))]);
    assert.ok(!fs.existsSync(coreFilePath(home)));
    const asked = await start(home);
    assert.strictEqual((await coreRequest(asked.port, asked.token, 'POST', '/shutdown')).status, 200);
    await asked.stopped;
  });

  test('`snagboat core start` runs one in the background; status and stop find it', async () => {
    const home = tempHome();
    const saved = process.env.SNAGBOAT_HOME;
    const savedProjects = process.env.SNAGBOAT_CLAUDE_PROJECTS_DIR;
    process.env.SNAGBOAT_HOME = home;
    // The background core collects transcripts: point it at an empty folder, not this machine's.
    process.env.SNAGBOAT_CLAUDE_PROJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-no-projects-'));
    const savedCopilot = process.env.SNAGBOAT_COPILOT_SESSIONS_DIR;
    process.env.SNAGBOAT_COPILOT_SESSIONS_DIR = process.env.SNAGBOAT_CLAUDE_PROJECTS_DIR;
    const cli = async (args: string[]) => {
      let out = '';
      let err = '';
      const code = await runCli(args, { out: (t) => (out += t), err: (t) => (err += t), cwd: home, now: new Date() }, 'test');
      return { code, out, err };
    };
    try {
      assert.strictEqual((await cli(['core', 'status'])).code, 1, 'not running yet');
      const started = await cli(['core', 'start', '--json']);
      assert.strictEqual(started.code, 0, started.err);
      const pid = JSON.parse(started.out).pid as number;
      assert.notStrictEqual(pid, process.pid, 'a separate process');
      const again = await cli(['core', 'start', '--json']);
      assert.strictEqual(JSON.parse(again.out).pid, pid, 'a second start finds the running one');
      const status = await cli(['core', 'status', '--json']);
      assert.strictEqual(JSON.parse(status.out).running, true);
      const stopped = await cli(['core', 'stop']);
      assert.strictEqual(stopped.code, 0, stopped.out + stopped.err);
      assert.strictEqual((await cli(['core', 'status'])).code, 1);
    } finally {
      const info = readCoreFile(home);
      if (info && info.pid !== process.pid) {
        try {
          process.kill(info.pid);
        } catch {
          // already gone
        }
      }
      if (saved === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved;
      if (savedProjects === undefined) delete process.env.SNAGBOAT_CLAUDE_PROJECTS_DIR;
      else process.env.SNAGBOAT_CLAUDE_PROJECTS_DIR = savedProjects;
      if (savedCopilot === undefined) delete process.env.SNAGBOAT_COPILOT_SESSIONS_DIR;
      else process.env.SNAGBOAT_COPILOT_SESSIONS_DIR = savedCopilot;
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
