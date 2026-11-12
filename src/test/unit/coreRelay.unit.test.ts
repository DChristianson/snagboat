import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { runCli } from '../../cli/main';
import { loadConfig, saveConfig, withRelayFolder } from '../../core/config';
import { EventLog } from '../../core/eventLog';
import { RELAY_CHECKPOINTS_DIR, RELAY_INFO_FILE, RELAY_MAX_FILE_BYTES, RELAY_MAX_LINE_BYTES, RELAY_OUTBOX_DIR, relayDir, RelayInfo } from '../../core/relay';
import { RelayIngest } from '../../core/service/relayIngest';
import { StoreWriter } from '../../core/service/storeWriter';
import { collectedWorkspace, knownWorkspaceFolders } from '../../core/service/workspaces';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { OUTBOX_FILE_TARGET_BYTES, OutboxWriter, prepareRelayFolder } from '../../core/service/outbox';
import { CoreService } from '../../core/service/server';
import { listUserStores, userDataDir, workspaceStoreDir } from '../../core/userStore';

// Relay mode (bead snagboat-xe5, container side): a core inside a dev container, started with
// SNAGBOAT_RELAY_ROOT, sends what it collects to <root>/.snagboat/relay/outbox for the host's
// core, keeps its checkpoints there, drops projects outside the root, and writes no store.

function machine() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-relay-')));
  const home = path.join(base, 'home', '.snagboat');
  const projects = path.join(base, 'home', '.claude', 'projects');
  const root = path.join(base, 'workspaces', 'proj');
  const app = path.join(root, 'pkg', 'app');
  const outside = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const relay = relayDir(root);
  return { base, home, projects, root, app, outside, relay, outbox: path.join(relay, RELAY_OUTBOX_DIR) };
}

