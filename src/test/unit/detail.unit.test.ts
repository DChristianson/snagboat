import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Aggregate } from '../../core/aggregate';
import { DailyHistory } from '../../core/dailyHistory';
import { EventLog } from '../../core/eventLog';
import { AggregateStore, summarizeDay } from '../../core/retention';
import { NormalizedEvent } from '../../core/types';
import { FindingsRegistry } from '../../heuristics/findingsRegistry';
import { Finding } from '../../heuristics/types';
import { buildDetailState, isDetailMessage, resolveTargetFile, TIMELINE_LIMIT } from '../../ui/detailModel';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: `evt-${Math.random()}`,
    sessionId: 'session-1',
    agent: 'claude-code',
    ts: '2026-01-01T12:00:00.000Z',
    kind: 'turn_stop',
    status: 'unknown',
    tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 2 },
    raw: { adapter: 'unit-test', ref: 'n/a' },
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    heuristicId: 'stalled',
    severity: 'warn',
    summary: 'No activity for 20 minutes',
    eventRefs: [],
    detectedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('acknowledging a heuristic drops it from worst() but keeps it listed and visible', () => {
    const registry = new FindingsRegistry();
    registry.report('stalled', [makeFinding()]);
    registry.report('tool-churn', [makeFinding({ heuristicId: 'tool-churn', severity: 'info' })]);

    registry.acknowledge('stalled');

    assert.strictEqual(registry.worst()?.heuristicId, 'tool-churn');
    assert.strictEqual(registry.list().length, 2);
    assert.strictEqual(registry.visible().length, 2);
    assert.deepStrictEqual(registry.views().find((v) => v.finding.heuristicId === 'stalled')?.acknowledged, true);
  });

  test('an acknowledgement lasts until the heuristic clears, then a new occurrence resurfaces', () => {
    const registry = new FindingsRegistry();
    registry.report('stalled', [makeFinding({ summary: 'No activity for 20 minutes' })]);
    registry.acknowledge('stalled');
    registry.report('stalled', [makeFinding({ summary: 'No activity for 25 minutes' })]);
    assert.strictEqual(registry.worst(), undefined, 'still the same episode, still acknowledged');

    registry.report('stalled', []);
    registry.report('stalled', [makeFinding()]);
    assert.strictEqual(registry.worst()?.heuristicId, 'stalled', 'new episode is not acknowledged');
  });

  test('acknowledging a heuristic with nothing active is a no-op and does not notify', () => {
    const registry = new FindingsRegistry();
    let notified = 0;
    registry.onChange(() => notified++);
    registry.acknowledge('stalled');
    assert.strictEqual(notified, 0);
    registry.report('stalled', [makeFinding()]);
    assert.strictEqual(registry.worst()?.heuristicId, 'stalled', 'a pre-emptive acknowledge must not stick');
  });

  test('muting hides findings from visible() and worst(), persists across clears, and notifies once per change', () => {
    const registry = new FindingsRegistry(['tool-churn']);
    let notified = 0;
    registry.onChange(() => notified++);
    registry.report('tool-churn', [makeFinding({ heuristicId: 'tool-churn' })]);
    notified = 0;

    assert.strictEqual(registry.worst(), undefined);
    assert.deepStrictEqual(registry.visible(), []);
    assert.strictEqual(registry.list().length, 1, 'muted findings are still tracked');

    registry.setMuted('tool-churn', true);
    assert.strictEqual(notified, 0, 'already muted');
    registry.setMuted('tool-churn', false);
    assert.strictEqual(notified, 1);
    assert.strictEqual(registry.worst()?.heuristicId, 'tool-churn');
    assert.deepStrictEqual(registry.mutedHeuristics(), []);
  });

  test('DailyHistory sums tokens per UTC day per agent and omits token-free days', () => {
    const history = new DailyHistory();
    history.apply(makeEvent({ ts: '2026-01-01T23:59:00.000Z' }));
    history.apply(makeEvent({ ts: '2026-01-01T01:00:00.000Z', agent: 'copilot', tokens: { input: 3 } }));
    history.apply(makeEvent({ ts: '2026-01-02T00:01:00.000Z' }));
    history.apply(makeEvent({ ts: '2026-01-03T10:00:00.000Z', agent: 'generic-fs', kind: 'edit', tokens: undefined }));

    assert.deepStrictEqual(history.tokensByDay(), [
      { date: '2026-01-01', perAgent: { 'claude-code': 37, copilot: 3 } },
      { date: '2026-01-02', perAgent: { 'claude-code': 37 } },
    ]);
  });

  test('DailyHistory rehydrates from aggregates plus raw days, raw winning on overlap, and removeDay drops a day', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snagboat-history-'));
    const log = new EventLog(dir);
    await log.init();
    const store = new AggregateStore(dir);
    await store.init();
    await store.write(summarizeDay('2025-12-01', [makeEvent({ ts: '2025-12-01T00:00:00.000Z' })]));
    await store.write(summarizeDay('2026-01-01', [makeEvent(), makeEvent()])); // shadowed by the raw file below
    await fs.promises.writeFile(path.join(dir, 'events', '2026-01-01.jsonl'), JSON.stringify(makeEvent()) + '\n');

    const history = new DailyHistory();
    await history.rehydrateFrom(log, store);
    assert.deepStrictEqual(history.tokensByDay(), [
      { date: '2025-12-01', perAgent: { 'claude-code': 37 } },
      { date: '2026-01-01', perAgent: { 'claude-code': 37 } },
    ]);

    history.removeDay('2025-12-01');
    assert.deepStrictEqual(history.tokensByDay().map((d) => d.date), ['2026-01-01']);
  });

  test('buildDetailState orders the timeline newest first, caps it, and flags openable targets', () => {
    const events = Array.from({ length: TIMELINE_LIMIT + 1 }, (_, i) =>
      makeEvent({ eventId: `e${i}`, ts: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), target: i % 2 ? '/repo/a.ts' : 'npm test' })
    );
    const today = new Aggregate();
    today.apply(makeEvent());
    today.apply(makeEvent({ agent: 'generic-fs', kind: 'edit', tokens: undefined }));
    const registry = new FindingsRegistry(['tool-churn']);
    registry.report('stalled', [makeFinding()]);
    registry.report('tool-churn', [makeFinding({ heuristicId: 'tool-churn', eventRefs: ['e1'] })]);
    registry.acknowledge('stalled');

    const state = buildDetailState({
      now: '2026-01-01T12:00:00.000Z',
      capture: { enabled: false, retentionDays: 90 },
      today: today.snapshot(),
      recentEvents: events,
      findings: registry.views(),
      muted: registry.mutedHeuristics(),
      daily: [],
      isOpenable: (t) => t === '/repo/a.ts',
    });

    assert.deepStrictEqual(state.today, { tokens: 37, events: 1, edits: 1 });
    assert.strictEqual(state.timeline.events.length, TIMELINE_LIMIT);
    assert.strictEqual(state.timeline.truncated, true);
    assert.strictEqual(state.timeline.events[0].id, `e${TIMELINE_LIMIT}`, 'newest first');
    assert.strictEqual(state.timeline.events[0].tokens, 37);
    assert.strictEqual(state.timeline.events.find((e) => e.target === '/repo/a.ts')?.openable, true);
    assert.strictEqual(state.timeline.events.find((e) => e.target === 'npm test')?.openable, false);
    assert.deepStrictEqual(
      state.findings.map((f) => [f.heuristicId, f.acknowledged, f.muted]),
      [['stalled', true, false], ['tool-churn', false, true]]
    );
    assert.deepStrictEqual(state.muted, ['tool-churn']);
  });

  test("a finding links to the session most of its events belong to", () => {
    const events = ['a1', 'a2', 'b1'].map((id) => makeEvent({ eventId: id, sessionId: id.startsWith('a') ? 'session-a' : 'session-b' }));
    const registry = new FindingsRegistry();
    registry.report('tool-churn', [makeFinding({ heuristicId: 'tool-churn', eventRefs: ['a1', 'a2', 'b1'] })]);
    registry.report('stalled', [makeFinding({ eventRefs: [] })]);
    const state = buildDetailState({
      now: '2026-01-01T12:00:00.000Z',
      capture: { enabled: false, retentionDays: 90 },
      today: new Aggregate().snapshot(),
      recentEvents: events,
      findings: registry.views(),
      muted: [],
      daily: [],
      isOpenable: () => false,
    });
    assert.deepStrictEqual(state.findings.map((f) => [f.heuristicId, f.sessionId]), [['tool-churn', 'session-a'], ['stalled', undefined]]);
  });

  test('isDetailMessage accepts only well-formed messages', () => {
    assert.ok(isDetailMessage({ type: 'ready' }));
    assert.ok(isDetailMessage({ type: 'acknowledge', heuristicId: 'stalled' }));
    assert.ok(isDetailMessage({ type: 'setMuted', heuristicId: 'stalled', muted: false }));
    assert.ok(isDetailMessage({ type: 'openFile', target: 'a.ts' }));
    assert.ok(!isDetailMessage(null));
    assert.ok(!isDetailMessage({ type: 'setMuted', heuristicId: 'stalled' }));
    assert.ok(!isDetailMessage({ type: 'openFile', target: 42 }));
    assert.ok(!isDetailMessage({ type: 'runCommand', command: 'rm -rf /' }));
  });

  test('resolveTargetFile resolves absolute and workspace-relative files only', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snagboat-resolve-'));
    const other = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snagboat-resolve-'));
    await fs.promises.mkdir(path.join(other, 'src'));
    await fs.promises.writeFile(path.join(other, 'src', 'a.ts'), '');

    assert.strictEqual(resolveTargetFile(path.join(other, 'src', 'a.ts'), []), path.join(other, 'src', 'a.ts'));
    assert.strictEqual(resolveTargetFile('src/a.ts', [root, other]), path.join(other, 'src', 'a.ts'), 'tries each root in order');
    assert.strictEqual(resolveTargetFile('src', [other]), undefined, 'directories are not openable');
    assert.strictEqual(resolveTargetFile('npm test', [other]), undefined);
    assert.strictEqual(resolveTargetFile('src/a.ts\nmore', [other]), undefined);
    assert.strictEqual(resolveTargetFile('', [other]), undefined);
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
