import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { buildHookCommand } from '../../adapters/claude-code/hooksConfig';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { isWithinFolders, withRealPaths } from '../../core/paths';
import { installHookScript } from '../../adapters/claude-code/hookRoutes';
import { CoreService } from '../../core/service/server';
import { coreRequest } from '../../core/service/coreFile';
import { hookSpoolDir, ingestHookSpool } from '../../core/service/hooks';
import { EventLog } from '../../core/eventLog';
import { workspaceStoreDir } from '../../core/userStore';
import { saveConfig } from '../../core/config';

// End to end: the real generated sh script, run the way Claude Code runs a
// hook command, delivering to a real core.

function payload(cwd: string, command = 'echo hi') {
  return { session_id: 's1', cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} };
}

/**
 * Async on purpose: the core under test runs in this process, so a
 * synchronous spawn would block the event loop it needs to answer the request.
 */
function run(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, { env: opts.env ?? process.env });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout });
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** Runs the hook script as Claude Code would: payload on stdin, CLAUDE_PROJECT_DIR set. */
function runHook(home: string, script: string, projectDir: string, body: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  return run('sh', [script], { input: JSON.stringify(body), env: { ...process.env, SNAGBOAT_HOME: home, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv } });
}

function settle(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-home-'));
  const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-projects-')));
  const projectA = path.join(projects, 'a');
  const projectB = path.join(projects, 'b');
  fs.mkdirSync(path.join(projectA, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(projectB);
  const script = installHookScript(home);
  return { home, script, projectA, projectB };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // --- 3c-2b: the core, then the spool ---

  /** A core in this process, knowing projectA as a workspace (as if a window registered it with a token). */
  async function startCore(home: string, workspaces: string[]) {
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, ingestEveryMs: 60_000, collect: false });
    await coreRequest(core.port, core.token, 'POST', '/tokens', { workspaces });
    return core;
  }
  const storeEvents = (home: string, workspace: string) => new EventLog(workspaceStoreDir(home, workspace)).readAll();

  test('the hook goes to the core, which records it for the workspace containing it', async () => {
    const { home, script, projectA } = await setup();
    const core = await startCore(home, [projectA]);
    try {
      const deep = path.join(projectA, 'src', 'deep');
      assert.strictEqual((await runHook(home, script, deep, { ...payload(deep), tool_use_id: 't1' })).status, 0);
      const events = await storeEvents(home, projectA);
      assert.deepStrictEqual(events.map((e) => [e.eventId, e.workspace, e.kind]), [['tool:t1', projectA, 'tool_call']]);
      assert.deepStrictEqual(fs.readdirSync(hookSpoolDir(home)), [], 'nothing spooled');
      assert.deepStrictEqual(fs.readdirSync(home).filter((n) => n.startsWith('.hook-in')), [], 'no payload copy left behind');
    } finally {
      await core.stop();
    }
  });

  test("the session's project dir decides, not the payload's cwd, which follows Claude elsewhere", async () => {
    const { home, script, projectA, projectB } = await setup();
    const core = await startCore(home, [projectA, projectB]);
    try {
      // CLAUDE_PROJECT_DIR stays at A while the payload's cwd follows Claude to B.
      await runHook(home, script, projectA, { ...payload(projectB), tool_use_id: 'c1' });
      assert.deepStrictEqual((await storeEvents(home, projectA)).map((e) => e.eventId), ['tool:c1']);
      assert.deepStrictEqual(await storeEvents(home, projectB), []);
    } finally {
      await core.stop();
    }
  });

  test('non-ASCII and colon project paths reach their workspace, and under Git Bash (MSYSTEM set) travel hex-encoded', async () => {
    const { home, script, projectA } = await setup();
    // Windows itself can't make a folder named x:y.
    const names = ['café-プロジェクト', 'naïve-日本', ...(process.platform === 'win32' ? [] : ['x:y'])];
    const dirs = names.map((n) => path.join(projectA, n));
    for (const dir of dirs) fs.mkdirSync(dir);
    const core = await startCore(home, dirs);
    try {
      for (const [i, dir] of dirs.entries()) {
        await runHook(home, script, dir, { ...payload(dir), tool_use_id: `p${i}` });
        await runHook(home, script, dir, { ...payload(dir), tool_use_id: `m${i}` }, { MSYSTEM: 'MINGW64' });
        assert.deepStrictEqual((await storeEvents(home, dir)).map((e) => e.eventId).sort(), [`tool:m${i}`, `tool:p${i}`], dir);
      }
    } finally {
      await core.stop();
    }
  });

  test('routes an earlier Snagboat left for its windows are ignored: the core gets the hook', async () => {
    const { home, script, projectA } = await setup();
    const core = await startCore(home, [projectA]);
    // A live listener that would take any hook, named by a route file as an old window's was.
    let taken = 0;
    const old = http.createServer((req, res) => {
      taken += 1;
      req.resume();
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    try {
      fs.mkdirSync(path.join(home, 'routes'));
      fs.writeFileSync(path.join(home, 'routes', projectA.replace(/[\\/:]/g, '-')), `${(old.address() as { port: number }).port} x ${process.pid}\n`);
      await runHook(home, script, projectA, { ...payload(projectA), tool_use_id: 'r1' });
      assert.deepStrictEqual((await storeEvents(home, projectA)).map((e) => e.eventId), ['tool:r1']);
      assert.strictEqual(taken, 0);
    } finally {
      old.close();
      await core.stop();
    }
  });

  test('without a core ever having run, the hook exits 0 quickly, nothing is spooled and nothing is left behind', async () => {
    const { home, script, projectA } = await setup();
    const started = Date.now();
    assert.strictEqual((await runHook(home, script, projectA, payload(projectA))).status, 0);
    assert.ok(Date.now() - started < 2000, 'never waits on a missing core');
    assert.ok(!fs.existsSync(hookSpoolDir(home)), 'no spool');
    assert.deepStrictEqual(fs.readdirSync(home).filter((n) => n.startsWith('.hook-in')), [], 'the payload copy is removed');
  });

  test('once a core has run, a hook with no core running is spooled (owner-only), and the next core records it with the time it ran', async () => {
    const { home, script, projectA } = await setup();
    await (await startCore(home, [])).stop(); // a core ran once: the spool folder exists
    const before = Date.now();
    assert.strictEqual((await runHook(home, script, projectA, { ...payload(projectA), tool_use_id: 's1' })).status, 0);
    // The hook may take over a second to start (Git Bash on Windows), so "when it ran" is between before and here.
    const ran = Date.now();
    const spooled = fs.readdirSync(hookSpoolDir(home));
    assert.strictEqual(spooled.length, 1, spooled.join());
    assert.match(spooled[0], /^\d+-\d+\.hook$/);
    const text = fs.readFileSync(path.join(hookSpoolDir(home), spooled[0]), 'utf8');
    assert.strictEqual(text.split('\n')[0], projectA, 'the project dir on the first line');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(hookSpoolDir(home), spooled[0])).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(hookSpoolDir(home)).mode & 0o777, 0o700);
    }
    await new Promise((r) => setTimeout(r, 1100)); // so "recorded at ingest time" would show
    const core = await startCore(home, [projectA]);
    try {
      const deadline = Date.now() + 5000;
      while ((await storeEvents(home, projectA)).length === 0 && Date.now() < deadline) await settle(50);
      const [event] = await storeEvents(home, projectA);
      assert.strictEqual(event?.eventId, 'tool:s1');
      const ts = Date.parse(event.ts);
      assert.ok(ts >= Math.floor(before / 1000) * 1000 && ts <= ran, `timestamped when it ran, not when ingested: ${event.ts}`);
      assert.deepStrictEqual(fs.readdirSync(hookSpoolDir(home)), [], 'spool emptied');
    } finally {
      await core.stop();
    }
  });

  test('the core records a project no window knows, under its own folder, unless collect.unopened is off', async () => {
    const { home, script, projectA, projectB } = await setup();
    const core = await startCore(home, [projectA]);
    try {
      await runHook(home, script, projectB, { ...payload(projectB), tool_use_id: 'u1' });
      assert.deepStrictEqual((await storeEvents(home, projectB)).map((e) => [e.eventId, e.workspace]), [['tool:u1', projectB]]);
      saveConfig(home, { version: 1, defaults: { 'collect.unopened': false }, projects: {} });
      const other = path.join(path.dirname(projectB), 'c');
      fs.mkdirSync(other);
      await runHook(home, script, other, payload(other));
      assert.ok(!fs.existsSync(workspaceStoreDir(home, other)), 'not recorded with collect.unopened off');
      await runHook(home, script, projectA, { ...payload(projectA), tool_use_id: 'k1' });
      assert.deepStrictEqual((await storeEvents(home, projectA)).map((e) => e.eventId), ['tool:k1'], 'a known workspace is still recorded');
      assert.deepStrictEqual(fs.readdirSync(hookSpoolDir(home)), [], 'nothing spooled');
    } finally {
      await core.stop();
    }
  });

  test('the hook token in core.route posts hooks and nothing else; a payload file a dead script left is cleaned up', async () => {
    const { home, projectA } = await setup();
    const core = await startCore(home, [projectA]);
    try {
      const [port, hookToken, pid] = fs.readFileSync(path.join(home, 'core.route'), 'utf8').trim().split(/\s+/);
      assert.deepStrictEqual([Number(port), Number(pid)], [core.port, process.pid]);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(home, 'core.route')).mode & 0o777, 0o600);
      assert.strictEqual((await coreRequest(core.port, hookToken, 'GET', '/sessions')).status, 401);
      assert.strictEqual((await coreRequest(core.port, 'wrong', 'POST', '/hook', payload(projectA))).status, 401);
      // A pid the way the script names its files: under Git Bash its Windows pid, not the MSYS $$.
      const dead = childProcess.spawnSync('sh', ['-c', 'me=$$; [ -r "/proc/$$/winpid" ] && read -r me < "/proc/$$/winpid"; echo $me']).stdout.toString().trim();
      fs.writeFileSync(path.join(home, `.hook-in.${dead}`), '{"partial');
      fs.writeFileSync(path.join(hookSpoolDir(home), `.${dead}.tmp`), '/w\n{"partial');
      await ingestHookSpool(home, async () => undefined);
      assert.deepStrictEqual(fs.readdirSync(hookSpoolDir(home)), []);
      assert.ok(!fs.existsSync(path.join(home, `.hook-in.${dead}`)));
    } finally {
      await core.stop();
    }
    assert.ok(!fs.existsSync(path.join(home, 'core.route')), 'core.route removed on stop');
  });

  test('Windows paths: transcript folder names and the hook command', () => {
    assert.strictEqual(sanitizeCwd('C:\\Users\\dc\\proj'), 'C--Users-dc-proj');
    const scriptPath = path.join(os.homedir(), '.snagboat', 'bin', 'snagboat-hook');
    const win = buildHookCommand(scriptPath, 'win32');
    assert.ok(win.startsWith('sh "$HOME/'), win);
    assert.ok(!win.includes('\\'), 'no backslashes for Git Bash');
    assert.ok(buildHookCommand(scriptPath, 'linux').startsWith('"$HOME'), 'POSIX command is unchanged');
  });

  test('the script is executable, and writable only by the user', async () => {
    const { script } = await setup();
    // Windows has no POSIX modes; there the file is private by living in the user's profile.
    if (process.platform === 'win32') return;
    assert.strictEqual(fs.statSync(script).mode & 0o777, 0o755);
  });

  test('isWithinFolders and withRealPaths', () => {
    assert.ok(isWithinFolders('/w/a', ['/w/a']));
    assert.ok(isWithinFolders('/w/a/src', ['/w/a']));
    assert.ok(!isWithinFolders('/w/ab', ['/w/a']), 'a sibling with a shared prefix is outside');
    assert.ok(!isWithinFolders('/w', ['/w/a']));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-real-'));
    const both = withRealPaths([tmp]);
    assert.ok(both.includes(tmp) && both.includes(fs.realpathSync(tmp)));
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
