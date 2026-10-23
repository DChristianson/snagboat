import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HooksReceiver } from '../../adapters/claude-code/hooksReceiver';
import { isWithinFolders, withRealPaths } from '../../core/paths';
import {
  installHookScript,
  newToken,
  pruneStaleRoutes,
  removeRoutes,
  routeKey,
  writeRoutes,
} from '../../adapters/claude-code/hookRoutes';
import { AdapterContext, NormalizedEvent } from '../../core/types';

// End to end: the real generated sh script, run the way Claude Code runs a
// hook command, delivering to a real HooksReceiver.

function fakeCtx() {
  const published: NormalizedEvent[] = [];
  const ctx: AdapterContext = {
    publish: (e) => published.push(e),
    readCheckpoint: async () => undefined,
    writeCheckpoint: async () => undefined,
    reportHealth: () => undefined,
    captureContent: () => false,
  };
  return { ctx, published };
}

function payload(cwd: string, command = 'echo hi') {
  return { session_id: 's1', cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} };
}

/**
 * Async on purpose: the receiver under test runs in this process, so a
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
function runHook(home: string, script: string, projectDir: string, body: unknown) {
  return run('sh', [script], { input: JSON.stringify(body), env: { ...process.env, SNAGBOAT_HOME: home, CLAUDE_PROJECT_DIR: projectDir } });
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

async function startWindow(home: string, folders: string[]) {
  const { ctx, published } = fakeCtx();
  const token = newToken();
  const receiver = new HooksReceiver(ctx, { token, workspaceFolders: folders });
  const port = await receiver.start();
  writeRoutes(home, folders, { port, token, pid: process.pid });
  return { receiver, published, port, token };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('each project reaches only its own window, from the project root or any subfolder', async () => {
    const { home, script, projectA, projectB } = await setup();
    const a = await startWindow(home, [projectA]);
    const b = await startWindow(home, [projectB]);
    try {
      assert.notStrictEqual(a.port, b.port, 'each window gets its own free port');
      assert.strictEqual((await runHook(home, script, projectA, payload(projectA))).status, 0);
      assert.strictEqual((await runHook(home, script, path.join(projectA, 'src', 'deep'), payload(path.join(projectA, 'src', 'deep')))).status, 0);
      assert.strictEqual((await runHook(home, script, projectB, payload(projectB))).status, 0);
      await settle();
      assert.strictEqual(a.published.length, 2);
      assert.strictEqual(b.published.length, 1);
    } finally {
      a.receiver.stop();
      b.receiver.stop();
    }
  });

  test('with no window for the project, the hook exits 0 quickly and delivers nothing', async () => {
    const { home, script, projectA, projectB } = await setup();
    const a = await startWindow(home, [projectA]);
    try {
      const started = Date.now();
      const result = await runHook(home, script, projectB, payload(projectB));
      assert.strictEqual(result.status, 0);
      assert.ok(Date.now() - started < 2000, 'never waits on a missing window');
      await settle();
      assert.strictEqual(a.published.length, 0, "another project's window must not receive it");
    } finally {
      a.receiver.stop();
    }
  });

  test('a route left by a dead window is skipped by the script and pruned on the next activation', async () => {
    const { home, script, projectA } = await setup();
    const dead = childProcess.spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
    writeRoutes(home, [projectA], { port: 9, token: 'x', pid: Number(dead) });
    assert.strictEqual((await runHook(home, script, projectA, payload(projectA))).status, 0);
    pruneStaleRoutes(home);
    assert.ok(!fs.existsSync(path.join(home, 'routes', routeKey(projectA))));
  });

  test('requests without the right token are rejected and not published', async () => {
    const { home, projectA } = await setup();
    const a = await startWindow(home, [projectA]);
    try {
      for (const auth of [undefined, 'Bearer wrong', `Bearer ${a.token}x`]) {
        const args = ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', `http://127.0.0.1:${a.port}/hook`, '--data-binary', JSON.stringify(payload(projectA))];
        if (auth) args.push('-H', `Authorization: ${auth}`);
        assert.strictEqual((await run('curl', args)).stdout, '401', `auth: ${auth ?? 'none'}`);
      }
      await settle();
      assert.strictEqual(a.published.length, 0);
    } finally {
      a.receiver.stop();
    }
  });

  test("hooks are accepted when Claude has cd'd outside the project, since routing uses the session's project dir", async () => {
    const { home, script, projectA, projectB } = await setup();
    const a = await startWindow(home, [projectA]);
    try {
      // CLAUDE_PROJECT_DIR stays at A while the payload's cwd follows Claude to B.
      await runHook(home, script, projectA, payload(projectB));
      await settle();
      assert.strictEqual(a.published.length, 1);
    } finally {
      a.receiver.stop();
    }
  });

  test('a hook misrouted by a route-name collision is refused by the wrong window', async () => {
    const { home, script, projectA } = await setup();
    const dashed = path.join(projectA, 'x-y'); // route name ...-a-x-y
    const nested = path.join(projectA, 'x', 'y'); // the same route name
    fs.mkdirSync(dashed);
    fs.mkdirSync(nested, { recursive: true });
    const w = await startWindow(home, [dashed]);
    try {
      assert.strictEqual(routeKey(dashed), routeKey(nested));
      await runHook(home, script, nested, payload(nested));
      await settle();
      assert.strictEqual(w.published.length, 0);
    } finally {
      w.receiver.stop();
    }
  });

  test('requests without the project header are refused even with the token', async () => {
    const { home, projectA } = await setup();
    const a = await startWindow(home, [projectA]);
    try {
      const args = ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', `http://127.0.0.1:${a.port}/hook`, '-H', `Authorization: Bearer ${a.token}`, '--data-binary', JSON.stringify(payload(projectA))];
      assert.strictEqual((await run('curl', args)).stdout, '421');
      await settle();
      assert.strictEqual(a.published.length, 0);
    } finally {
      a.receiver.stop();
    }
  });

  test('non-ASCII project paths route and match', async () => {
    const { home, script, projectA } = await setup();
    const unicode = path.join(projectA, 'café-プロジェクト');
    fs.mkdirSync(unicode);
    const w = await startWindow(home, [unicode]);
    try {
      await runHook(home, script, unicode, payload(unicode));
      await settle();
      assert.strictEqual(w.published.length, 1);
    } finally {
      w.receiver.stop();
    }
  });

  test('removeRoutes deletes only routes this window still owns', async () => {
    const { home, projectA, projectB } = await setup();
    writeRoutes(home, [projectA, projectB], { port: 1000, token: 't', pid: process.pid });
    writeRoutes(home, [projectB], { port: 2000, token: 'u', pid: process.ppid }); // another window took B
    removeRoutes(home, [projectA, projectB], process.pid);
    assert.ok(!fs.existsSync(path.join(home, 'routes', routeKey(projectA))));
    assert.ok(fs.existsSync(path.join(home, 'routes', routeKey(projectB))));
  });

  test('route and script files are private to the user', async () => {
    const { home, script, projectA } = await setup();
    writeRoutes(home, [projectA], { port: 1000, token: 't', pid: process.pid });
    assert.strictEqual(fs.statSync(path.join(home, 'routes', routeKey(projectA))).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(home, 'routes')).mode & 0o777, 0o700);
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
