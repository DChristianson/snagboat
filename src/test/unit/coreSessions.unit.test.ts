import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { sessionFindings } from '../../heuristics/sessionFindings';

// Sessions in the advisor UI (RFC step 5b): the core lists a workspace's sessions with their
// outcomes, builds one session's view as VS Code's Sessions tab does, serves the Explore tab's
// state, and serves the Factory Clock visualizers beside the page. No VS Code involved.

function raw(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

let n = 0;
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const ev = (workspace: string, sessionId: string, minAgo: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: `e${(n += 1)}`,
  sessionId,
  agent: 'claude-code',
  ts: at(minAgo),
  kind: 'turn_stop',
  status: 'success',
  model: 'claude-opus-5-5',
  turnId: 't1',
  tokens: { input: 100, output: 10, cacheRead: 300, cacheCreation: 0 },
  raw: { adapter: 'test', ref: `r${n}` },
  workspace,
  ...extra,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-sessions-')));
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  for (const w of [a, b]) fs.mkdirSync(w);
  const writer = new StoreWriter(home);
  await writer.write([
    ev(a, 's-old', 60 * 24 * 3, { kind: 'user_prompt', tokens: undefined }),
    ev(a, 's-old', 60 * 24 * 3 - 5),
    ev(a, 's-new', 40, { kind: 'user_prompt', tokens: undefined }),
    ev(a, 's-new', 39, { kind: 'tool_call', tokens: undefined, target: 'npm test', toolName: 'Bash', status: 'failure' }),
    ev(a, 's-new', 35, { kind: 'tool_call', tokens: undefined, target: 'npm test', toolName: 'Bash' }),
    ev(a, 's-new', 34),
    // Outcomes, filed under their session, one recorded days after the session (a commit kept at 7 days).
    ev(a, 's-new', 34, { kind: 'outcome', tokens: undefined, outcome: { type: 'tests_green', failures: 1, afterMs: 240_000 } }),
    ev(a, 's-old', 1, { kind: 'outcome', tokens: undefined, outcome: { type: 'commit_kept', commit: 'abc1234def', days: 7 } }),
    ev(a, 's-new', 30, { kind: 'outcome', tokens: undefined, outcome: { type: 'finding_response', heuristicId: 'stalled', response: 'useful' } }),
    ev(b, 's-b', 10, { kind: 'user_prompt', tokens: undefined }),
  ]);
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
  const info = readCoreFile(home)!;
  const get = async <T>(p: string, token = info.token): Promise<{ status: number; body: T }> => {
    const res = await coreRequest(core.port, token, 'GET', p);
    return { status: res.status, body: res.body as T };
  };
  type Item = { sessionId: string; workspace: string; outcomes: Record<string, number>; prompts: number };

  test("a workspace's sessions, newest activity first, each with its outcome counts", async () => {
    const { status, body } = await get<Item[]>(`/sessions?workspace=${encodeURIComponent(a)}`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.map((s) => s.sessionId), ['s-new', 's-old'], 'an outcome written later does not make a session active');
    assert.deepStrictEqual(body[0].outcomes, { tests_green: 1, finding_response: 1 });
    assert.deepStrictEqual(body[1].outcomes, { commit_kept: 1 });
    assert.strictEqual((await get<Item[]>('/sessions')).body.length, 3, 'without a workspace: every workspace the token reads, as before');
    assert.strictEqual((await get(`/sessions?workspace=${encodeURIComponent(path.join(home, 'none'))}`)).status, 404);
  });

  test('one session as its page draws it: the view VS Code builds, and its outcomes', async () => {
    const { status, body } = await get<{ workspace: string; view: { summary: { sessionId: string; toolCalls: number }; tools: unknown[]; tree: unknown }; outcomes: Array<{ type: string; ts: string }> }>(`/sessions/s-new/view?workspace=${encodeURIComponent(a)}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.workspace, a);
    assert.strictEqual(body.view.summary.sessionId, 's-new');
    assert.strictEqual(body.view.tools.length, 2);
    assert.ok(body.view.tree, 'the turn tree');
    assert.deepStrictEqual(body.outcomes.map((o) => o.type), ['tests_green', 'finding_response'], 'oldest first');
    assert.strictEqual((await get(`/sessions/s-n/view`)).status, 200, 'without a workspace: found by unique prefix');
    assert.strictEqual((await get(`/sessions/s-b/view?workspace=${encodeURIComponent(a)}`)).status, 404, "another workspace's session");
  });

  test("the Explore tab's state: the catalog and the picked sessions' views, in order, unknown ones named", async () => {
    const { body } = await get<{ catalog: unknown[]; sessions: Array<{ summary: { sessionId: string } }>; notLoaded: string[] }>(`/explore?workspace=${encodeURIComponent(a)}&ids=s-old,s-new,nope`);
    assert.ok(body.catalog.length > 10);
    assert.deepStrictEqual(body.sessions.map((s) => s.summary.sessionId), ['s-old', 's-new']);
    assert.deepStrictEqual(body.notLoaded, ['nope']);
    assert.strictEqual((await get(`/explore?ids=s-new`)).status, 400, 'names the workspace');
    assert.strictEqual((await get(`/explore?workspace=${encodeURIComponent(a)}&ids=${'x,'.repeat(9)}`)).status, 400, 'at most 8');
  });

  test("a workspace token reads only its own workspace's sessions", async () => {
    const minted = await coreRequest(core.port, info.token, 'POST', '/tokens', { workspaces: [b] });
    const token = (minted.body as { token: string }).token;
    assert.strictEqual((await get(`/sessions?workspace=${encodeURIComponent(a)}`, token)).status, 403);
    assert.strictEqual((await get(`/sessions/s-new/view?workspace=${encodeURIComponent(a)}`, token)).status, 403);
    assert.strictEqual((await get(`/explore?workspace=${encodeURIComponent(a)}&ids=s-new`, token)).status, 403);
    assert.strictEqual((await get(`/sessions/s-new/view`, token)).status, 404, 'not found among its own');
    assert.strictEqual((await get(`/sessions?workspace=${encodeURIComponent(b)}`, token)).status, 200);
  });

  test('the list is read again when a day file changes', async () => {
    await writer.write([ev(a, 's-third', 5, { kind: 'user_prompt', tokens: undefined })]);
    const { body } = await get<Item[]>(`/sessions?workspace=${encodeURIComponent(a)}`);
    assert.strictEqual(body[0].sessionId, 's-third');
  });

  test('the Factory Clock visualizers are served beside the page, the registry listed first', async () => {
    const host = { Host: `127.0.0.1:${core.port}` };
    const index = await raw(core.port, '/ui/viz/index.json', host);
    assert.strictEqual(index.status, 200);
    const files = JSON.parse(index.text) as string[];
    assert.strictEqual(files[0], 'viz/registry.js');
    assert.ok(files.includes('viz/factoryClock.js') && files.includes('viz/turnTree.js'));
    for (const f of ['vizkit.js', 'viz.css', 'explore.js', 'viz/turnTree.js']) assert.strictEqual((await raw(core.port, `/ui/${f}`, host)).status, 200, f);
    for (const f of ['viz/../extension.js', 'viz/sub/x.js', 'detail.js', '..%2Fpackage.json', 'viz/registry.ts']) assert.strictEqual((await raw(core.port, `/ui/${f}`, host)).status, 404, f);
  });

  test('a session shows a live finding once, merged with the episode it continues; muted ones are left out', () => {
    const ep = (id: string, open: boolean, refs: string[]) => ({ heuristicId: id, severity: 'info' as const, summary: `${id} then`, eventRefs: refs, startTs: 'a', endTs: 'b', open });
    const live = [{ heuristicId: 'stalled', severity: 'warn' as const, summary: 'stalled now', eventRefs: ['e2', 'e3'] }];
    const out = sessionFindings([ep('stalled', true, ['e1', 'e2']), ep('cache-thrash', false, ['e5']), ep('noisy', false, ['e6'])], live, ['noisy']);
    assert.deepStrictEqual(
      out.map((f) => [f.heuristicId, f.active, f.summary, f.eventRefs.join()]),
      [
        ['stalled', true, 'stalled now', 'e1,e2,e3'],
        ['cache-thrash', false, 'cache-thrash then', 'e5'],
      ]
    );
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