/** A transcript in Claude Code's layout: n prompts with their replies, each line carrying the session's cwd. */
function transcript(projects: string, cwd: string, session: string, n = 1): string {
  const dir = path.join(projects, sanitizeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = `${day}T10:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(JSON.stringify({ type: 'user', uuid: `${session}-u${i}`, sessionId: session, cwd, timestamp: ts, promptId: `${session}-p${i}`, message: { role: 'user', content: [{ type: 'text', text: `please fix bug ${i}` }] } }));
    lines.push(
      JSON.stringify({
        type: 'assistant', uuid: `${session}-a${i}`, parentUuid: `${session}-u${i}`, sessionId: session, cwd, timestamp: ts,
        message: { id: `${session}-m${i}`, model: 'claude-sonnet-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `fixed ${i}` }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      })
    );
  }
  const file = path.join(dir, `${session}.jsonl`);
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return file;
}

const OUTBOX_NAME = /^\d+-\d+-\d+\.jsonl$/;

/** Every event in the outbox, checking each file is a complete one. */
function outboxEvents(outbox: string): NormalizedEvent[] {
  let names: string[];
  try {
    names = fs.readdirSync(outbox);
  } catch {
    return [];
  }
  const events: NormalizedEvent[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    assert.match(name, OUTBOX_NAME);
    const text = fs.readFileSync(path.join(outbox, name), 'utf8');
    assert.ok(text.endsWith('\n'), `${name} is complete`);
    for (const line of text.trim().split('\n')) events.push(JSON.parse(line) as NormalizedEvent);
  }
  return events;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const start = (m: ReturnType<typeof machine>, extra: { idleMs?: number; collect?: boolean } = {}) =>
  CoreService.start({
    home: m.home,
    version: 'test',
    idleMs: extra.idleMs ?? 0,
    collect: extra.collect,
    ingestEveryMs: 60_000,
    claudeProjectsDir: m.projects,
    copilotSessionsDir: path.join(m.base, 'copilot-sessions'),
    relayRoot: m.root,
  });

let n = 0;
const ev = (workspace: string | undefined): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId: 's-1',
  agent: 'claude-code',
  ts: new Date().toISOString(),
  kind: 'tool_call',
  status: 'success',
  raw: { adapter: 'test', ref: `r${n}`, event: 'x'.repeat(20_000) },
  workspace,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the relay folder: .gitignore ignoring itself (kept if there), relay.json refreshed, outbox and checkpoints', () => {
    const m = machine();
    const folder = prepareRelayFolder(m.root, 'container-1');
    assert.deepStrictEqual(folder, { root: m.root, dir: m.relay, outbox: m.outbox });
    assert.strictEqual(fs.readFileSync(path.join(m.relay, '.gitignore'), 'utf8'), '*\n');
    const info = JSON.parse(fs.readFileSync(path.join(m.relay, RELAY_INFO_FILE), 'utf8')) as RelayInfo;
    assert.deepStrictEqual(info, { version: 1, root: m.root, host: 'container-1' });
    assert.ok(fs.statSync(path.join(m.relay, RELAY_CHECKPOINTS_DIR)).isDirectory());
    fs.writeFileSync(path.join(m.relay, '.gitignore'), '*\n# mine\n');
    prepareRelayFolder(m.root, 'container-2');
    assert.strictEqual(fs.readFileSync(path.join(m.relay, '.gitignore'), 'utf8'), '*\n# mine\n', 'an existing .gitignore is left alone');
    assert.strictEqual((JSON.parse(fs.readFileSync(path.join(m.relay, RELAY_INFO_FILE), 'utf8')) as RelayInfo).host, 'container-2', 'relay.json is refreshed');
    assert.deepStrictEqual(fs.readdirSync(m.relay).filter((f) => f.endsWith('.tmp')), []);
  });

  test('a relay root that is relative or missing stops the core from starting', async () => {
    const m = machine();
    await assert.rejects(CoreService.start({ home: m.home, version: 'test', idleMs: 0, collect: false, relayRoot: 'workspaces/proj' }), /absolute/);
    await assert.rejects(CoreService.start({ home: m.home, version: 'test', idleMs: 0, collect: false, relayRoot: path.join(m.base, 'nope') }), /not a folder/);
    assert.strictEqual(readCoreFile(m.home), undefined, 'and leaves no core.json');
  });

  test('outbox files appear only complete: written under a dot-name and renamed', async () => {
    const m = machine();
    const folder = prepareRelayFolder(m.root);
    const writer = new OutboxWriter(folder);
    let done = false;
    let seen = 0;
    // Watch the folder while batches of large events are written: every visible .jsonl must parse whole.
    const watching = (async () => {
      while (!done) {
        seen += outboxEvents(m.outbox).length > 0 ? 1 : 0;
        await new Promise((r) => setImmediate(r));
      }
    })();
    const writes: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i++) writes.push(writer.write([ev(m.root), ev(m.app), ev(m.app)]));
    const results = await Promise.all(writes);
    done = true;
    await watching;
    assert.ok(seen > 0, 'the watcher saw files');
    const names = fs.readdirSync(m.outbox);
    assert.strictEqual(names.length, 40, 'one file per small write');
    assert.ok(names.every((f) => OUTBOX_NAME.test(f) && f.includes(`-${process.pid}-`)), '<epoch ms>-<pid>-<seq>.jsonl, nothing left over');
    assert.strictEqual(outboxEvents(m.outbox).length, 120);
    assert.deepStrictEqual(results[0], { written: 3, duplicates: 0, spooled: 0, dropped: 0 });
    // Outside the root, or with no workspace: dropped, and an all-dropped batch writes no file.
    assert.deepStrictEqual(await writer.write([ev(m.outside), ev(undefined), ev(path.join(m.root, '..', 'proj-other'))]), { written: 0, duplicates: 0, spooled: 0, dropped: 3 });
    assert.strictEqual(fs.readdirSync(m.outbox).length, 40);
    // A half-written batch from a core that died is removed when the folder is next prepared.
    const dead = path.join(m.outbox, '.1700000000000-999999999-1.jsonl.tmp');
    fs.writeFileSync(dead, '{"partial');
    prepareRelayFolder(m.root);
    assert.ok(!fs.existsSync(dead));
  });

  test('a relaying core sends transcripts under the root to the outbox, drops others, and writes no store', async () => {
    const m = machine();
    const file = transcript(m.projects, m.app, 'sa', 2);
    transcript(m.projects, m.outside, 'sb', 1);
    let core = await start(m);
    try {
      await waitFor(() => outboxEvents(m.outbox).length === 4);
      const events = outboxEvents(m.outbox);
      assert.ok(events.every((e) => e.workspace === m.root), 'a session in a subfolder is sent under its repository, the container-side path');
      assert.ok(events.every((e) => e.sessionId === 'sa'), 'the project outside the root is dropped');
      assert.ok(events.some((e) => e.kind === 'user_prompt' && e.promptText === 'please fix bug 0'));
      // Live: a new line goes out as a new file.
      fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'sa-u9', sessionId: 'sa', cwd: m.app, timestamp: new Date().toISOString(), promptId: 'sa-p9', message: { role: 'user', content: [{ type: 'text', text: 'one more' }] } }) + '\n');
      await waitFor(() => outboxEvents(m.outbox).length === 5);
      // A hook from inside the root goes out too; one from outside isn't recorded.
      const hook = { session_id: 'sa', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', tool_name: 'Bash', tool_input: { command: 'npm test' } };
      assert.strictEqual((await core.deliverHook(m.app, hook, new Date().toISOString())).recorded, true);
      assert.strictEqual((await core.deliverHook(m.outside, { ...hook, tool_use_id: 'toolu_2' }, new Date().toISOString())).recorded, false);
      assert.strictEqual(outboxEvents(m.outbox).length, 6);
      assert.ok(outboxEvents(m.outbox).every((e) => e.workspace === m.root));
      // Status names the relay; the store's endpoints refuse.
      const info = readCoreFile(m.home)!;
      const health = await coreRequest(info.port, info.token, 'GET', '/health');
      assert.deepStrictEqual((health.body as { relay: unknown }).relay, { root: m.root, folder: m.relay });
      assert.strictEqual((await coreRequest(info.port, info.token, 'GET', '/sessions')).status, 409);
      assert.strictEqual((await coreRequest(info.port, info.token, 'POST', '/events', ev(m.root))).status, 409);
      // Checkpoints in the relay folder, nothing in the per-user store.
      assert.ok(fs.readdirSync(path.join(m.relay, RELAY_CHECKPOINTS_DIR)).some((f) => f.startsWith('claude-code-')), 'checkpoints in the relay folder');
      assert.ok(!fs.existsSync(path.join(userDataDir(m.home), 'core')), 'none in ~/.snagboat');
      assert.ok(!fs.existsSync(path.join(userDataDir(m.home), 'workspaces')), 'no workspace store');
      assert.deepStrictEqual(listUserStores(m.home), []);
    } finally {
      await core.stop();
    }
    // A container rebuild wipes ~/.snagboat but not ~/.claude or the project: nothing is sent again.
    fs.rmSync(m.home, { recursive: true, force: true });
    const before = fs.readdirSync(m.outbox).length;
    core = await start(m);
    try {
      await new Promise((r) => setTimeout(r, 1000));
      assert.strictEqual(fs.readdirSync(m.outbox).length, before, 'a restart resumes from the relay folder\'s checkpoints');
      // The host takes the files; what's new goes out alone.
      for (const f of fs.readdirSync(m.outbox)) fs.rmSync(path.join(m.outbox, f));
      fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'sa-u10', sessionId: 'sa', cwd: m.app, timestamp: new Date().toISOString(), promptId: 'sa-p10', message: { role: 'user', content: [{ type: 'text', text: 'and another' }] } }) + '\n');
      await waitFor(() => outboxEvents(m.outbox).length === 1);
      assert.strictEqual(outboxEvents(m.outbox)[0].promptText, 'and another');
    } finally {
      await core.stop();
    }
  });

  test('snagboat core status says the core is relaying, and where', async () => {
    const m = machine();
    const core = await start(m, { collect: false });
    const saved = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = m.home;
    let out = '';
    try {
      const io = { out: (t: string) => (out += t), err: () => undefined, cwd: m.root, now: new Date() };
      assert.strictEqual(await runCli(['core', 'status'], io, 'test'), 0);
      assert.match(out, new RegExp(`relaying: events for ${m.root} go to ${m.relay}`));
      out = '';
      assert.strictEqual(await runCli(['core', 'status', '--json'], io, 'test'), 0);
      assert.deepStrictEqual((JSON.parse(out) as { relay: unknown }).relay, { root: m.root, folder: m.relay });
    } finally {
      if (saved === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved;
      await core.stop();
    }
  });

  test('a relaying core still stops when idle', async () => {
    const m = machine();
    const core = await start(m, { idleMs: 200, collect: false });
    const stopped = await Promise.race([core.stopped.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]);
    if (!stopped) await core.stop();
    assert.ok(stopped, 'stopped by itself');
    assert.strictEqual(readCoreFile(m.home), undefined);
  });

  test('a large batch is split across outbox files the host will read, and an oversized event is dropped', async () => {
    const m = machine();
    const writer = new OutboxWriter(prepareRelayFolder(m.root));
    const batch = Array.from({ length: 250 }, () => ev(m.app)); // ~20 KB each: more than one file's worth
    const huge = { ...ev(m.app), raw: { adapter: 'test', ref: 'huge', event: 'x'.repeat(RELAY_MAX_LINE_BYTES) } };
    const result = await writer.write([...batch, huge]);
    assert.deepStrictEqual(result, { written: 250, duplicates: 0, spooled: 0, dropped: 1 });
    const names = fs.readdirSync(m.outbox);
    assert.ok(names.length >= 2, `split into ${names.length} files`);
    for (const name of names) assert.ok(fs.statSync(path.join(m.outbox, name)).size <= OUTBOX_FILE_TARGET_BYTES + RELAY_MAX_LINE_BYTES, `${name} is well under the host's limit`);
    assert.ok(OUTBOX_FILE_TARGET_BYTES + RELAY_MAX_LINE_BYTES < RELAY_MAX_FILE_BYTES);
    assert.deepStrictEqual(outboxEvents(m.outbox).map((e) => e.eventId), batch.map((e) => e.eventId), 'in order, none lost');
  });

  test('end to end: what a container core relays lands in the host store under the host path', async () => {
    const m = machine();
    transcript(m.projects, m.app, 'sc', 2);
    const core = await start(m);
    try {
      await waitFor(() => outboxEvents(m.outbox).length === 4);
    } finally {
      await core.stop();
    }
    // The host sees the same folder at another path (the bind mount): /workspaces/proj in the container, ~/code/proj here.
    const hostProject = path.join(m.base, 'mac', 'code', 'proj');
    fs.mkdirSync(path.join(hostProject, '.git'), { recursive: true });
    fs.cpSync(path.join(m.root, '.snagboat'), path.join(hostProject, '.snagboat'), { recursive: true });
    const hostHome = path.join(m.base, 'mac', '.snagboat');
    fs.mkdirSync(hostHome, { recursive: true });
    saveConfig(hostHome, withRelayFolder(loadConfig(hostHome).config, hostProject, true));
    const ingest = new RelayIngest({
      home: hostHome,
      writer: new StoreWriter(hostHome),
      workspaceFor: (dir) => collectedWorkspace(hostHome, dir, knownWorkspaceFolders(hostHome)),
      captureContent: () => true,
      log: () => undefined,
    });
    await ingest.ingest();
    const stored = await new EventLog(workspaceStoreDir(hostHome, hostProject)).readAll();
    assert.strictEqual(stored.length, 4);
    assert.ok(stored.every((e) => e.workspace === hostProject && e.sessionId === 'sc'), 'filed under the host folder, not /workspaces/proj');
    assert.ok(stored.some((e) => e.kind === 'user_prompt' && e.promptText === 'please fix bug 1'));
    assert.deepStrictEqual(fs.readdirSync(path.join(hostProject, '.snagboat', 'relay', RELAY_OUTBOX_DIR)), [], 'the host deleted what it read');
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
