import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyCommand, NormalizedEvent } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { runCli } from '../../cli/main';
import { CoreClient } from '../../core/service/client';
import { CoreInfo, coreRequest, readCoreFile } from '../../core/service/coreFile';
import { WorkspaceFindings } from '../../core/service/findings';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// Heuristics in the core (docs/design/handoff-3c.md, 3c-3d): a workspace's findings are
// worked out where its events are written, from its own rules and settings
// (config.json), sent on its window's stream as they change, and answered by GET /findings.

const RULE = {
  id: 'test:model-calls',
  title: 'Any model call',
  scope: 'session',
  measure: { type: 'count', filter: { kind: 'turn_stop', hasTokens: true } },
  when: { gte: 2 },
  severity: 'info',
  summary: '{value} model calls',
};

function machine() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-findings-')));
  return { root, home: path.join(root, '.snagboat'), a: path.join(root, 'a'), b: path.join(root, 'b') };
}

let n = 0;
const call = (workspace?: string): NormalizedEvent => ({
  eventId: `call-${(n += 1)}`,
  sessionId: 's1',
  agent: 'claude-code',
  ts: new Date().toISOString(),
  kind: 'turn_stop',
  status: 'success',
  model: 'claude-sonnet-5',
  tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
  raw: { adapter: 'test', ref: `r${n}` },
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
const running = (home: string) => async (): Promise<CoreInfo> => readCoreFile(home)!;
const ids = (r: WorkspaceFindings | undefined) => (r?.findings ?? []).map((f) => f.heuristicId);

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test("a window's stream gets its workspace's findings from its own rules, as they change, and not another's", async () => {
    const { home, a, b } = machine();
    // The rule is a's (its project entry); b has none.
    saveConfig(home, { version: 1, defaults: {}, projects: { [a]: { rules: [RULE] } } });
    const core = await start(home);
    const latest = new Map<string, WorkspaceFindings>();
    const clients: CoreClient[] = [];
    try {
      for (const w of [a, b]) {
        const client = await CoreClient.connect({ home, cliPath: '/nowhere', workspace: w, ensure: running(home) });
        clients.push(client);
        client.follow({ onEvents: () => undefined, onFindings: (r) => latest.set(w, r) }, new Date().toISOString());
      }
      await waitFor(() => latest.has(a) && latest.has(b)); // the current findings, to start
      assert.ok(!ids(latest.get(a)).includes('test:model-calls'));
      await clients[0].post([call()]);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!ids(latest.get(a)).includes('test:model-calls'), 'one call: under the threshold');
      await clients[0].post([call()]);
      await waitFor(() => ids(latest.get(a)).includes('test:model-calls'));
      assert.match(latest.get(a)!.findings.find((f) => f.heuristicId === 'test:model-calls')!.summary, /2 model calls/);
      await clients[1].post([call(), call()]);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!ids(latest.get(b)).includes('test:model-calls'), "a's rule isn't b's");
      // Removing the rule: the window asks the core to evaluate now, and the finding goes.
      saveConfig(home, { version: 1, defaults: {}, projects: {} });
      await clients[0].findings();
      await waitFor(() => !ids(latest.get(a)).includes('test:model-calls'));
    } finally {
      for (const c of clients) c.close();
      await core.stop();
    }
  });

  test('GET /findings answers for a workspace nothing follows, from the last day of its log; the admin token names one', async () => {
    const { home, a } = machine();
    saveConfig(home, { version: 1, defaults: { rules: [RULE] }, projects: {} });
    await new StoreWriter(home).write([call(a), call(a), call(a)]);
    const core = await start(home);
    try {
      const info = readCoreFile(home)!;
      const minted = await coreRequest(info.port, info.token, 'POST', '/tokens', { workspaces: [a] });
      const token = (minted.body as { token: string }).token;
      const res = await coreRequest(info.port, token, 'GET', '/findings');
      assert.strictEqual(res.status, 200);
      const [result] = res.body as WorkspaceFindings[];
      assert.strictEqual(result.workspace, a);
      assert.match(result.findings.find((f) => f.heuristicId === 'test:model-calls')!.summary, /3 model calls/);
      assert.strictEqual((await coreRequest(info.port, info.token, 'GET', '/findings')).status, 400, 'admin: which workspace?');
      const admin = await coreRequest(info.port, info.token, 'GET', `/findings?workspace=${encodeURIComponent(a)}`);
      assert.strictEqual((admin.body as WorkspaceFindings[])[0].workspace, a);
      assert.strictEqual((await coreRequest(info.port, token, 'GET', `/findings?workspace=${encodeURIComponent('/elsewhere')}`)).status, 400, "a token can't read another workspace");
    } finally {
      await core.stop();
    }
  });

  test("snagboat findings prints the current workspace's findings from the running core", async () => {
    const { home, a } = machine();
    fs.mkdirSync(a, { recursive: true });
    saveConfig(home, { version: 1, defaults: { rules: [RULE] }, projects: {} });
    await new StoreWriter(home).write([call(a), call(a)]);
    const saved = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = home;
    let out = '';
    let err = '';
    const io = { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: a, now: new Date() };
    try {
      assert.strictEqual(await runCli(['findings'], io, 'test'), 1, 'no core: says so');
      assert.match(err, /isn't running/);
      const core = await start(home);
      try {
        out = '';
        assert.strictEqual(await runCli(['findings'], io, 'test'), 0, err);
        assert.match(out, /info  test:model-calls: 2 model calls/);
      } finally {
        await core.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved;
    }
  });

  test("a project's own tool categories never become the core's: only the user's label shell calls", async () => {
    const { home, a } = machine();
    const mine = { id: 'user:shell/package-install', parent: 'shell', label: 'Package installs', match: ['npm install'] };
    const theirs = { id: 'user:shell/network', parent: 'shell', label: 'Network', match: ['curl'] };
    saveConfig(home, { version: 1, defaults: { toolCategories: [mine] }, projects: { [a]: { toolCategories: [theirs] } } });
    const core = await start(home);
    try {
      const info = readCoreFile(home)!;
      assert.strictEqual((await coreRequest(info.port, info.token, 'GET', `/findings?workspace=${encodeURIComponent(a)}`)).status, 200);
      // The collectors label every project's shell calls with the categories set process-wide.
      assert.strictEqual(classifyCommand('npm install x'), 'user:shell/package-install', "the user's");
      assert.strictEqual(classifyCommand('curl x'), 'shell', "not project a's");
    } finally {
      await core.stop();
    }
  });

  test('a bad rule is reported with the findings, not thrown', async () => {
    const { home, a } = machine();
    saveConfig(home, { version: 1, defaults: { rules: [{ id: 'test:broken', scope: 'nowhere' }] }, projects: {} });
    const core = await start(home);
    try {
      const info = readCoreFile(home)!;
      const res = await coreRequest(info.port, info.token, 'GET', `/findings?workspace=${encodeURIComponent(a)}`);
      assert.strictEqual(res.status, 200);
      assert.ok((res.body as WorkspaceFindings[])[0].problems.length > 0);
    } finally {
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
