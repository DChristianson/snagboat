import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { NormalizedEvent } from '@snagboat/schema';
import { BACKGROUND_HOOK_EVENTS, HOOK_EVENT_NAMES } from '../../adapters/claude-code/hooksConfig';
import { handleMcp, McpReads, serveMcp, TOOLS } from '../../cli/mcp';
import { statusLine, statusLineDir } from '../../cli/statusline';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// The Claude Code plugin (RFC step 5d): its MCP server's read-only tools over the core, the status
// line, and the plugin's own files (hooks matching what VS Code registers, the forwarder stepping
// aside where VS Code's hook already runs, the stable CLI path, the Node check).

const repo = path.join(__dirname, '..', '..', '..');
const plugin = path.join(repo, 'plugins', 'snagboat');
const sh = (script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) =>
  spawnSync('sh', [script, ...args], { env: { ...process.env, ...opts.env }, input: opts.input ?? '', encoding: 'utf8' });

let n = 0;
const ev = (workspace: string, minAgo: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId: 's-1',
  agent: 'claude-code',
  ts: new Date(Date.now() - minAgo * 60_000).toISOString(),
  kind: 'turn_stop',
  status: 'success',
  model: 'claude-opus-5-5',
  turnId: 't1',
  tokens: { input: 100, output: 10, cacheRead: 900, cacheCreation: 0 },
  raw: { adapter: 'test', ref: `r${n}` },
  workspace,
  ...extra,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-plugin-')));
  const ws = path.join(home, 'proj');
  fs.mkdirSync(ws);
  await new StoreWriter(home).write([
    ev(ws, 30, { kind: 'user_prompt', tokens: undefined }),
    ev(ws, 29),
    ev(ws, 28, { kind: 'outcome', tokens: undefined, outcome: { type: 'milestone', commit: 'abcdef123' } }),
  ]);
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
  const info = readCoreFile(home)!;
  const reads = async (): Promise<McpReads> => ({ workspace: ws, get: (p) => coreRequest(info.port, info.token, 'GET', p, undefined, 30_000) });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await handleMcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, reads, 'test')) as { result: { content: Array<{ text: string }>; isError?: boolean } };

  test('MCP: initialize, tools/list (read-only tools), notifications answered with nothing, unknown methods refused', async () => {
    const init = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, reads, '9.9')) as { result: { protocolVersion: string; serverInfo: { version: string }; capabilities: unknown } };
    assert.strictEqual(init.result.protocolVersion, '2025-03-26', 'the version the client asked for, when known');
    assert.deepStrictEqual(init.result.capabilities, { tools: {} });
    assert.strictEqual(init.result.serverInfo.version, '9.9');
    assert.strictEqual(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, reads, 't'), undefined);
    const list = (await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, reads, 't')) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['snagboat_findings', 'snagboat_sessions', 'snagboat_session', 'snagboat_advisors']);
    assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint));
    assert.strictEqual(((await handleMcp({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, reads, 't')) as { error: { code: number } }).error.code, -32601);
    assert.strictEqual(((await handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'snagboat_write' } }, reads, 't')) as { error: { code: number } }).error.code, -32602);
  });

  test('MCP tools read the workspace from the core', async () => {
    assert.match((await call('snagboat_sessions')).result.content[0].text, /^s-1 .* 1 prompts .*\n {2}came of it: milestone$/);
    const one = (await call('snagboat_session', { id: 's-' })).result.content[0].text;
    assert.match(one, /^s-1: claude-code, claude-opus-5-5,/);
    assert.match(one, /Outcomes:\n {2}.*milestone abcdef1/);
    assert.match((await call('snagboat_findings')).result.content[0].text, /stalled|No findings now/);
    assert.match((await call('snagboat_advisors', { days: 7 })).result.content[0].text, /^Purser — Keeping token cost down \(goal token-cost-down\), last 7 days/);
    const bad = await call('snagboat_session', { id: 'nope' });
    assert.ok(bad.result.isError);
    assert.match(bad.result.content[0].text, /no session nope/);
    assert.ok((await call('snagboat_sessions', { days: 0 })).result.isError);
    const none = (await handleMcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'snagboat_findings' } }, async () => ({ workspace: undefined, get: async () => ({ status: 500, body: {} }) }), 't')) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.ok(none.result.isError && /no workspace containing this folder/.test(none.result.content[0].text));
  });

  test('MCP over stdio: one message per line, answers in order, a bad line gets a parse error', async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveMcp(input, (line) => out.push(line), reads, 't');
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{not json}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/li');
    input.end('st"}\n');
    await done;
    assert.deepStrictEqual(out.map((l) => JSON.parse(l)).map((m) => m.id ?? m.error?.code), [1, -32700, 2]);
  });

  test('GET /today and the status line', async () => {
    const today = (await coreRequest(info.port, info.token, 'GET', `/today?workspace=${encodeURIComponent(ws)}`)).body as { tokens: number; cacheRate: number; milestones: number };
    assert.strictEqual(today.tokens, 1010);
    assert.strictEqual(Math.round(today.cacheRate), 90);
    assert.strictEqual(today.milestones, 1);
    assert.strictEqual(statusLine({ tokens: 18_400_000, cacheRate: 98.2, milestones: 1, findings: 2, warnings: 1 }), '⚑ 2 findings (1 warn) · 18.4M tok today · 98% cache · 1 milestone');
    assert.strictEqual(statusLine({ tokens: 900, milestones: 0, findings: 0, warnings: 0 }), '900 tok today');
    assert.strictEqual(statusLine('no-core'), 'Snagboat: core not running');
    assert.strictEqual(statusLineDir('{"cwd":"/a","workspace":{"current_dir":"/b"}}'), '/b');
    assert.strictEqual(statusLineDir('{"cwd":"/a"}'), '/a');
    assert.strictEqual(statusLineDir('nope'), undefined);
  });

  test("the plugin's hooks are the ones VS Code registers, background where VS Code's are, plus SessionStart", () => {
    const hooks = (JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>> }).hooks;
    assert.deepStrictEqual(Object.keys(hooks).sort(), [...HOOK_EVENT_NAMES, 'SessionStart'].sort());
    for (const name of HOOK_EVENT_NAMES) {
      const [h] = hooks[name][0].hooks;
      assert.strictEqual(h.command, 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/snagboat-hook"', name);
      assert.strictEqual(!!h.async, BACKGROUND_HOOK_EVENTS.has(name), `${name} async`);
    }
    const mcp = JSON.parse(fs.readFileSync(path.join(plugin, '.mcp.json'), 'utf8'));
    assert.deepStrictEqual(mcp.mcpServers.snagboat, { command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/bin/snagboat', 'mcp'] });
    // Every tool a command names exists, under the name Claude Code gives a plugin's MCP tools.
    for (const file of fs.readdirSync(path.join(plugin, 'commands'))) {
      for (const m of fs.readFileSync(path.join(plugin, 'commands', file), 'utf8').matchAll(/mcp__plugin_snagboat_snagboat__(\w+)/g)) assert.ok(TOOLS.some((t) => t.name === m[1]), `${file}: ${m[1]}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.strictEqual(manifest.version, JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, 'npm run build:plugin keeps it in step');
  });

  test("the plugin's hook forwards, unless a VS Code hook in the project or user settings already does", () => {
    // POSIX sh scripts; on Windows, Claude Code runs them in Git Bash (checked on a real machine: snagboat-79f.8).
    if (process.platform === 'win32') return;
    // A stand-in plugin folder whose forwarder records what it was sent.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-pluginroot-'));
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.copyFileSync(path.join(plugin, 'hooks', 'snagboat-hook'), path.join(root, 'hooks', 'snagboat-hook'));
    const got = path.join(root, 'got');
    fs.writeFileSync(path.join(root, 'hooks', 'forward.sh'), `cat > "${got}"\nexit 3\n`);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-project-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-home-'));
    const run = () => sh(path.join(root, 'hooks', 'snagboat-hook'), [], { env: { CLAUDE_PROJECT_DIR: project, HOME: fakeHome, SNAGBOAT_HOME: '' }, input: '{"hook_event_name":"Stop"}' });
    let r = run();
    assert.strictEqual(r.status, 0, 'never fails, even when the forwarder does');
    assert.strictEqual(fs.readFileSync(got, 'utf8'), '{"hook_event_name":"Stop"}', 'forwarded with its payload');
    fs.rmSync(got);
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"command":"x # snagboat-hook-receiver"}]}]}}');
    r = run();
    assert.strictEqual(fs.readFileSync(got, 'utf8'), '{"hook_event_name":"Stop"}', "a committed VS Code entry whose forwarder isn't installed here does nothing: the plugin still forwards");
    fs.rmSync(got);
    fs.mkdirSync(path.join(fakeHome, '.snagboat', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.snagboat', 'bin', 'snagboat-hook'), '#!/bin/sh\n');
    r = run();
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(got), "VS Code's project hook delivers it: the plugin's steps aside");
    fs.rmSync(path.join(project, '.claude', 'settings.json'));
    fs.mkdirSync(path.join(fakeHome, '.claude'));
    fs.writeFileSync(path.join(fakeHome, '.claude', 'settings.json'), '# snagboat-hook-receiver');
    run();
    assert.ok(!fs.existsSync(got), 'in user settings, too');
  });

  test('session start keeps ~/.snagboat/bin/snagboat pointing at this version; the CLI wrapper checks for Node 24', () => {
    // POSIX sh scripts; on Windows, Claude Code runs them in Git Bash (checked on a real machine: snagboat-79f.8).
    if (process.platform === 'win32') return;
    const snagHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-shim-'));
    // A plugin folder with a forwarder, at a path no shell should run as code.
    const pluginRoot = path.join(snagHome, `it's "$(touch pwned)" \`x\` $HOME`);
    fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'hooks', 'forward.sh'), '# the forwarder\n');
    fs.copyFileSync(path.join(plugin, 'hooks', 'session-start'), path.join(pluginRoot, 'hooks', 'session-start'));
    fs.mkdirSync(path.join(pluginRoot, 'bin'));
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'snagboat'), 'echo "ran with $*"\n');
    const start = () => sh(path.join(pluginRoot, 'hooks', 'session-start'), [], { env: { SNAGBOAT_HOME: snagHome, CLAUDE_PLUGIN_ROOT: pluginRoot }, input: '{}' });
    assert.strictEqual(start().status, 0);
    const shim = path.join(snagHome, 'bin', 'snagboat');
    assert.ok(fs.statSync(shim).mode & 0o100, 'executable');
    const ran = spawnSync('sh', [shim, 'statusline', 'a b'], { cwd: snagHome, encoding: 'utf8' });
    assert.strictEqual(ran.stdout, 'ran with statusline a b\n', 'the shim runs this version of the plugin, whatever its path holds');
    assert.ok(!fs.existsSync(path.join(snagHome, 'pwned')), 'and runs nothing in it');
    // The forwarder, installed where a project's committed VS Code hook entry looks for it; never over VS Code's.
    const forwarder = path.join(snagHome, 'bin', 'snagboat-hook');
    assert.strictEqual(fs.readFileSync(forwarder, 'utf8'), '# the forwarder\n');
    fs.writeFileSync(forwarder, "# VS Code's\n");
    start();
    assert.strictEqual(fs.readFileSync(forwarder, 'utf8'), "# VS Code's\n");
    const fakeNode = path.join(snagHome, 'node22');
    fs.writeFileSync(fakeNode, '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22; else echo v22.1.0; fi\n', { mode: 0o755 });
    const old = sh(path.join(plugin, 'bin', 'snagboat'), ['version'], { env: { SNAGBOAT_NODE: fakeNode } });
    assert.strictEqual(old.status, 1);
    assert.match(old.stderr, /needs Node\.js 24 or later; .* is v22\.1\.0/);
    fs.writeFileSync(fakeNode, '#!/bin/sh\necho odd\n', { mode: 0o755 });
    assert.strictEqual(sh(path.join(plugin, 'bin', 'snagboat'), ['version'], { env: { SNAGBOAT_NODE: fakeNode } }).status, 1, 'an answer that is no version fails the check');
    const missing = sh(path.join(plugin, 'bin', 'snagboat'), ['version'], { env: { SNAGBOAT_NODE: path.join(snagHome, 'no-such-node') } });
    assert.strictEqual(missing.status, 127);
    assert.match(missing.stderr, /install it/);
    if (fs.existsSync(path.join(plugin, 'dist', 'snagboat.js'))) {
      assert.match(execFileSync('sh', [path.join(plugin, 'bin', 'snagboat'), 'version'], { encoding: 'utf8', env: { ...process.env, SNAGBOAT_NODE: process.execPath } }), /^snagboat /, 'a built plugin runs its CLI');
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
  await core.stop();
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
