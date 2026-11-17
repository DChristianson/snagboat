import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Experiment, PeriodReport, proposalEventSchema } from '@snagboat/schema';
import { approvalKey } from '../../advisor/advisors';
import { DEFAULT_PERSONAS, parseAdvisor } from '../../advisor/goals';
import { MAX_PROPOSALS, parseReportAnswer, performanceReportMessages, ReportInput } from '../../advisor/performanceReport';
import { FetchLike } from '../../advisor/providers';
import { writeApprovals } from '../../core/advisorApprovals';
import { saveConfig } from '../../core/config';
import { ProposalStore } from '../../core/proposals';
import { CoreAdvisors } from '../../core/service/advisorModels';
import { AdvisorReports } from '../../core/service/advisorReports';
import { PeriodJob } from '../../core/service/periodJob';
import { StoreWriter } from '../../core/service/storeWriter';

// The performance report (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.4): one model call per
// report, its answer held to the advisor contract, its proposals kept in an append-only log.

const WS = '/Users/dave/workspace/snagboat';
const purser = parseAdvisor(DEFAULT_PERSONAS.purser, 'built-in', 'purser').advisor!;
const report: PeriodReport = {
  version: 1, id: '2026-W46', advisor: 'purser', advisorVersion: purser.version, period: 'weekly', label: '2026-W46',
  from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z', trigger: 'schedule', createdAt: '2026-11-16T00:01:00.000Z',
  measures: [{ id: 'cache_hit_rate', label: 'Cache hit rate', unit: '%', better: 'higher', value: 61, previous: 68, trend: 'worse' }],
  workspaces: [{ workspace: WS, measures: [{ id: 'cache_hit_rate', label: 'Cache hit rate', unit: '%', better: 'higher', value: 58 }] }],
  rules: { defaults: { 'heuristics.cacheThrash.minTokens': 50000 }, projects: { [WS]: { 'heuristics.contextPressure.percent': 85 } }, saved: [] },
  summary: 'Slipping: cache hit rate down 7 points to 61%.',
};
const running: Experiment = {
  version: 1, id: 'x-1', advisor: 'purser', proposal: 'p', title: 'Earlier context warning', change: { kind: 'setting', key: 'heuristics.contextPressure.percent', before: 90, after: 85 },
  scope: { workspace: WS }, baseline: { report: '2026-W44', measure: 'cache_hit_rate', value: 60 }, prediction: { measure: 'cache_hit_rate', text: 'Up.' },
  startedAt: '2026-10-26T00:00:00.000Z', reviewAt: '2026-11-16T00:00:00.000Z', status: 'running', keptGoing: 0,
};
const input = (extra: Partial<ReportInput> = {}): ReportInput => ({ advisor: purser, report, experiments: [running], lastRound: [], discarded: [], policy: { prompts: true, replies: false, sessionNames: true, paths: 'relative' }, ...extra });

