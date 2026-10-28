import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '../../core/types';
import { builtInHeuristics } from '../../heuristics/builtIns';
import { RuleStore } from '../../heuristics/ruleStore';
import { isDetailMessage } from '../../ui/detailModel';
import { parseRulesFile, SuggestionsController } from '../../ui/suggestionsController';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000).toISOString();

let seq = 0;
function ev(sessionId: string, turnId: string, min: number, overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  seq += 1;
  return { eventId: `e${seq}`, sessionId, turnId, agent: 'claude-code', ts: at(min), status: 'unknown', raw: { adapter: 'test', ref: 'n/a' }, ...overrides };
}

/** A turn of a prompt, one read, and model calls; an outlier reads one file six times and makes twelve model calls. */
function turn(sessionId: string, n: number, outlier = false): NormalizedEvent[] {
  const turnId = `${sessionId}-t${n}`;
  const min = n * 20;
  const events = [ev(sessionId, turnId, min, { kind: 'user_prompt' })];
  for (let i = 0; i < (outlier ? 6 : 1); i++) {
    events.push(ev(sessionId, turnId, min + 1, { kind: 'tool_call', toolName: 'Read', toolCategory: 'file-read', status: 'success', target: outlier ? 'same.ts' : `f${sessionId}${n}.ts` }));
  }
  const calls = outlier ? 12 : 2 + (n % 3);
  for (let i = 0; i < calls; i++) events.push(ev(sessionId, turnId, min + 2, { kind: 'turn_stop', model: 'm', tokens: { input: 10, output: 5 }, ...(i === calls - 1 ? { endsTurn: true } : {}) }));
  return events;
}

function history(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const s of ['s1', 's2', 's3', 's4', 's5']) for (let n = 0; n < 20; n++) events.push(...turn(s, n));
  ['s1', 's2', 's3'].forEach((s, i) => events.push(...turn(s, 100 + i, true)));
  return events;
}

