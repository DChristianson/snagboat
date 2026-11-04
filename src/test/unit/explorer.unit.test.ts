import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventLog } from '../../core/eventLog';
import { SessionIndex } from '../../core/sessions';
import { NormalizedEvent } from '../../core/types';
import { isDetailMessage } from '../../ui/detailModel';
import { buildExplorerState } from '../../ui/explorerModel';
import { SessionController } from '../../ui/sessionController';
import { SessionView } from '../../ui/sessionModel';
import { CATALOG, EXPLORE_SESSION_CAP, TAXONOMY, validateCatalog, VisualizerEntry } from '../../ui/visualizers';

const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 10, min)).toISOString();
let n = 0;
function e(partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  return { eventId: `e${n++}`, sessionId: 'S1', agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 't', ref: 'n/a' }, ...partial };
}
const call = (min: number, turnId: string | undefined, tokens: number, extra: Partial<NormalizedEvent> = {}) =>
  e({ kind: 'turn_stop', ts: at(min), turnId, model: 'opus', tokens: { input: 10, cacheRead: tokens - 10 - 5, output: 5 }, ...extra });

/** A short session: one prompt and `calls` model calls, all in one turn. */
function session(sessionId: string, calls: number): NormalizedEvent[] {
  const out = [e({ kind: 'user_prompt', ts: at(0), turnId: 'p1', sessionId })];
  for (let i = 1; i <= calls; i++) out.push(call(i, 'p1', 100 * i, { sessionId }));
  return out;
}

const entry = (over: Partial<VisualizerEntry>): VisualizerEntry => ({ ...CATALOG[0], ...over });

