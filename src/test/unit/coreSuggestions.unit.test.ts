import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { externalChanges, loadConfig, SnagboatConfig } from '../../core/config';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { FindingsService } from '../../core/service/findings';
import { parseSuggestionAction, SuggestionsService } from '../../core/service/suggestions';
import { SuggestionsView } from '../../discovery/suggestionsController';
import { readDismissed } from '../../core/suggestionsState';
import { syntheticEvents } from 'factory-clock/web';

// Suggestions in the advisor UI (RFC step 5c-2): the core runs VS Code's Suggestions controller
// over a workspace's store, with its own heuristics; writes go where VS Code's go (saved rules,
// user settings in config.json, dismissals in suggestions.json); and a VS Code window takes a
// setting changed in config.json elsewhere instead of undoing it.

function raw(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a setting changed in config.json elsewhere is one to take; what the window wrote itself is not', () => {
    const before: SnagboatConfig = { version: 1, defaults: { 'heuristics.stalled.minutes': 10, 'storage.perUserStore': true }, projects: { '/w': { 'collect': false } } };
    const after: SnagboatConfig = { version: 1, defaults: { 'heuristics.stalled.minutes': 15, 'storage.perUserStore': false, unknown: 1 }, projects: { '/w': {}, '/other': { collect: false } } };
    const keys = ['heuristics.stalled.minutes', 'storage.perUserStore', 'collect'];
    assert.deepStrictEqual(externalChanges(before, after, keys, ['/w']), [
      { scope: 'user', key: 'heuristics.stalled.minutes', value: 15 },
      { scope: { folder: '/w' }, key: 'collect', value: undefined },
    ], 'storage.* never syncs; only declared keys; only its own folders');
    assert.deepStrictEqual(externalChanges(before, before, keys, ['/w']), []);
  });

  test('actions are checked before they reach the controller', () => {
    assert.deepStrictEqual(parseSuggestionAction({ action: 'tweak', id: 'c1', threshold: 3 }), { action: 'tweak', id: 'c1', threshold: 3 });
    assert.deepStrictEqual(parseSuggestionAction({ action: 'removeSaved', section: 'rules', id: 'r' }), { action: 'removeSaved', section: 'rules', id: 'r' });
    for (const bad of [{ action: 'tweak', id: 'c1', threshold: 'x' }, { action: 'accept' }, { action: 'removeSaved', section: 'files', id: 'r' }, { action: 'writeFile' }, { action: 'approve', id: '1' }, { action: 'dismiss', id: 'x'.repeat(201) }, null]) assert.strictEqual(parseSuggestionAction(bad), undefined, JSON.stringify(bad));
  });

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-suggest-')));
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  for (const w of [a, b]) fs.mkdirSync(w);
  // Real-shaped sessions, moved to the last few days so discovery's window has them.
  // Four copies under new ids, so discovery has the 50 turns it needs to say what's unusual.
  const base = syntheticEvents();
  const events = [0, 1, 2, 3].flatMap((k) =>
    base.map((e) => ({ ...e, eventId: `${e.eventId}-${k}`, sessionId: `${e.sessionId}-${k}`, ...(e.turnId ? { turnId: `${e.turnId}-${k}` } : {}), ts: new Date(Date.parse(e.ts) - k * 86_400_000).toISOString() }))
  );
  const latest = Math.max(...events.map((e) => Date.parse(e.ts)));
  const shift = Date.now() - 3_600_000 - latest;
  await new StoreWriter(home).write([...events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString(), workspace: a })), { eventId: 'b1', sessionId: 'sb', agent: 'claude-code', ts: new Date().toISOString(), kind: 'user_prompt', status: 'success', raw: { adapter: 't', ref: 'b1' }, workspace: b }]);
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
  const info = readCoreFile(home)!;
  type View = { status: string; candidates: Array<{ id: string }>; thresholds: Array<{ heuristic: string; setting: string; suggested?: number }>; dismissed: number; sessions: number };
  const get = async (token = info.token) => coreRequest(core.port, token, 'GET', `/suggestions?workspace=${encodeURIComponent(a)}`, undefined, 60_000);
  const act = async (body: Record<string, unknown>, token = info.token) => coreRequest(core.port, token, 'POST', '/suggestions', { workspace: a, ...body }, 60_000);
  const ready = async (): Promise<View> => {
    for (let i = 0; i < 100; i++) {
      const v = (await get()).body as View;
      if (v.status !== 'running' && v.status !== 'idle') return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('discovery never finished');
  };

  test("discovery runs over the workspace's store on the first ask, and its view comes back", async () => {
    const view = await ready();
    assert.strictEqual(view.status, 'ready', JSON.stringify(view).slice(0, 300));
    assert.ok(view.sessions >= 12, `sessions: ${view.sessions}`);
    assert.ok(view.candidates.length > 0, 'candidate rules');
    assert.ok(view.thresholds.some((t) => t.suggested !== undefined), 'threshold suggestions');
  });

  test('dismissing is kept in suggestions.json; Show them again clears it', async () => {
    const view = await ready();
    const id = view.candidates[0].id;
    const after = (await act({ action: 'dismiss', id })).body as View;
    assert.deepStrictEqual(readDismissed(home), [id]);
    assert.ok(!after.candidates.some((c) => c.id === id), 'gone from the view');
    await act({ action: 'clearDismissed' });
    assert.deepStrictEqual(readDismissed(home), []);
  });

  test("applying a threshold writes your user settings in config.json, as VS Code's Apply does", async () => {
    const view = await ready();
    const t = view.thresholds.find((x) => x.suggested !== undefined)!;
    assert.strictEqual((await act({ action: 'applyThreshold', heuristic: t.heuristic, setting: t.setting })).status, 200);
    const key = Object.keys(loadConfig(home).config.defaults).find((k) => k.endsWith(`.${t.setting}`));
    assert.ok(key && loadConfig(home).config.defaults[key] === t.suggested, JSON.stringify(loadConfig(home).config.defaults));
  });

  test('accepting a candidate saves it to your rules, and the workspace evaluates it; removing it takes it out', async () => {
    const view = await ready();
    const id = view.candidates[0].id;
    const after = (await act({ action: 'accept', id })).body as View & { saved: Array<{ id: string; section: string }> };
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8')) as { rules: Array<{ doc: { id: string } }> };
    assert.ok(saved.rules.some((r) => r.doc.id === id), 'in rules.json');
    assert.ok(after.saved.some((x) => x.id === id && x.section === 'rules'));
    const findings = (await coreRequest(core.port, info.token, 'GET', `/findings?workspace=${encodeURIComponent(a)}`)).body as Array<{ problems: string[] }>;
    assert.deepStrictEqual(findings[0].problems, [], 'the saved rule is valid where it runs');
    const removed = (await act({ action: 'removeSaved', section: 'rules', id })).body as { saved: Array<{ id: string }> };
    assert.ok(!removed.saved.some((x) => x.id === id));
  });

  test('a reader key may act; a workspace token only on its own workspace; nonsense is refused', async () => {
    const link = (await coreRequest(core.port, info.token, 'POST', '/ui-links', {})).body as { code: string };
    const reader = ((await coreRequest(core.port, '', 'POST', '/ui-session', { code: link.code })).body as { token: string }).token;
    assert.strictEqual((await act({ action: 'clearDismissed' }, reader)).status, 200);
    const other = ((await coreRequest(core.port, info.token, 'POST', '/tokens', { workspaces: [b] })).body as { token: string }).token;
    assert.strictEqual((await get(other)).status, 403);
    assert.strictEqual((await act({ action: 'clearDismissed' }, other)).status, 403);
    assert.strictEqual((await act({ action: 'writeFile' })).status, 400);
    assert.strictEqual((await coreRequest(core.port, info.token, 'GET', '/suggestions')).status, 400);
  });

  test("VS Code's Suggestions script and its helpers are served beside the page; the rest of media/ isn't", async () => {
    for (const f of ['suggestions.js', 'shared.js']) assert.strictEqual(await raw(core.port, `/ui/${f}`), 200, f);
    for (const f of ['detail.js', 'sessions.js', 'detail.css']) assert.strictEqual(await raw(core.port, `/ui/${f}`), 404, f);
  });

  test("a workspace's idle discovery worker is stopped, and the next tweak brings it back with the same view", async () => {
    const findings = new FindingsService({ home, onChange: () => undefined });
    const lines: string[] = [];
    const idling = new SuggestionsService(home, findings, (l) => lines.push(l), { workerIdleMs: 400 });
    const steady = new SuggestionsService(home, findings, () => undefined, { workerIdleMs: 0 });
    const settle = async (s: SuggestionsService) => {
      for (let i = 0; i < 200; i++) {
        const v = await s.view(a);
        if (v.status !== 'running' && v.status !== 'idle') return v;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('discovery never finished');
    };
    try {
      await settle(steady);
      const before = await settle(idling);
      assert.strictEqual(before.status, 'ready');
      assert.deepStrictEqual(idling.worker(a), { running: true, restarts: 0 });
      for (let i = 0; i < 100 && idling.worker(a)?.running; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(idling.worker(a), { running: false, restarts: 0 }, 'stopped after sitting idle');
      assert.ok(lines.some((l) => /idle/.test(l) && l.includes(a)), lines.join('\n'));
      // The view doesn't need the worker: it's the one shown before it stopped.
      const strip = (v: SuggestionsView) => ({ ...v, ranAt: undefined });
      assert.deepStrictEqual(strip(await idling.view(a)), strip(before));
      const c = before.candidates.find((x) => x.threshold !== undefined)!;
      const tweaked = await idling.act(a, { action: 'tweak', id: c.id, threshold: c.threshold! * 2 });
      assert.deepStrictEqual(idling.worker(a), { running: true, restarts: 1 }, 'brought back for the tweak');
      const expected = await steady.act(a, { action: 'tweak', id: c.id, threshold: c.threshold! * 2 });
      assert.deepStrictEqual(strip(tweaked), strip(expected), "the same view as a worker that never stopped");
      assert.strictEqual(tweaked.candidates.find((x) => x.id === c.id)!.threshold, c.threshold! * 2);
      assert.deepStrictEqual(steady.worker(a), { running: true, restarts: 0 });
    } finally {
      idling.dispose();
      steady.dispose();
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