async function withController(fn: (c: SuggestionsController, calls: { rulesChanged: number; applied: unknown[]; dismissed: string[] }, store: RuleStore) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-suggestions-'));
  try {
    const store = new RuleStore(dir);
    await store.load();
    const calls = { rulesChanged: 0, applied: [] as unknown[], dismissed: [] as string[] };
    const controller = new SuggestionsController({
      loadEvents: async () => history(),
      options: () => ({ existing: builtInHeuristics(), settingsFor: () => ({}) }),
      store,
      settingsRules: () => ({ origin: 'settings', rules: [{ id: 'user:mine', title: 'Mine' }], categories: [] }),
      rulesChanged: () => (calls.rulesChanged += 1),
      applySetting: async (...args) => void calls.applied.push(args),
      dismissed: () => calls.dismissed,
      setDismissed: async (ids) => void (calls.dismissed = ids),
      sessionName: (id) => (id === 's1' ? 'Session one' : undefined),
      source: () => 'my-project',
      days: () => 30,
      now: () => at(5000),
    });
    await fn(controller, calls, store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const READS = 'discovery:reads-one-file';

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('before discovery runs, the view is idle and lists rules from settings', () =>
    withController(async (c) => {
      const v = c.view();
      assert.strictEqual(v.status, 'idle');
      assert.strictEqual(c.hasRun, false);
      assert.deepStrictEqual(v.saved, [{ section: 'rules', id: 'user:mine', title: 'Mine', origin: 'settings' }]);
    }));

  test('discovery fills the view with candidates, named example sessions, and threshold suggestions', () =>
    withController(async (c) => {
      let notified = 0;
      c.onChange(() => (notified += 1));
      await c.discover();
      assert.strictEqual(notified, 2); // running, then ready
      const v = c.view();
      assert.strictEqual(v.status, 'ready');
      const reads = v.candidates.find((x) => x.id === READS)!;
      assert.deepStrictEqual([reads.threshold, reads.proposedThreshold, reads.turnsAbove], [6, 6, 3]);
      assert.ok(reads.examples.some((x) => x.sessionId === 's1' && x.name === 'Session one'));
      const calls = v.thresholds.find((t) => t.setting === 'maxModelCalls')!;
      assert.deepStrictEqual([calls.current, calls.suggested], [100, 12]);
    }));

  test('a tweaked threshold is re-scored, and going back restores the proposal', () =>
    withController(async (c) => {
      await c.discover();
      c.tweak(READS, 2);
      let reads = c.view().candidates.find((x) => x.id === READS)!;
      assert.deepStrictEqual([reads.threshold, reads.proposedThreshold], [2, 6]);
      assert.strictEqual(reads.turnsAbove, 3);
      assert.deepStrictEqual((reads.rule.when as { gte: number }).gte, 2);
      c.tweak(READS, 7);
      reads = c.view().candidates.find((x) => x.id === READS)!;
      assert.deepStrictEqual([reads.turnsAbove, reads.episodes], [0, 0]);
      c.tweak(READS, 6);
      assert.strictEqual(c.view().candidates.find((x) => x.id === READS)!.episodes, 3);
    }));

  test('accepting saves the rule as shown, with discovery provenance and this workspace, and rebuilds heuristics', () =>
    withController(async (c, calls, store) => {
      await c.discover();
      c.tweak(READS, 5);
      await c.accept(READS);
      const [saved] = store.list('rules');
      assert.strictEqual(saved.doc.id, READS);
      assert.deepStrictEqual((saved.doc.when as { gte: number }).gte, 5);
      assert.deepStrictEqual(saved.provenance, { proposedBy: 'discovery', addedAt: at(5000), workspace: 'my-project', replay: { episodes: 3, sessions: 3 } });
      assert.strictEqual(calls.rulesChanged, 1);
      const v = c.view();
      assert.ok(!v.candidates.some((x) => x.id === READS));
      assert.ok(v.saved.some((s) => s.id === READS && s.origin === 'saved'));
      await c.removeSaved('rules', READS);
      assert.deepStrictEqual(store.list('rules'), []);
      assert.strictEqual(calls.rulesChanged, 2);
    }));

  test('dismissals are remembered and can be cleared', () =>
    withController(async (c, calls) => {
      await c.discover();
      await c.dismiss(READS);
      assert.deepStrictEqual(calls.dismissed, [READS]);
      assert.ok(!c.view().candidates.some((x) => x.id === READS));
      assert.strictEqual(c.view().dismissed, 1);
      await c.discover();
      assert.ok(!c.view().candidates.some((x) => x.id === READS), 'stays dismissed on the next run');
      await c.clearDismissed();
      assert.ok(c.view().candidates.some((x) => x.id === READS));
    }));

  test("applying a threshold writes discovery's suggestion", () =>
    withController(async (c, calls) => {
      await c.discover();
      await c.applyThreshold('runaway-turn', 'maxModelCalls');
      assert.deepStrictEqual(calls.applied, [['runaway-turn', 'maxModelCalls', 12]]);
      const t = c.view().thresholds.find((x) => x.setting === 'maxModelCalls')!;
      assert.strictEqual(t.current, 12);
      await c.applyThreshold('runaway-turn', 'nonsense');
      assert.strictEqual(calls.applied.length, 1);
    }));

  test('rules files: an export, a plain list, and anything else', () => {
    const exported = parseRulesFile(JSON.stringify({ version: 1, rules: [{ doc: { id: 'a:b' }, provenance: {} }], categories: [{ doc: { id: 'a:shell/c' }, provenance: {} }] }));
    assert.deepStrictEqual([exported.rules, exported.categories, exported.errors], [[{ id: 'a:b' }], [{ id: 'a:shell/c' }], []]);
    assert.deepStrictEqual(parseRulesFile('[{"id":"a:b"}]').rules, [{ id: 'a:b' }]);
    assert.ok(parseRulesFile('{"x":1}').errors[0].includes('expected a list'));
    assert.ok(parseRulesFile('{').errors[0].startsWith('not JSON'));
  });

  test('the page can only send well-formed suggestion messages', () => {
    assert.ok(isDetailMessage({ type: 'tab', tab: 'suggestions' }));
    assert.ok(isDetailMessage({ type: 'tweakSuggestion', id: READS, threshold: 0.35 }));
    assert.ok(!isDetailMessage({ type: 'tweakSuggestion', id: READS, threshold: -1 }));
    assert.ok(!isDetailMessage({ type: 'tweakSuggestion', id: READS, threshold: Infinity }));
    assert.ok(isDetailMessage({ type: 'applyThreshold', heuristic: 'runaway-turn', setting: 'maxModelCalls' }));
    assert.ok(isDetailMessage({ type: 'removeSaved', section: 'categories', id: 'x' }));
    assert.ok(!isDetailMessage({ type: 'removeSaved', section: 'settings', id: 'x' }));
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
