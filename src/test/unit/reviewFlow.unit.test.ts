import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Experiment, Proposal } from '@snagboat/schema';
import { approvalKey } from '../../advisor/advisors';
import { DEFAULT_PERSONAS } from '../../advisor/goals';
import { FetchLike } from '../../advisor/providers';
import { writeApprovals } from '../../core/advisorApprovals';
import { configHost, loadConfig, saveConfig } from '../../core/config';
import { CoreAdvisors } from '../../core/service/advisorModels';
import { ReportView } from '../../core/service/advisorReports';
import { AdvisorReport, isReviewSummary, ReviewSummary } from '../../advisor/report';
import { CoreClient } from '../../core/service/client';
import { waitingText } from '../../ui/format';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// Accept, discard and revise in the core (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.7): the
// design's W46 flow over HTTP against a stub model. Mark each proposal, switch until you send; Revise
// report gets a revision that keeps what you accepted and answers your note; Accept report closes it.

const base = { scope: 'global', what: 'What it does.', why: 'Why, with numbers.' };
const cache = { ...base, title: 'Catch smaller cache rewrites', change: { setting: 'heuristics.cacheThrash.minTokens', value: 30000 }, prediction: { measure: 'cache_hit_rate', text: 'Back above 66%.' } };
const context = { ...base, title: 'Warn earlier on context', change: { setting: 'heuristics.contextPressure.percent', value: 80 }, scope: 'ws1', prediction: { measure: 'tokens_per_milestone', text: 'Below 41.2k.' } };
const stalls = { ...base, title: 'Flag stalls sooner', change: { setting: 'heuristics.stalled.minutes', value: 6 }, prediction: { measure: 'cache_hit_rate', text: 'x' } };
const budget = { ...base, title: "Cap a session's spend", change: { setting: 'tokenBudget.session', value: 600000 }, scope: 'ws1', prediction: { measure: 'tokens_per_milestone', text: 'Below 41.2k.' } };

