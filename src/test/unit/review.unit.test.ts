import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplayEpisode } from '../../heuristics/replay';
import { episodeResponse, ResponseEpisode, ResponseLog, ResponseTracker, responseStats } from '../../heuristics/responses';
import { Finding } from '../../heuristics/types';
import { momentsFrom, presentationChecks, snapshotAt } from '../../review/presentation';

const at = (min: number) => new Date(Date.UTC(2026, 0, 5, 0, 0) + min * 60_000).toISOString();
const finding = (heuristicId: string, severity: 'info' | 'warn' = 'info'): Finding => ({ heuristicId, severity, summary: `/secret/path.ts in ${heuristicId}`, eventRefs: [], detectedAt: at(0) });
const episode = (heuristicId: string, severity: 'info' | 'warn', start: number, end: number): ReplayEpisode => ({ heuristicId, severity, summary: '/secret/path.ts', startTs: at(start), endTs: at(end), eventRefs: [], open: false });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('marking a finding useful acknowledges it; an ended episode comes with its findings\' events, and says how it was met', () => {
    const written: Array<[ResponseEpisode, string[]]> = [];
    let t = 0;
    const tracker = new ResponseTracker((e, refs) => written.push([e, refs]), () => at(t));
    tracker.useful('stalled'); // nothing active: no-op
    tracker.reported('stalled', [{ ...finding('stalled'), eventRefs: ['e1', 'e2'] }]);
    t = 2;
    tracker.useful('stalled');
    t = 4;
    tracker.reported('stalled', []);
    assert.deepStrictEqual(written, [[{ heuristicId: 'stalled', severity: 'info', startedAt: at(0), usefulAt: at(2), acknowledgedAt: at(2), endedAt: at(4) }, ['e1', 'e2']]]);
    assert.strictEqual(episodeResponse(written[0][0]), 'useful');
    const base = { heuristicId: 'h', severity: 'info' as const, startedAt: at(0) };
    assert.deepStrictEqual(
      [{ ...base, mutedAt: at(1), acknowledgedAt: at(1) }, { ...base, acknowledgedAt: at(1) }, base].map(episodeResponse),
      ['muted', 'acknowledged', 'passed']
    );
    assert.strictEqual(responseStats(written.map(([e]) => e)).get('stalled')!.useful, 1);
  });

  test('each episode is recorded when it ends, with when it was acknowledged or muted', () => {
    const written: ResponseEpisode[] = [];
    let t = 0;
    const tracker = new ResponseTracker((e) => written.push(e), () => at(t));
    tracker.reported('stalled', [finding('stalled', 'info')]);
    t = 1;
    tracker.reported('stalled', [finding('stalled', 'warn')]);
    t = 3;
    tracker.acknowledged('stalled');
    t = 5;
    tracker.reported('stalled', []);
    tracker.reported('tool-churn', [finding('tool-churn')]);
    t = 6;
    tracker.muted('tool-churn', true);
    tracker.reported('backtracking', [finding('backtracking')]);
    t = 8;
    tracker.reported('backtracking', []);
    assert.deepStrictEqual(written, [
      { heuristicId: 'stalled', severity: 'warn', startedAt: at(0), acknowledgedAt: at(3), endedAt: at(5) },
      { heuristicId: 'backtracking', severity: 'info', startedAt: at(6), endedAt: at(8) },
    ]);
    assert.deepStrictEqual(tracker.drain(), [{ heuristicId: 'tool-churn', severity: 'info', startedAt: at(5), mutedAt: at(6) }]);
    const stats = responseStats([...written, { heuristicId: 'tool-churn', severity: 'info', startedAt: at(5), mutedAt: at(6) }]);
    assert.deepStrictEqual(stats.get('stalled'), { episodes: 1, warnings: 1, acknowledged: 1, useful: 0, expiredUnacknowledged: 0, muted: 0, medianMinutesToAcknowledge: 3 });
    assert.deepStrictEqual([stats.get('backtracking')!.expiredUnacknowledged, stats.get('tool-churn')!.muted], [1, 1]);
  });

  test('the response log keeps episodes for retention, survives a torn line, and clears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-responses-'));
    try {
      const log = new ResponseLog(dir);
      log.append({ heuristicId: 'a', severity: 'info', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' });
      log.appendNow([]);
      await log.readAll();
      fs.appendFileSync(log.file, '{"heuristicId":"torn"\n');
      log.appendNow([{ heuristicId: 'b', severity: 'warn', startedAt: '2026-03-01T00:00:00.000Z' }]);
      assert.deepStrictEqual((await log.readAll()).map((e) => e.heuristicId), ['a', 'b']);
      await log.prune(30, '2026-03-10T00:00:00.000Z');
      assert.deepStrictEqual((await log.readAll()).map((e) => e.heuristicId), ['b']);
      await log.clear();
      assert.deepStrictEqual(await log.readAll(), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('moments are where a warning or several findings were active, one per distinct set, muted ones left out', () => {
    const eps = [episode('stalled', 'info', 0, 10), episode('backtracking', 'warn', 5, 8), episode('tool-churn', 'info', 20, 25), episode('verbal-hedge', 'info', 30, 40), episode('stalled', 'info', 35, 38)];
    const moments = momentsFrom(eps);
    assert.deepStrictEqual(moments.map((m) => [m.at, m.active.map((a) => a.heuristicId)]), [
      [at(35), ['verbal-hedge', 'stalled']],
      [at(5), ['stalled', 'backtracking']],
    ]);
    assert.deepStrictEqual(momentsFrom(eps, new Set(['stalled'])).map((m) => m.at), [at(5)]);
  });

  test('snapshots use the status bar\'s own code, with summaries replaced by heuristic ids', () => {
    const snap = snapshotAt({ at: at(5), active: [{ heuristicId: 'stalled', severity: 'info' }, { heuristicId: 'backtracking', severity: 'warn' }] });
    assert.ok(snap.statusBar.endsWith('· «backtracking»'), snap.statusBar);
    assert.ok(snap.statusBar.startsWith('$(history)'), 'the warning\'s glyph');
    assert.deepStrictEqual(snap.tooltip, ['[info] stalled: «stalled»', '[warn] backtracking: «backtracking»']);
  });

  test('the fixed checks find a late warning, a hidden count, and warnings with no notification', () => {
    const moments = momentsFrom([episode('stalled', 'info', 0, 10), episode('backtracking', 'warn', 5, 8)]);
    const stats = responseStats([{ heuristicId: 'backtracking', severity: 'warn', startedAt: at(5), endedAt: at(8) }]);
    const checks = presentationChecks(moments, stats);
    assert.deepStrictEqual(checks.map((c) => [c.id, c.moments]), [['warning-not-first', 1], ['count-hidden', 1], ['no-notification', 1]]);
    assert.ok(checks[2].recommendation.includes('1 of 1 episodes'));
    assert.deepStrictEqual(presentationChecks([], stats), []);
    assert.deepStrictEqual(presentationChecks(moments, stats, true).map((c) => c.id), ['warning-not-first', 'count-hidden'], 'with notifications on, nothing to recommend there');
    assert.ok(checks[2].recommendation.startsWith('Setting: set snagboat.nudges.notify'));
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