async function controllerWith(sessions: Record<string, number>): Promise<{ controller: SessionController; idx: SessionIndex }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-explorer-'));
  const log = new EventLog(dir);
  await log.init();
  const idx = new SessionIndex();
  for (const [id, calls] of Object.entries(sessions)) {
    for (const ev of session(id, calls)) {
      log.append(ev);
      idx.ingest(ev);
    }
  }
  return { controller: new SessionController(idx, log, () => ({}), { active: () => [] }), idx };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the catalog conforms to the taxonomy', () => {
    assert.deepStrictEqual(validateCatalog(CATALOG, TAXONOMY), []);
    assert.deepStrictEqual(Object.keys(TAXONOMY), ['category', 'purpose', 'level', 'dimension']);
    assert.deepStrictEqual(Object.keys(TAXONOMY.category.values), ['temporal', 'actor', 'conversational', 'dependency', 'quantitative', 'state', 'semantic']);
    assert.deepStrictEqual(CATALOG.map((v) => v.id), ['turn-tree', 'context-timeline', 'session-strips', 'cost-per-prompt', 'context-fill', 'sequence-diagram', 'event-graph', 'actor-graph', 'prompt-terms', 'gantt', 'treemap']);
  });

  test('a broken catalog names each problem', () => {
    const problems = (catalog: VisualizerEntry[]) => validateCatalog(catalog, TAXONOMY);
    assert.strictEqual(problems([CATALOG[0], CATALOG[0]]).length, 1);
    assert.match(problems([CATALOG[0], CATALOG[0]])[0], /duplicate id "turn-tree"/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, purpose: [] } })])[0], /"purpose" is missing or empty/);
    const missing = { ...CATALOG[0].tags } as Partial<VisualizerEntry['tags']>;
    delete missing.level;
    assert.match(problems([entry({ tags: missing as VisualizerEntry['tags'] })])[0], /"level" is missing or empty/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, category: ['temporal', 'musical'] } })])[0], /"musical" is not a category value/);
    assert.match(problems([entry({ title: '' })])[0], /empty title/);
    assert.match(problems([entry({ description: '' })])[0], /empty description/);
    assert.match(problems([entry({ id: '' })])[0], /no id/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, mood: ['calm'] } as VisualizerEntry['tags'] })])[0], /"mood" is not a facet/);
  });

  test('the explorer state keeps the picked order and names the ids without a view', () => {
    const views: Record<string, SessionView> = { a: { summary: { sessionId: 'a' } } as SessionView, c: { summary: { sessionId: 'c' } } as SessionView };
    const state = buildExplorerState(['c', 'b', 'a'], (id) => views[id]);
    assert.deepStrictEqual(state.sessions.map((s) => s.summary.sessionId), ['c', 'a']);
    assert.deepStrictEqual(state.notLoaded, ['b']);
    assert.strictEqual(state.catalog, CATALOG);
    assert.strictEqual(state.taxonomy, TAXONOMY);
  });

  test('the controller keeps the Sessions tab session when the explore set changes, and vice versa', async () => {
    const { controller } = await controllerWith({ S1: 1, S2: 2, S3: 3 });
    assert.strictEqual((await controller.open('S1'))?.calls.length, 1);

    let state = await controller.explore(['S2', 'S3', 'nope']);
    assert.deepStrictEqual(state.sessions.map((s) => s.summary.sessionId), ['S2', 'S3']);
    assert.deepStrictEqual(state.notLoaded, ['nope']);
    assert.strictEqual(controller.view()?.summary.sessionId, 'S1', 'the open session is untouched');

    state = await controller.explore(['S3']);
    assert.deepStrictEqual(state.sessions.map((s) => s.summary.sessionId), ['S3']);
    assert.deepStrictEqual(controller.exploredSessionIds, ['S3']);
    assert.strictEqual(controller.view()?.calls.length, 1, 'S1 still views');
    assert.strictEqual(controller.ingest(call(9, 'p1', 10, { sessionId: 'S2' })), false, 'S2 is gone');

    controller.close();
    assert.strictEqual(controller.view(), undefined);
    assert.deepStrictEqual(controller.explorerState().sessions.map((s) => s.summary.sessionId), ['S3'], 'closing the Sessions tab leaves the explore set');

    // The open session can also be in the explore set: one copy, kept by either.
    await controller.open('S3');
    await controller.explore([]);
    assert.strictEqual(controller.view()?.summary.sessionId, 'S3');
    await controller.explore(['S3', 'S1']);
    controller.close();
    assert.deepStrictEqual(controller.explorerState().sessions.map((s) => s.summary.sessionId), ['S3', 'S1']);

    controller.closeExplorer();
    assert.deepStrictEqual(controller.explorerState(), { taxonomy: TAXONOMY, catalog: CATALOG, sessions: [], notLoaded: [] });
    assert.strictEqual(controller.ingest(call(9, 'p1', 10, { sessionId: 'S3' })), false, 'nothing is loaded any more');
  });

  test('a live event for an explored session updates its view', async () => {
    const { controller, idx } = await controllerWith({ S1: 1, S2: 2 });
    await controller.open('S1');
    await controller.explore(['S2']);
    const live = call(30, 'p1', 50, { sessionId: 'S2' });
    idx.ingest(live);
    assert.strictEqual(controller.ingest(live), true);
    assert.strictEqual(controller.ingest(live), false, 'duplicates ignored');
    assert.strictEqual(controller.explorerState().sessions[0].calls.length, 3);
    assert.strictEqual(controller.view()?.calls.length, 1, 'the open session is unaffected');
    const other = call(30, 'p1', 50, { sessionId: 'S1' });
    idx.ingest(other);
    assert.strictEqual(controller.ingest(other), true, 'the open session is kept current too');
    assert.strictEqual(controller.view()?.calls.length, 2);
  });

  test('the explore set is capped and deduplicated', async () => {
    const ids = Array.from({ length: EXPLORE_SESSION_CAP + 2 }, (_, i) => `S${i}`);
    const { controller } = await controllerWith(Object.fromEntries(ids.map((id) => [id, 1])));
    const state = await controller.explore([...ids, ids[0]]);
    assert.deepStrictEqual(state.sessions.map((s) => s.summary.sessionId), ids.slice(0, EXPLORE_SESSION_CAP));
    assert.deepStrictEqual(state.notLoaded, []);
    assert.deepStrictEqual((await controller.explore(['S1', 'S1', 'S2'])).sessions.map((s) => s.summary.sessionId), ['S1', 'S2']);
  });

  test('the picker lists every session across days, newest start first, with headlines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-explorer-'));
    const log = new EventLog(dir);
    await log.init();
    const idx = new SessionIndex();
    const started = (sessionId: string, ts: string, lastTs: string) => [e({ kind: 'user_prompt', turnId: 'p1', sessionId, ts }), e({ kind: 'turn_stop', turnId: 'p1', sessionId, ts: lastTs, model: 'opus', tokens: { input: 1, output: 1 } })];
    // "old" has the latest activity but the earliest start, so sorting by activity would put it first.
    for (const ev of [...started('old', '2026-10-20T10:00:00.000Z', '2026-10-23T10:00:00.000Z'), ...started('new', '2026-10-22T10:00:00.000Z', '2026-10-22T11:00:00.000Z'), ...started('mid', '2026-10-21T10:00:00.000Z', '2026-10-21T11:00:00.000Z')]) {
      log.append(ev);
      idx.ingest(ev);
    }
    const controller = new SessionController(idx, log, () => ({}), { active: () => [] }, { headline: (id) => (id === 'mid' ? 'A headline' : undefined) });
    const list = controller.listAll();
    assert.deepStrictEqual(list.sessions.map((s) => s.sessionId), ['new', 'mid', 'old']);
    assert.deepStrictEqual(list.headlines, { mid: 'A headline' });
  });

  test('explorer messages from the page are validated', () => {
    assert.ok(isDetailMessage({ type: 'listExploreSessions' }));
    assert.ok(isDetailMessage({ type: 'tab', tab: 'explore' }));
    assert.ok(isDetailMessage({ type: 'explore', sessionIds: [] }));
    assert.ok(isDetailMessage({ type: 'explore', sessionIds: ['a', 'b'] }));
    assert.ok(isDetailMessage({ type: 'closeExplorer' }));
    assert.ok(!isDetailMessage({ type: 'explore' }));
    assert.ok(!isDetailMessage({ type: 'explore', sessionIds: 'a' }));
    assert.ok(!isDetailMessage({ type: 'explore', sessionIds: ['a', 1] }));
    assert.ok(!isDetailMessage({ type: 'explore', sessionIds: Array.from({ length: EXPLORE_SESSION_CAP + 1 }, () => 'a') }));
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
  if (failures > 0) process.exit(1);
}

main();