const cacheProposal = {
  title: 'Catch smaller cache rewrites',
  change: { setting: 'heuristics.cacheThrash.minTokens', value: 30000 },
  scope: 'global',
  what: 'The nudge also fires on rewrites of 30-50k tokens.',
  why: '9 of 14 rewrites were in that range.',
  prediction: { measure: 'cache_hit_rate', text: 'Back above 66%.', target: { direction: 'above', value: 66 } },
};
const contextProposal = { ...cacheProposal, title: 'Warn earlier on context', change: { setting: 'heuristics.contextPressure.percent', value: 80 }, scope: 'ws1' };
const ruleProposal = {
  ...cacheProposal,
  title: 'Editing and re-running tests',
  change: { rule: { id: 'advisor:edit-test-loop', title: 'Editing and re-running tests', scope: 'turn', measures: { edits: { type: 'count', filter: { kind: 'tool_call', toolCategory: 'file-edit' } } }, when: { all: [{ measure: 'edits', gte: 8 }] }, severity: 'info', summary: '{edits} edits', suggestedAction: 'Rethink.' } },
};
const answer = (proposals: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ summary: 'Cache hits fell.', verdicts: [{ experiment: 'x-1', result: 'too-early', text: '58% against 60%.' }], proposals, ...extra });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('what is sent: the goal, measures against the last report, settings by scope, experiments, discarded changes', () => {
    const [system, user] = performanceReportMessages(input());
    assert.ok(system.content.startsWith(purser.voice), 'the goal advisor\'s own voice leads');
    assert.match(system.content, /at most three/);
    const data = JSON.parse(user.content.slice(user.content.indexOf('{')));
    assert.deepStrictEqual(data.goal.measures, purser.measures);
    assert.deepStrictEqual(data.measures[0], { id: 'cache_hit_rate', label: 'Cache hit rate', unit: '%', better: 'higher', value: 61, lastReport: 68, trend: 'worse' });
    assert.deepStrictEqual(data.workspaces.map((w: { id: string; name?: string }) => [w.id, w.name]), [['ws1', 'snagboat']]);
    const ctx = data.settings.find((s: { setting: string }) => s.setting === 'heuristics.contextPressure.percent');
    assert.deepStrictEqual([ctx.global, ctx.byWorkspace], [90, { ws1: 85 }]);
    assert.strictEqual(data.runningExperiments[0].scope, 'ws1');
    assert.ok(!user.content.includes(WS), 'no folder paths');
    const hashed = performanceReportMessages(input({ policy: { prompts: false, replies: false, sessionNames: false, paths: 'hashed' } }))[1].content;
    assert.ok(!hashed.includes('snagboat"'), 'no workspace names when paths are hashed');
  });

  test('the answer is held to the contract: complete proposals, known settings and scopes, its own measures', () => {
    const ok = parseReportAnswer(answer([cacheProposal, contextProposal, ruleProposal]), input());
    assert.deepStrictEqual(ok.problems, []);
    assert.strictEqual(ok.summary, 'Cache hits fell.');
    assert.deepStrictEqual(ok.verdicts, [{ experiment: 'x-1', measure: 'cache_hit_rate', baseline: 60, now: 61, result: 'too-early', text: '58% against 60%.' }]);
    assert.deepStrictEqual(ok.proposals[0].change, { kind: 'setting', key: 'heuristics.cacheThrash.minTokens', before: 50000, after: 30000 });
    assert.deepStrictEqual([ok.proposals[1].scope, ok.proposals[1].change], [{ workspace: WS }, { kind: 'setting', key: 'heuristics.contextPressure.percent', before: 85, after: 80 }], "the before is the workspace's own value");
    assert.strictEqual(ok.proposals[2].change.kind, 'rule');

    const bad = parseReportAnswer(
      answer([
        { ...cacheProposal, title: 'One', why: '' },
        { ...cacheProposal, title: 'Two', change: { setting: 'heuristics.made.up', value: 3 } },
        { ...cacheProposal, title: 'Three', scope: 'ws9' },
        { ...cacheProposal, title: 'Four' },
      ], { verdicts: [{ experiment: 'x-404', result: 'met', text: 'x' }] }),
      input()
    );
    assert.deepStrictEqual(bad.proposals, [], 'the fourth is past the limit');
    for (const re of [/4 proposals; only the first 3/, /"One" was dropped: it needs a title, what it does and why/, /heuristics\.made\.up is not a setting/, /scope "ws9"/, /x-404, which is not a running experiment/]) assert.ok(bad.problems.some((p) => re.test(p)), `${re} in ${bad.problems.join(' | ')}`);
    assert.strictEqual(MAX_PROPOSALS, 3);

    const more = parseReportAnswer(
      answer([
        { ...cacheProposal, prediction: { measure: 'stall_minutes', text: 'x' } },
        { ...cacheProposal, change: { setting: 'heuristics.cacheThrash.minTokens', value: 50000 } },
        { ...ruleProposal, change: { rule: { ...ruleProposal.change.rule, id: 'mine' } } },
      ]),
      input()
    );
    assert.deepStrictEqual(more.proposals, []);
    for (const re of [/must name one of Purser's measures/, /already 50000/, /"advisor:"/]) assert.ok(more.problems.some((p) => re.test(p)), `${re} in ${more.problems.join(' | ')}`);
    assert.deepStrictEqual(parseReportAnswer('no json here', input()).problems, ['the answer was not a JSON object']);
  });

  test("may_change is enforced, and a discarded change is never proposed again", () => {
    const quiet = { ...purser, name: 'Quiet', mayChange: [] };
    const none = parseReportAnswer(answer([cacheProposal]), input({ advisor: quiet }));
    assert.deepStrictEqual(none.proposals, []);
    assert.match(none.problems[0], /Quiet may not change rules/);
    const discarded = parseReportAnswer(answer([cacheProposal]), input()).proposals.map((d) => ({ ...d, id: 'old', advisor: 'purser', report: '2026-W45', rev: 1, status: 'discarded' as const, proposedAt: '', updatedAt: '' }));
    const again = parseReportAnswer(answer([cacheProposal, { ...cacheProposal, change: { setting: 'heuristics.cacheThrash.minTokens', value: 40000 } }]), input({ discarded }));
    assert.deepStrictEqual(again.proposals.map((p) => p.change.kind === 'setting' && p.change.after), [40000], 'the same setting to another value is a different change');
    assert.match(again.problems[0], /you discarded that change before/);
  });

  test('the proposal log: append only, folded into proposals, each line valid against the schema', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-proposals-'));
    const store = new ProposalStore(home, () => new Date('2026-11-16T09:00:00Z'));
    const drafts = parseReportAnswer(answer([cacheProposal, contextProposal]), input()).proposals;
    const added = store.propose('purser', '2026-W46', 1, drafts);
    assert.deepStrictEqual(added.map((p) => [p.id, p.status]), [['2026-W46-r1-p1', 'open'], ['2026-W46-r1-p2', 'open']]);
    store.mark('purser', '2026-W46-r1-p1', 'accepted');
    store.mark('purser', '2026-W46-r1-p2', 'revised', { note: 'Try a session budget.' });
    store.mark('purser', '2026-W46-r1-p2', 'discarded');
    assert.deepStrictEqual(store.list('purser').map((p) => [p.id, p.status, p.note]), [['2026-W46-r1-p1', 'accepted', undefined], ['2026-W46-r1-p2', 'discarded', 'Try a session budget.']]);
    assert.deepStrictEqual(store.discarded('purser').map((p) => p.id), ['2026-W46-r1-p2']);
    assert.deepStrictEqual(store.forReport('purser', '2026-W46', 1).length, 2);
    assert.throws(() => store.mark('purser', 'nope', 'accepted'), /no proposal nope/);
    const lines = fs.readFileSync(path.join(home, 'advisors', 'purser', 'proposals.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 5, 'every mark is a new line');
    for (const l of lines) assert.ok(JSON.parse(l).version === 1);
    void proposalEventSchema;
  });

  test('end to end: a report is answered by the model its persona names, under the core\'s approval', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-perf-')));
    const w = path.join(home, 'w');
    fs.mkdirSync(w);
    await new StoreWriter(home).write([{ eventId: 'e1', sessionId: 's1', agent: 'claude-code', ts: new Date(2026, 10, 11, 10).toISOString(), kind: 'turn_stop', status: 'success', turnId: 't1', tokens: { input: 100, output: 0, cacheRead: 300, cacheCreation: 0 }, raw: { adapter: 'test', ref: 'r1' }, workspace: w }]);
    saveConfig(home, { version: 1, defaults: { 'advisor.providers': [{ id: 'local', label: 'Test model', baseUrl: 'http://127.0.0.1:9/v1', model: 'tiny' }] }, projects: {} });
    fs.mkdirSync(path.join(home, 'advisors', 'purser'), { recursive: true });
    fs.writeFileSync(path.join(home, 'advisors', 'purser', 'persona.md'), DEFAULT_PERSONAS.purser.replace('may_change: [rules]', 'may_change: [rules]\nmodel: local'));
    const sent: string[] = [];
    let reply = answer([cacheProposal, contextProposal]);
    const fetchImpl: FetchLike = async (_url, init) => {
      sent.push(init.body ?? '');
      const body = { choices: [{ message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const models = new CoreAdvisors(home, fetchImpl);
    writeApprovals(home, { local: approvalKey(models.advisors()[0]) });
    const now = () => new Date(2026, 10, 18, 10);
    const reports = new AdvisorReports(new PeriodJob(home, now), new ProposalStore(home, now), models, () => [], now);
    const written = await reports.job.runDue();
    for (const r of written) {
      const rev = await reports.answer(r.advisor, r.id);
      assert.deepStrictEqual(rev, r.advisor === 'purser' ? reports.job.get('purser')!.revisions![0] : undefined, `${r.advisor}: only an advisor with a model is asked`);
    }
    assert.strictEqual(sent.length, 1);
    const view = reports.view('purser')!;
    assert.deepStrictEqual(view.report.revisions!.map((r) => [r.rev, r.summary, r.model]), [[1, 'Cache hits fell.', { advisor: 'local', model: 'tiny' }]]);
    assert.deepStrictEqual(view.report.revisions![0].verdicts, [], 'no running experiments, so the verdict is dropped');
    assert.deepStrictEqual(view.proposals.map((p) => p.title), ['Catch smaller cache rewrites', 'Warn earlier on context']);
    assert.deepStrictEqual(view.proposals[1].scope, { workspace: w });
    const frozen = JSON.parse(JSON.stringify(written.find((r) => r.advisor === 'purser')));
    assert.deepStrictEqual({ ...view.report, revisions: undefined }, { ...frozen, revisions: undefined }, 'the measures and rules are untouched');
    assert.strictEqual(reports.view('navigator')!.proposals.length, 0, 'no model: numbers only');

    // Discard one; the next report's model call is told, and a repeat of it is dropped.
    reports.proposals.mark('purser', view.proposals[1].id, 'discarded');
    reports.proposals.mark('purser', view.proposals[0].id, 'accepted');
    reply = answer([contextProposal]);
    const next = await reports.job.request('purser');
    await reports.answer('purser', next.id);
    const data = JSON.parse(JSON.parse(sent[1]).messages[1].content.replace(/^[^{]*/, ''));
    assert.deepStrictEqual(data.lastRound.map((p: { title: string; status: string }) => [p.title, p.status]), [['Catch smaller cache rewrites', 'accepted'], ['Warn earlier on context', 'discarded']]);
    assert.strictEqual(data.discarded.length, 1);
    assert.deepStrictEqual(reports.view('purser')!.proposals, [], 'the discarded change was not proposed again');
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