async function main() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-review-')));
  const w = path.join(home, 'snagboat');
  fs.mkdirSync(w);
  await new StoreWriter(home).write([{ eventId: 'e1', sessionId: 's1', agent: 'claude-code', ts: new Date(2026, 10, 11, 10).toISOString(), kind: 'turn_stop', status: 'success', turnId: 't1', tokens: { input: 100, output: 0, cacheRead: 300, cacheCreation: 0 }, raw: { adapter: 'test', ref: 'r1' }, workspace: w }]);
  saveConfig(home, { version: 1, defaults: { 'advisor.providers': [{ id: 'local', label: 'Test model', baseUrl: 'http://127.0.0.1:9/v1', model: 'tiny' }] }, projects: {} });
  fs.mkdirSync(path.join(home, 'advisors', 'purser'), { recursive: true });
  fs.writeFileSync(path.join(home, 'advisors', 'purser', 'persona.md'), DEFAULT_PERSONAS.purser.replace('may_change: [rules]', 'may_change: [rules]\nmodel: local'));
  const sent: Array<Record<string, unknown>> = [];
  // First answer: three proposals. A revision (reviseNotes in the data): the budget in place of context, and
  // the discarded stalls change again, which the core drops.
  const fetchImpl: FetchLike = async (_url, init) => {
    const data = JSON.parse(String(JSON.parse(init.body!).messages[1].content).replace(/^[^{]*/, '')) as Record<string, unknown>;
    sent.push(data);
    const notes = data.reviseNotes as Array<{ proposal: string }> | undefined;
    const answer = notes
      ? { summary: '', verdicts: [], proposals: [{ ...budget, replaces: notes[0].proposal }, stalls, cache] }
      : { summary: 'Cache hits fell 7 points.', verdicts: [], proposals: [cache, context, stalls] };
    const body = { choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  writeApprovals(home, { local: approvalKey(new CoreAdvisors(home).advisors()[0]) });
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false, periodEveryMs: 0, fetchImpl, now: () => new Date(2026, 10, 11, 12) });
  const info = readCoreFile(home)!;
  const call = (method: string, p: string, body?: unknown) => coreRequest(info.port, info.token, method, p, body);
  const view = async () => (await call('GET', '/advisors/purser/report')).body as ReportView;
  const until = async (ok: (v: ReportView) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      const v = await view();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never: ${what}`);
  };
  const mark = (id: string, m: string, note?: string) => call('POST', `/proposals/${encodeURIComponent(id)}`, { mark: m, ...(note !== undefined ? { note } : {}) });
  const statuses = (ps: Proposal[]) => ps.map((p) => [p.title, p.status]);

  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a report you ask for is answered, and its proposals wait for your marks', async () => {
    assert.strictEqual((await call('POST', '/advisors/purser/report')).status, 201);
    const v = await until((x) => x.review.rev === 1, 'the first revision');
    assert.deepStrictEqual(statuses(v.proposals), [['Catch smaller cache rewrites', 'open'], ['Warn earlier on context', 'open'], ['Flag stalls sooner', 'open']]);
    assert.deepStrictEqual(v.review, { rev: 1, state: 'open', marked: 0, unmarked: 3, toRevise: 0 });
    assert.strictEqual((await call('POST', '/advisors/purser/report/1?id=' + v.report.id)).status, 400, 'every proposal must be marked first');
  });

  test("the advisors' cards show the review: proposals waiting, the model, the period", async () => {
    const res = (await call('GET', `/advisors?workspace=${encodeURIComponent(w)}`)).body as { advisors: AdvisorReport[] };
    const purser = res.advisors.find((a) => a.id === 'purser')!;
    const review = purser.review as ReviewSummary;
    assert.deepStrictEqual([purser.model, purser.period, review.unmarked, review.state], ['local', 'weekly', 3, 'open']);
    assert.deepStrictEqual(purser.brief!.surface.text, `3 proposals waiting in the ${review.label} report.`);
    assert.strictEqual((res.advisors.find((a) => a.id === 'navigator')!.review as ReviewSummary).state, 'numbers-only');
  });

  test('a workspace token sees only how many proposals wait, never the report', async () => {
    const minted = await call('POST', '/tokens', { workspaces: [w] });
    const token = (minted.body as { token: string }).token;
    const own = (await coreRequest(info.port, token, 'GET', `/advisors?workspace=${encodeURIComponent(w)}&days=1`)).body as { advisors: AdvisorReport[] };
    assert.deepStrictEqual(own.advisors.find((a) => a.id === 'purser')!.review, { unmarked: 3 }, 'the count, nothing else');
    assert.ok(!isReviewSummary(own.advisors.find((a) => a.id === 'purser')!.review));
    assert.strictEqual(own.advisors.find((a) => a.id === 'navigator')!.review, undefined, 'none waiting: no field');
    assert.ok(!JSON.stringify(own).includes('Catch smaller cache rewrites'), 'no proposal content');
    assert.ok(!/proposals? waiting in the/.test(JSON.stringify(own)), "the brief doesn't name the report");
    assert.strictEqual((await coreRequest(info.port, token, 'GET', '/advisors/purser/report')).status, 403, 'the report itself stays closed');
    // The window's client reads the same counts for the findings view and status bar.
    const client = await CoreClient.connect({ home, cliPath: '', workspace: w, ensure: async () => info, find: async () => info });
    try {
      const waiting = await client.waitingProposals();
      assert.deepStrictEqual(waiting, [{ advisor: 'purser', name: 'Purser', waiting: 3 }]);
      assert.strictEqual(waitingText(waiting[0]), 'Purser: 3 proposals waiting');
      assert.strictEqual(waitingText({ ...waiting[0], waiting: 1 }), 'Purser: 1 proposal waiting');
    } finally {
      client.close();
    }
  });

  test('marks are checked and switchable until you send; Revise needs a note', async () => {
    const [p1, p2, p3] = (await view()).proposals.map((p) => p.id);
    assert.ok(p1.startsWith('purser-'), 'proposal ids name their advisor');
    assert.strictEqual((await mark(p1, 'discard')).status, 200);
    assert.strictEqual((await mark(p1, 'accept')).status, 200, 'switched');
    assert.strictEqual((await mark(p2, 'revise')).status, 400);
    assert.strictEqual((await mark(p2, 'revise', 'The RFC sessions need long context. Try a session budget.')).status, 200);
    assert.strictEqual((await mark(p3, 'discard')).status, 200);
    assert.strictEqual((await mark(p3, 'maybe')).status, 400);
    assert.strictEqual((await mark('purser-nope', 'accept')).status, 404);
    const v = await view();
    assert.deepStrictEqual(statuses(v.proposals), [['Catch smaller cache rewrites', 'accepted'], ['Warn earlier on context', 'revised'], ['Flag stalls sooner', 'discarded']]);
    assert.deepStrictEqual(v.review, { rev: 1, state: 'open', marked: 3, unmarked: 0, toRevise: 1, send: 'revise' });
    const minted = await call('POST', '/tokens', { workspaces: [w] });
    const token = (minted.body as { token: string }).token;
    assert.strictEqual((await coreRequest(info.port, token, 'POST', `/proposals/${p1}`, { mark: 'discard' })).status, 403, 'a workspace token cannot mark');
  });

  test('Revise report: the next revision keeps what you accepted, answers the note, and drops the discarded change', async () => {
    const before = await view();
    const res = await call('POST', `/advisors/purser/report/1`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((res.body as { sent: string }).sent, 'revise');
    assert.strictEqual((await mark(before.proposals[0].id, 'discard')).status, 409, 'a sent revision is closed to marks');
    const v = await until((x) => x.review.rev === 2, 'the second revision');
    const asked = sent[sent.length - 1];
    assert.deepStrictEqual((asked.reviseNotes as Array<{ note: string }>).map((n) => n.note), ['The RFC sessions need long context. Try a session budget.']);
    assert.deepStrictEqual((asked.acceptedAndKept as Array<{ title: string }>).map((p) => p.title), ['Catch smaller cache rewrites']);
    assert.deepStrictEqual(statuses(v.proposals), [['Catch smaller cache rewrites', 'accepted'], ["Cap a session's spend", 'open']], 'the discarded stalls change and the repeat of the accepted one are dropped');
    assert.strictEqual(v.proposals[0].id, before.proposals[0].id, 'the accepted proposal carries over as itself');
    assert.strictEqual(v.proposals[1].replaces, before.proposals[1].id);
    assert.deepStrictEqual(v.replaced.map((p) => [p.id, p.note]), [[before.proposals[1].id, 'The RFC sessions need long context. Try a session budget.']], 'the page shows what each revised proposal replaced, with your note');
    assert.strictEqual(v.report.revisions![1].summary, 'Cache hits fell 7 points.', 'a revision keeps the summary when the model gives none');
    assert.deepStrictEqual(v.report.revisions![0].sent?.as, 'revise');
    assert.strictEqual((await mark(v.proposals[0].id, 'discard')).status, 409, 'a carried-over accepted proposal stays accepted');
  });

  test('Accept report closes the review', async () => {
    const v = await view();
    assert.strictEqual((await mark(v.proposals[1].id, 'accept')).status, 200);
    assert.strictEqual((await view()).review.send, 'accept');
    assert.strictEqual((await call('POST', '/advisors/purser/report/1')).status, 409, 'only the latest revision is sent');
    const res = await call('POST', '/advisors/purser/report/2');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const done = res.body as ReportView & { sent: string };
    assert.deepStrictEqual([done.sent, done.review.state, statuses(done.proposals)], ['accept', 'accepted', [['Catch smaller cache rewrites', 'accepted'], ["Cap a session's spend", 'accepted']]]);
    assert.strictEqual((await call('POST', '/advisors/purser/report/2')).status, 409, 'already accepted');
    const numbersOnly = await call('POST', '/advisors/navigator/report/1');
    assert.deepStrictEqual([numbersOnly.status, (numbersOnly.body as { error: string }).error], [409, 'this report has the numbers only; there is nothing to send'], 'navigator has no model');
    assert.strictEqual((await call('POST', '/advisors/nobody/report/1')).status, 404);
  });

  test('Accept report starts an experiment per accepted proposal, changing exactly those settings; revert puts them back', async () => {
    const list = (await call('GET', '/experiments')).body as { experiments: Experiment[]; now: Record<string, { report: string; label?: string; better?: string }> };
    assert.deepStrictEqual(Object.values(list.now).map((n) => [n.label, n.better]).sort(), [['Cache hit rate', 'higher'], ['Tokens per milestone', 'lower']], 'the page colours now against the baseline');
    assert.deepStrictEqual(list.experiments.map((x) => [x.title, x.status]).sort(), [['Cap a session\'s spend', 'running'], ['Catch smaller cache rewrites', 'running']]);
    const { config } = loadConfig(home);
    assert.strictEqual(config.defaults['heuristics.cacheThrash.minTokens'], 30000);
    assert.deepStrictEqual(config.projects[w], { 'tokenBudget.session': 600000 });
    assert.strictEqual(configHost(home, w).get('snagboat.heuristics.cacheThrash', 'minTokens', 50000), 30000, 'what the running heuristics read');
    assert.strictEqual(((await call('GET', '/experiments?advisor=navigator')).body as { experiments: unknown[] }).experiments.length, 0);
    assert.strictEqual((await call('GET', '/experiments?status=maybe')).status, 400);
    const budget = list.experiments.find((x) => x.change.kind === 'setting' && x.change.key === 'tokenBudget.session')!;
    const reverted = await call('POST', `/experiments/${budget.id}`, { action: 'revert' });
    assert.deepStrictEqual([reverted.status, (reverted.body as { experiment: Experiment }).experiment.ended?.how], [200, 'reverted']);
    assert.deepStrictEqual(loadConfig(home).config.projects[w], {});
    assert.strictEqual((await call('POST', `/experiments/${budget.id}`, { action: 'revert' })).status, 409);
    assert.strictEqual((await call('POST', '/experiments/nope', { action: 'revert' })).status, 404);
    const cacheX = list.experiments.find((x) => x.id !== budget.id)!;
    const kept = (await call('POST', `/experiments/${cacheX.id}`, { action: 'keep' })).body as { experiment: Experiment };
    assert.deepStrictEqual([kept.experiment.keptGoing, kept.experiment.reviewAt > cacheX.reviewAt], [1, true]);
    assert.strictEqual((await view()).proposals.find((p) => p.id === cacheX.proposal)!.status, 'kept', 'the proposal log records it');
    assert.strictEqual((await call('POST', `/experiments/${cacheX.id}`, { action: 'maybe' })).status, 400);
    const minted = await call('POST', '/tokens', { workspaces: [w] });
    assert.strictEqual((await coreRequest(info.port, (minted.body as { token: string }).token, 'GET', '/experiments')).status, 403);
  });

  let failures = 0;
  try {
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
  } finally {
    await core.stop();
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
