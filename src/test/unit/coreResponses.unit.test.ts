import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { EventLog } from '../../core/eventLog';
import { CoreClient } from '../../core/service/client';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { WorkspaceFindings } from '../../core/service/findings';
import { ResponseBook } from '../../core/service/responses';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';
import { Finding } from '../../heuristics/types';

// Responses to findings kept by the core (RFC step 5a): any front door responds through it,
// so the advisor UI works without VS Code, and a window that's a client mirrors it.

const RULE = { id: 'test:calls', title: 'Calls', scope: 'session', measure: { type: 'count', filter: { kind: 'turn_stop', hasTokens: true } }, when: { gte: 1 }, severity: 'info', summary: '{value} model calls' };
const finding = (id: string): Finding => ({ heuristicId: id, severity: 'info', summary: `${id} fired`, eventRefs: ['e1'], detectedAt: new Date().toISOString() });

let n = 0;
const call = (workspace: string): NormalizedEvent => ({
  eventId: `c${(n += 1)}`, sessionId: 's1', agent: 'claude-code', ts: new Date().toISOString(), kind: 'turn_stop', status: 'success',
  tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, raw: { adapter: 'test', ref: `r${n}` }, workspace,
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test("the book: useful also acknowledges, acknowledging ends with the episode, mutes last and are saved, episodes are logged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-book-'));
    const ended: string[] = [];
    const book = new ResponseBook(dir, (e) => ended.push(`${e.heuristicId}:${e.usefulAt ? 'useful' : e.mutedAt ? 'muted' : 'passed'}`));
    assert.deepStrictEqual(book.respond('stalled', 'acknowledge'), { acknowledged: false, useful: false, muted: false }, 'nothing active to acknowledge');
    book.update([finding('stalled')]);
    assert.deepStrictEqual(book.respond('stalled', 'useful'), { acknowledged: true, useful: true, muted: false });
    book.update([]);
    assert.deepStrictEqual(book.state('stalled'), { acknowledged: false, useful: false, muted: false }, 'gone with the episode');
    assert.deepStrictEqual(ended, ['stalled:useful']);
    book.respond('cache-thrash', 'mute');
    book.update([finding('cache-thrash')]);
    book.update([]);
    assert.deepStrictEqual(ended, ['stalled:useful', 'cache-thrash:muted'], "a muted heuristic's episode is muted, not passed");
    assert.deepStrictEqual(new ResponseBook(dir, () => undefined).mutedHeuristics(), ['cache-thrash'], 'mutes are saved');
    book.respond('cache-thrash', 'unmute');
    assert.deepStrictEqual(new ResponseBook(dir, () => undefined).mutedHeuristics(), []);
    assert.deepStrictEqual((await book.episodes()).map((e) => e.heuristicId), ['stalled', 'cache-thrash']);
  });

  test('the core keeps a response with no VS Code window; streams get it with the findings; its end is an outcome', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-responses-')));
    const w = path.join(home, 'w');
    fs.mkdirSync(w);
    saveConfig(home, { version: 1, defaults: { rules: [RULE] }, projects: {} });
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
    try {
      const info = readCoreFile(home)!;
      await new StoreWriter(home).write([call(w)]);
      // A browser key, no window anywhere.
      const link = (await coreRequest(core.port, info.token, 'POST', '/ui-links', {})).body as { url: string };
      const code = link.url.split('#')[1];
      const session = await fetch(`http://127.0.0.1:${core.port}/ui-session`, { method: 'POST', body: JSON.stringify({ code }) });
      const reader = ((await session.json()) as { token: string }).token;
      const respond = (response: string) => coreRequest(core.port, reader, 'POST', '/findings/respond', { workspace: w, heuristicId: 'test:calls', response });
      const res = await respond('useful');
      assert.deepStrictEqual([res.status, res.body], [200, { heuristicId: 'test:calls', acknowledged: true, useful: true, muted: false }]);
      const now = (await coreRequest(core.port, reader, 'GET', `/findings?workspace=${encodeURIComponent(w)}`)).body as WorkspaceFindings[];
      assert.deepStrictEqual(now[0].responses['test:calls'], { acknowledged: true, useful: true, muted: false });
      assert.strictEqual((await coreRequest(core.port, reader, 'POST', '/findings/respond', { workspace: path.join(home, 'nowhere'), heuristicId: 'x', response: 'mute' })).status, 404);

      // A window that's a client hears it with the findings.
      const window = await CoreClient.connect({ home, cliPath: '/nowhere', workspace: w, ensure: async () => readCoreFile(home)! });
      const seen: WorkspaceFindings[] = [];
      window.follow({ onEvents: () => undefined, onFindings: (r) => seen.push(r) }, new Date().toISOString());
      try {
        await waitFor(() => seen.some((r) => r.responses['test:calls']?.useful));
        assert.deepStrictEqual((await window.respond('test:calls', 'mute'))?.muted, true, 'the window responds through the core too');
        await waitFor(() => seen.some((r) => r.muted.includes('test:calls')));
      } finally {
        window.close();
      }
      // The rule's threshold rises; its finding clears; the episode ends; the core records how you met it.
      saveConfig(home, { version: 1, defaults: { rules: [{ ...RULE, when: { gte: 100 } }] }, projects: {} });
      await coreRequest(core.port, reader, 'GET', `/findings?workspace=${encodeURIComponent(w)}`);
      await waitFor(async () => (await new EventLog(workspaceStoreDir(home, w)).readAll()).some((e) => e.kind === 'outcome'));
      const outcome = (await new EventLog(workspaceStoreDir(home, w)).readAll()).find((e) => e.kind === 'outcome')!;
      assert.deepStrictEqual([outcome.outcome?.type, outcome.outcome?.heuristicId, outcome.sessionId], ['finding_response', 'test:calls', 's1']);
      assert.ok(['useful', 'muted'].includes(outcome.outcome!.response!));
      assert.ok(fs.existsSync(path.join(workspaceStoreDir(home, w), 'finding-responses.jsonl')));
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
