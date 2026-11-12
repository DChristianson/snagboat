import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { runCli } from '../../cli/main';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// The advisor UI served by the core (RFC step 5a): its files and their policy, the host check,
// one-time links that open a read-only session, and the API the page reads.

function raw(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let n = 0;
const ev = (workspace: string, minAgo: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId: 's1',
  agent: 'claude-code',
  ts: new Date(Date.now() - minAgo * 60_000).toISOString(),
  kind: 'turn_stop',
  status: 'success',
  tokens: { input: 100, output: 10, cacheRead: 300, cacheCreation: 0 },
  raw: { adapter: 'test', ref: `r${n}` },
  workspace,
  ...extra,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-ui-')));
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  for (const w of [a, b]) fs.mkdirSync(w);
  await new StoreWriter(home).write([
    ev(a, 60 * 24 * 2), ev(a, 30), ev(b, 10),
    // The agent's todo list, recorded without its text: Navigator's Ahead falls back to it (no .beads here).
    ev(a, 25, { kind: 'tool_call', tokens: undefined, toolName: 'TodoWrite', toolCategory: 'other', todos: { pending: 2, inProgress: 1, completed: 3 } }),
    ev(a, 20, { kind: 'outcome', tokens: undefined, outcome: { type: 'notified', heuristicId: 'stalled', advisor: 'navigator' } }),
    ev(a, 90, { kind: 'outcome', tokens: undefined, outcome: { type: 'notified', heuristicId: 'stalled', advisor: 'navigator' } }),
  ]);
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
  const info = readCoreFile(home)!;
  const host = `127.0.0.1:${core.port}`;

  test('only requests addressed to 127.0.0.1 or localhost are answered (no DNS rebinding)', async () => {
    assert.strictEqual((await raw(core.port, 'GET', '/ui/', { Host: 'evil.example' })).status, 421);
    assert.strictEqual((await raw(core.port, 'GET', '/ui/', { Host: `evil.example:${core.port}` })).status, 421);
    assert.strictEqual((await raw(core.port, 'GET', '/ui/', { Host: 'localhost:61234' })).status, 200, 'another port: a remote VS Code window forwards the core');
    assert.strictEqual((await raw(core.port, 'GET', '/ui/', { Host: 'x.app.github.dev' })).status, 421);
    await coreRequest(core.port, info.token, 'POST', '/ui-links', { allowHost: 'X.app.github.dev' });
    assert.strictEqual((await raw(core.port, 'GET', '/ui/', { Host: 'x.app.github.dev' })).status, 200, 'a forwarded address the window registered');
    assert.strictEqual((await raw(core.port, 'POST', '/ui-session', { Host: host }, JSON.stringify({ code: 'x'.repeat(5000) }))).status, 413, 'no big bodies without a token');
    assert.strictEqual((await raw(core.port, 'GET', '/ui/', { Host: `localhost:${core.port}` })).status, 200);
    assert.strictEqual((await coreRequest(core.port, info.token, 'GET', '/health')).status, 200, 'the CLI and windows still get in');
  });

  test("the UI's files, with a policy that allows only its own files and the core", async () => {
    const page = await raw(core.port, 'GET', '/ui/', { Host: host });
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.match(page.text, /<script src="app.js" defer><\/script>/);
    const csp = String(page.headers['content-security-policy']);
    for (const part of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(part), part);
    assert.ok(!/<script>|style="/.test(page.text), 'no inline script or style, which the policy forbids');
    assert.match((await raw(core.port, 'GET', '/ui/app.js', { Host: host })).headers['content-type'] ?? '', /javascript/);
    assert.match((await raw(core.port, 'GET', '/ui/theme.css', { Host: host })).text, /--sv-surface/, "the visualizers' theme");
    assert.strictEqual((await raw(core.port, 'GET', '/ui', { Host: host })).status, 308);
    for (const bad of ['/ui/../package.json', '/ui/%2e%2e/package.json', '/ui/x.txt', '/ui/sub/app.js']) assert.strictEqual((await raw(core.port, 'GET', bad, { Host: host })).status, 404, bad);
    for (const f of ['app.js', 'app.css', 'index.html']) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '..', 'media', 'ui', f)), f);
  });

  test('a one-time link: minted by the admin token only, used once, opening a read-only session on its workspace', async () => {
    const minted = await coreRequest(core.port, info.token, 'POST', '/tokens', { workspaces: [a] });
    const windowToken = (minted.body as { token: string }).token;
    assert.strictEqual((await coreRequest(core.port, windowToken, 'POST', '/ui-links', {})).status, 403);
    const link = (await coreRequest(core.port, info.token, 'POST', '/ui-links', { workspace: a })).body as { code: string; url: string };
    assert.strictEqual(link.url, `http://127.0.0.1:${core.port}/ui/#${link.code}`);
    assert.match(link.code, /^[A-Za-z0-9_-]{20,}$/);
    const first = await raw(core.port, 'POST', '/ui-session', { Host: host, 'Content-Type': 'application/json' }, JSON.stringify({ code: link.code }));
    assert.strictEqual(first.status, 200);
    const session = JSON.parse(first.text) as { token: string; workspace: string };
    assert.strictEqual(session.workspace, a);
    assert.strictEqual((await raw(core.port, 'POST', '/ui-session', { Host: host }, JSON.stringify({ code: link.code }))).status, 401, 'used once');
    assert.strictEqual((await raw(core.port, 'POST', '/ui-session', { Host: host }, JSON.stringify({ code: 'guess' }))).status, 401);

    const reader = session.token;
    const workspaces = (await coreRequest(core.port, reader, 'GET', '/workspaces')).body as Array<{ workspace: string; lastDay?: string }>;
    assert.deepStrictEqual(workspaces.map((w) => w.workspace).sort(), [a, b].sort(), 'every workspace');
    for (const [method, p, body] of [['POST', '/events', [ev(a, 0)]], ['POST', '/tokens', { workspaces: [a] }], ['POST', '/retention', {}], ['POST', '/flush', {}], ['POST', '/ui-links', {}], ['POST', '/shutdown', {}]] as const) {
      assert.strictEqual((await coreRequest(core.port, reader, method, p, body)).status, 403, `${method} ${p}`);
    }
    assert.strictEqual((await coreRequest(core.port, reader, 'GET', '/findings')).status, 400, 'names a workspace');
    assert.strictEqual((await coreRequest(core.port, reader, 'GET', `/findings?workspace=${encodeURIComponent(b)}`)).status, 200);
    // At most 20 browser keys: the oldest ends when a new one starts.
    const open = async () => {
      const l = (await coreRequest(core.port, info.token, 'POST', '/ui-links', {})).body as { code: string };
      return JSON.parse((await raw(core.port, 'POST', '/ui-session', { Host: host }, JSON.stringify({ code: l.code }))).text).token as string;
    };
    for (let i = 0; i < 20; i++) await open();
    assert.strictEqual((await coreRequest(core.port, reader, 'GET', '/workspaces')).status, 401, 'the oldest key ended');
  });

  test("the advisors the page shows: a daily series for each measure, and each advisor's notifications this hour", async () => {
    const res = await coreRequest(core.port, info.token, 'GET', `/advisors?workspace=${encodeURIComponent(a)}&days=7&series=1`);
    const body = res.body as { advisors: Array<{ id: string; notify: { lastHour?: number; maxPerHour?: number }; cue?: { color?: string }; measures: Array<{ id: string; series?: Array<number | null>; note?: string }> }> };
    const purser = body.advisors.find((x) => x.id === 'purser')!;
    const cache = purser.measures.find((m) => m.id === 'cache_hit_rate')!;
    assert.strictEqual(cache.series!.length, 7);
    assert.strictEqual(cache.series![6], 75, "today's: 300 of 400");
    assert.strictEqual(cache.series![4], 75, 'two days ago');
    assert.strictEqual(cache.series![5], null, 'yesterday: nothing');
    assert.strictEqual(purser.cue?.color, 'amber');
    assert.deepStrictEqual(body.advisors.find((x) => x.id === 'navigator')!.notify.lastHour, 1, 'one of the two notifications was in the last hour');
    const plain = (await coreRequest(core.port, info.token, 'GET', `/advisors?workspace=${encodeURIComponent(a)}`)).body as typeof body;
    assert.strictEqual(plain.advisors[0].measures.find((m) => m.id === 'cache_hit_rate')!.series, undefined, 'only when asked');
    const long = (await coreRequest(core.port, info.token, 'GET', `/advisors?workspace=${encodeURIComponent(a)}&days=90&series=1`)).body as typeof body;
    assert.strictEqual(long.advisors[0].measures.find((m) => m.id === 'cache_hit_rate')!.series, undefined, 'no series past 31 days');
  });

  test("cards' briefs and status lines, an advisor's weekly series, and responses the core keeps", async () => {
    const q = `workspace=${encodeURIComponent(a)}`;
    const one = (await coreRequest(core.port, info.token, 'GET', `/advisors?${q}`)).body as { advisors: Array<{ id: string; status: string; brief?: { summary: string; surface: { kind: string } } }> };
    assert.strictEqual(one.advisors[0].status, 'Keeping token cost down');
    assert.ok(one.advisors.every((x) => x.brief && x.brief.summary && x.brief.surface.kind), 'a brief for each, with one workspace');
    const nav = (one.advisors as Array<{ id: string; brief?: { ahead?: { source: string; completed: number; text: boolean } } }>).find((x) => x.id === 'navigator')!;
    assert.deepStrictEqual([nav.brief?.ahead?.source, nav.brief?.ahead?.completed, nav.brief?.ahead?.text], ['plan', 3, false], "no Beads: Navigator's Ahead is the session's plan, counts only");
    const inB = (await coreRequest(core.port, info.token, 'GET', `/advisors?workspace=${encodeURIComponent(b)}`)).body as typeof one;
    assert.ok(inB.advisors.every((x) => !(x.brief as { ahead?: unknown } | undefined)?.ahead), 'neither Beads nor a plan: no Ahead');
    const all = (await coreRequest(core.port, info.token, 'GET', '/advisors')).body as typeof one;
    assert.ok(all.advisors.every((x) => !x.brief), 'none across workspaces');
    const weekly = (await coreRequest(core.port, info.token, 'GET', `/advisors?${q}&weeks=8`)).body as { advisors: Array<{ measures: Array<{ id: string; series?: unknown[] }> }> };
    assert.strictEqual(weekly.advisors[0].measures.find((x) => x.id === 'cache_hit_rate')!.series!.length, 8);
    assert.strictEqual((await coreRequest(core.port, info.token, 'GET', `/advisors?${q}&weeks=20`)).status, 400);

    // A browser key may respond to a finding: the core keeps it, no VS Code needed (coreResponses.unit.test.ts has more).
    const link = (await coreRequest(core.port, info.token, 'POST', '/ui-links', {})).body as { code: string };
    const reader = JSON.parse((await raw(core.port, 'POST', '/ui-session', { Host: host }, JSON.stringify({ code: link.code }))).text).token as string;
    const res = await coreRequest(core.port, reader, 'POST', '/findings/respond', { workspace: a, heuristicId: 'stalled', response: 'mute' });
    assert.deepStrictEqual([res.status, (res.body as { muted: boolean }).muted], [200, true]);
    assert.strictEqual((await coreRequest(core.port, reader, 'POST', '/findings/respond', { workspace: a, heuristicId: 'stalled', response: 'delete' })).status, 400);
    assert.strictEqual((await coreRequest(core.port, reader, 'POST', '/findings/respond', { workspace: a, heuristicId: 'stalled', response: 'unmute' })).status, 200);
  });

  test('snagboat open prints a one-time link for the workspace containing this folder', async () => {
    const saved = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = home;
    let out = '';
    let err = '';
    try {
      const io = { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: a, now: new Date() };
      assert.strictEqual(await runCli(['open', '--no-open', '--json'], io, 'test'), 0, err);
      const link = JSON.parse(out) as { url: string; opened: boolean };
      assert.strictEqual(link.opened, false);
      const code = link.url.split('#')[1];
      const session = await raw(core.port, 'POST', '/ui-session', { Host: host }, JSON.stringify({ code }));
      assert.strictEqual(JSON.parse(session.text).workspace, a);
    } finally {
      if (saved === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved;
    }
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(e);
    }
  }
  await core.stop();
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
