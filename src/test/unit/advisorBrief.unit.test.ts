import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beadsAhead } from '../../advisor/ahead';
import { advisorBrief } from '../../advisor/brief';
import { MeasureResult } from '../../advisor/measures';
import { AdvisorReport } from '../../advisor/report';
import { Finding } from '../../heuristics/types';

// The brief on each advisor's card (RFC step 5a, as revised in the design pass): summary,
// what it's watching, what it has to surface; and Navigator's "Ahead" from Beads, read only.

const m = (id: string, label: string, value: number | undefined, previous: number | undefined, trend?: MeasureResult['trend'], unit = '', better: 'lower' | 'higher' = 'lower'): MeasureResult => ({
  id, label, unit, better, ...(value !== undefined ? { value } : {}), ...(previous !== undefined ? { previous } : {}), ...(trend ? { trend } : {}),
});
const report = (measures: MeasureResult[], notify: AdvisorReport['notify']): AdvisorReport => ({
  id: 'purser', name: 'Purser', goal: 'token-cost-down', status: 'Keeping token cost down', voice: '', version: 'v', source: 'built-in', notify, measures, problems: [],
});
const finding = (heuristicId: string, severity: 'info' | 'warn' = 'info'): Finding => ({ heuristicId, severity, summary: `${heuristicId} fired`, eventRefs: [], detectedAt: '2026-11-11T00:00:00Z' });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the summary leads with the overall direction and names the biggest changes', () => {
    const r = report([m('a', 'Tokens per milestone', 1.9e6, 2.3e6, 'better', 'tokens'), m('b', 'Cache hit rate', 98.5, 97.3, 'better', '%', 'higher'), m('c', 'Stall', 10, 10, 'same', 'min')], { rules: [] });
    const b = advisorBrief(r, [], new Set());
    assert.match(b.summary, /^Improving: /);
    assert.match(b.summary, /tokens per milestone down 17% to 1,900,000 tokens/);
    assert.strictEqual(b.watching, undefined, 'nothing going the wrong way');
    assert.deepStrictEqual(b.surface, { kind: 'none', label: 'Nothing new', text: '' });
    assert.strictEqual(advisorBrief(report([m('x', 'X', undefined, undefined)], { rules: [] }), [], new Set()).summary, 'Nothing to measure yet in this period.');
  });

  test('what it surfaces: its finding (notified, held back by its limit, or active); else a measure going the wrong way; else nothing', () => {
    const worse = [m('r', 'Risky commands', 10, 6, 'worse')];
    const limit = { rules: ['cache-thrash', 'token-budget'], maxPerHour: 2, lastHour: 2 };
    assert.strictEqual(advisorBrief(report(worse, limit), [finding('cache-thrash')], new Set()).surface.kind, 'held', 'over its limit, not notified');
    assert.strictEqual(advisorBrief(report(worse, limit), [finding('cache-thrash')], new Set(['cache-thrash'])).surface.kind, 'notified');
    const active = advisorBrief(report(worse, { ...limit, lastHour: 0 }), [finding('cache-thrash'), finding('token-budget', 'warn'), finding('stalled', 'warn')], new Set());
    assert.deepStrictEqual([active.surface.kind, active.surface.finding?.heuristicId], ['active', 'token-budget'], "its own, warnings first; not another advisor's");
    const suggest = advisorBrief(report(worse, limit), [finding('stalled')], new Set());
    assert.deepStrictEqual([suggest.surface.kind, suggest.surface.text], ['suggest', 'Risky commands is going the wrong way with no finding yet.']);
    assert.match(suggest.watching!, /^Risky commands: up 67% to 10\.$/);
  });

  test("Navigator watches a blocked bead first", () => {
    const ahead = { source: 'beads' as const, inProgress: [], next: { id: 'b-2', title: 'next' }, blocked: 1, firstBlocked: { id: 'b-3', title: 'serve it', blockedBy: ['b-1'] }, closedThisWeek: 4 };
    const b = advisorBrief(report([m('s', 'Stalled minutes', 85, 55, 'worse', 'min')], { rules: [] }), [], new Set(), ahead);
    assert.strictEqual(b.watching, 'b-3 "serve it" is blocked on b-1, so nothing behind it can start; then stalled minutes up 55% to 85 min.');
    assert.strictEqual(b.ahead, ahead);
  });

  test('Ahead comes from Beads, read only and sandboxed, and is left out without them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-ahead-'));
    const calls: string[][] = [];
    const now = Date.parse('2026-11-11T12:00:00Z');
    const bd = async (args: string[]) => {
      calls.push(args);
      const json = (v: unknown) => JSON.stringify(v);
      if (args[0] === 'ready') return json([{ id: 'e', title: 'epic', issue_type: 'epic', priority: 0 }, { id: 't2', title: 'later', issue_type: 'task', priority: 3 }, { id: 't1', title: 'first', issue_type: 'task', priority: 1 }]);
      if (args[0] === 'blocked') return json([{ id: 'b1', title: 'waits', blocked_by: ['t1'] }]);
      if (args[1] === '--status=in_progress') return json([{ id: 'w1', title: 'doing', issue_type: 'task' }]);
      return json([{ id: 'c1', title: 'done', closed_at: '2026-11-10T00:00:00Z' }, { id: 'c0', title: 'old', closed_at: '2026-10-01T00:00:00Z' }]);
    };
    assert.strictEqual(await beadsAhead(dir, now, bd), undefined, 'no .beads folder: nothing, and bd never runs');
    assert.strictEqual(calls.length, 0);
    fs.mkdirSync(path.join(dir, '.beads'));
    assert.deepStrictEqual(await beadsAhead(dir, now, bd), {
      source: 'beads', inProgress: [{ id: 'w1', title: 'doing' }], next: { id: 't1', title: 'first' }, blocked: 1, firstBlocked: { id: 'b1', title: 'waits', blockedBy: ['t1'] }, closedThisWeek: 1,
    });
    assert.strictEqual(await beadsAhead(dir, now, async () => 'not json'), undefined, 'bd failing: left out');
    // The real runner always passes --readonly --sandbox.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'advisor', 'ahead.ts'), 'utf8');
    assert.match(src, /execFile\('bd', \['--readonly', '--sandbox', \.\.\.args\]/);
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
