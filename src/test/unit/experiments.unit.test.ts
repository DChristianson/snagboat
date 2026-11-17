import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { experimentSchema, PeriodReport, Proposal } from '@snagboat/schema';
import { loadConfig, saveConfig } from '../../core/config';
import { ExperimentStore } from '../../core/experiments';
import { RuleStore } from '../../heuristics/ruleStore';

// Experiments (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.8): Accept report applies each accepted
// proposal in its scope and tracks it; revert puts back exactly what was there.

const WS = '/work/snagboat';
const OTHER = '/work/other';
const m = (id: string, value: number) => ({ id, label: id, unit: '', better: 'lower' as const, value });
const report: PeriodReport = {
  version: 1, id: '2026-W46', advisor: 'purser', advisorVersion: 'v', period: 'weekly', label: '2026-W46',
  from: new Date(2026, 10, 9).toISOString(), to: new Date(2026, 10, 16).toISOString(), trigger: 'schedule', createdAt: new Date(2026, 10, 16).toISOString(),
  measures: [m('cache_hit_rate', 61), m('tokens_per_milestone', 41200)],
  workspaces: [{ workspace: WS, measures: [m('cache_hit_rate', 58), m('tokens_per_milestone', 39000)] }],
  rules: { defaults: {}, projects: {}, saved: [] }, summary: '',
};
let n = 0;
const proposal = (extra: Partial<Proposal>): Proposal => ({
  id: `purser-2026-W46-r1-p${(n += 1)}`, advisor: 'purser', report: '2026-W46', rev: 1, title: `P${n}`, change: { kind: 'setting', key: 'heuristics.cacheThrash.minTokens', before: 50000, after: 30000 },
  scope: 'global', what: 'w', why: 'y', prediction: { measure: 'cache_hit_rate', text: 't' }, status: 'accepted', proposedAt: '', updatedAt: '', ...extra,
});
const rule = { id: 'advisor:long-reads', title: 'Long reads', scope: 'turn', measures: { reads: { type: 'count', filter: { kind: 'tool_call', toolCategory: 'file-read' } } }, when: { all: [{ measure: 'reads', gte: 20 }] }, severity: 'info', summary: '{reads} reads', suggestedAction: 'Point it at the file.' };

function validate(schema: Record<string, any>, value: unknown): void {
  // Field names only; the schema's own test (advisorRecordsSchema) checks values.
  for (const key of Object.keys(value as object)) assert.ok(key in schema.properties, `${key} is in the schema`);
  for (const key of schema.required) assert.ok(key in (value as object), `${key} is present`);
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('accepting applies each change in its scope, with its baseline and review date; revert puts back what was there', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-exp-'));
    saveConfig(home, { version: 1, defaults: { 'heuristics.cacheThrash.minTokens': 50000, captureContent: true }, projects: { [WS]: { 'heuristics.contextPressure.percent': 85 }, [OTHER]: { 'heuristics.contextPressure.percent': 70 } } });
    let changed = 0;
    const store = new ExperimentStore(home, () => new Date(2026, 10, 16, 9, 40), () => (changed += 1));
    const p = [
      proposal({}),
      proposal({ change: { kind: 'setting', key: 'heuristics.contextPressure.percent', before: 85, after: 80 }, scope: { workspace: WS }, prediction: { measure: 'tokens_per_milestone', text: 't' } }),
      proposal({ change: { kind: 'setting', key: 'tokenBudget.session', after: 600000 }, scope: { workspace: WS }, prediction: { measure: 'tokens_per_milestone', text: 't' } }),
      proposal({ change: { kind: 'rule', rule }, prediction: { measure: 'tokens_per_milestone', text: 't' } }),
      proposal({ change: { kind: 'rule', rule: { ...rule, id: 'advisor:ws-reads' } }, scope: { workspace: WS }, prediction: { measure: 'cache_hit_rate', text: 't' } }),
    ];
    const xs = await store.start(report, p);
    assert.strictEqual(xs.length, 5);
    assert.strictEqual(changed, 1, 'the heuristics are re-run once');
    const { config } = loadConfig(home);
    assert.deepStrictEqual(config.defaults, { 'heuristics.cacheThrash.minTokens': 30000, captureContent: true });
    assert.deepStrictEqual(config.projects[WS], { 'heuristics.contextPressure.percent': 80, 'tokenBudget.session': 600000, rules: [{ ...rule, id: 'advisor:ws-reads' }] });
    assert.deepStrictEqual(config.projects[OTHER], { 'heuristics.contextPressure.percent': 70 }, 'another workspace is untouched');
    const saved = new RuleStore(home);
    await saved.load();
    assert.deepStrictEqual(saved.list('rules').map((r) => [r.doc.id, r.provenance.proposedBy, r.provenance.experiment]), [['advisor:long-reads', 'advisor', p[3].id]]);
    assert.deepStrictEqual(xs[0].baseline, { report: '2026-W46', measure: 'cache_hit_rate', value: 61 });
    assert.deepStrictEqual(xs[1].baseline, { report: '2026-W46', measure: 'tokens_per_milestone', value: 39000 }, "a workspace's own measure");
    assert.strictEqual(xs[0].reviewAt, new Date(2026, 10, 23).toISOString(), 'judged at the next report');
    assert.deepStrictEqual([xs[2].change, xs[2].status, xs[2].keptGoing], [{ kind: 'setting', key: 'tokenBudget.session', after: 600000 }, 'running', 0], 'before is absent: it was unset there');
    for (const x of xs) validate(experimentSchema as Record<string, any>, x);
    assert.deepStrictEqual(await store.start(report, [p[0]]), [], 'an accepted proposal starts once');

    for (const x of xs) await store.revert(x.id);
    const after = loadConfig(home).config;
    assert.deepStrictEqual(after.defaults, { 'heuristics.cacheThrash.minTokens': 50000, captureContent: true });
    assert.deepStrictEqual(after.projects[WS], { 'heuristics.contextPressure.percent': 85, rules: [] });
    await saved.load();
    assert.deepStrictEqual(saved.list('rules'), []);
    assert.deepStrictEqual(store.list().map((x) => [x.status, x.ended?.how]), xs.map(() => ['ended', 'reverted']));
    await assert.rejects(store.revert(xs[0].id), /already ended/);
    await assert.rejects(store.revert('nope'), /no experiment nope/);
  });

  test('a newer change to the same setting and scope replaces the running one; other changes to the same measure overlap', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-exp-'));
    const store = new ExperimentStore(home, () => new Date(2026, 10, 16));
    const [first] = await store.start(report, [proposal({ change: { kind: 'setting', key: 'heuristics.contextPressure.percent', after: 85 }, scope: { workspace: WS } })]);
    const [second, third] = await store.start({ ...report, id: '2026-W47' }, [
      proposal({ change: { kind: 'setting', key: 'heuristics.contextPressure.percent', after: 80 }, scope: { workspace: WS } }),
      proposal({ change: { kind: 'setting', key: 'heuristics.stalled.minutes', after: 6 }, scope: { workspace: WS } }),
    ]);
    assert.deepStrictEqual(store.get(first.id)!.ended, { at: new Date(2026, 10, 16).toISOString(), how: 'replaced', by: second.id });
    assert.deepStrictEqual(second.change, { kind: 'setting', key: 'heuristics.contextPressure.percent', before: 85, after: 80 }, 'its before is what the replaced one set');
    assert.deepStrictEqual(third.overlaps, [second.id]);
    assert.deepStrictEqual(store.get(second.id)!.overlaps, [third.id], 'both are flagged');
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
