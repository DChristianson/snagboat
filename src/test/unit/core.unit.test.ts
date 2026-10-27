import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventBus } from '../../core/eventBus';
import { EventLog } from '../../core/eventLog';
import { Aggregate, TodayAggregate, localDayKey } from '../../core/aggregate';
import { CheckpointStore } from '../../core/checkpointStore';
import { makeAdapterContext } from '../../core/adapterContext';
import { HealthRegistry } from '../../core/health';
import { NormalizedEvent } from '../../core/types';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: `evt-${Math.random()}`,
    sessionId: 'session-1',
    agent: 'claude-code',
    ts: new Date().toISOString(),
    kind: 'turn_stop',
    status: 'unknown',
    model: 'claude-sonnet-5',
    tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 2 },
    raw: { adapter: 'unit-test', ref: 'n/a' },
    ...overrides,
  };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('EventBus delivers published events to subscribers', () => {
    const bus = new EventBus();
    const received: NormalizedEvent[] = [];
    const sub = bus.onEvent((e) => received.push(e));
    bus.publish(makeEvent());
    assert.strictEqual(received.length, 1);
    sub.dispose();
    bus.publish(makeEvent());
    assert.strictEqual(received.length, 1, 'disposed listener should not receive further events');
  });

  test('EventLog appends and reads back events across a fresh instance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-eventlog-'));
    const log1 = new EventLog(dir);
    await log1.init();
    log1.append(makeEvent({ eventId: 'a' }));
    log1.append(makeEvent({ eventId: 'b' }));
    // append() queues an async write; give it a tick to flush before reading back.
    await new Promise((r) => setTimeout(r, 50));

    const log2 = new EventLog(dir);
    const events = await log2.readAll();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(
      events.map((e) => e.eventId).sort(),
      ['a', 'b']
    );
  });

  test('Aggregate sums all four token fields into totalTokens and tracks edits separately', () => {
    const agg = new Aggregate();
    agg.apply(makeEvent({ agent: 'claude-code' }));
    agg.apply(makeEvent({ agent: 'copilot', tokens: { input: 1, output: 1 } }));
    agg.apply(makeEvent({ agent: 'generic-fs', kind: 'edit', tokens: undefined }));

    const snap = agg.snapshot();
    assert.strictEqual(snap.totalTokens, (10 + 20 + 5 + 2) + (1 + 1), 'totalTokens should be flat sum of all token fields, v0 has no cost weighting');
    assert.strictEqual(snap.perAgent['claude-code'].eventCount, 1);
    assert.strictEqual(snap.perAgent['copilot'].tokens.input, 1);
    assert.strictEqual(snap.localEditCount, 1);
  });

  test('Aggregate tracks eventCountByKind per agent, distinct from the flat eventCount total', () => {
    const agg = new Aggregate();
    agg.apply(makeEvent({ agent: 'claude-code', kind: 'tool_call', tokens: undefined }));
    agg.apply(makeEvent({ agent: 'claude-code', kind: 'tool_call', tokens: undefined }));
    agg.apply(makeEvent({ agent: 'claude-code', kind: 'turn_stop' }));

    const snap = agg.snapshot();
    assert.strictEqual(snap.perAgent['claude-code'].eventCount, 3);
    assert.deepStrictEqual(snap.perAgent['claude-code'].eventCountByKind, { tool_call: 2, turn_stop: 1 });
  });

  test('Aggregate.rehydrateFrom reproduces the same snapshot as live-applying the same events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-rehydrate-'));
    const log = new EventLog(dir);
    await log.init();
    const events = [makeEvent({ eventId: 'x' }), makeEvent({ eventId: 'y', agent: 'copilot' })];
    for (const e of events) log.append(e);
    await new Promise((r) => setTimeout(r, 50));

    const live = new Aggregate();
    for (const e of events) live.apply(e);

    const rehydrated = new Aggregate();
    await rehydrated.rehydrateFrom(log);

    assert.deepStrictEqual(rehydrated.snapshot(), live.snapshot());
  });

  test('EventLog.snapshot reads the same days and events as the log, including queued appends', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-snapshot-'));
    const log = new EventLog(dir);
    await log.init();
    log.append(makeEvent({ eventId: 'a', ts: '2026-01-09T12:00:00.000Z' }));
    log.append(makeEvent({ eventId: 'b', ts: '2026-01-10T12:00:00.000Z' }));
    log.append(makeEvent({ eventId: 'b', ts: '2026-01-10T12:00:00.000Z' }));
    const snapshot = await log.snapshot();

    assert.deepStrictEqual(await snapshot.listDays(), await log.listDays());
    assert.deepStrictEqual(await snapshot.readAll(), await log.readAll());
    assert.deepStrictEqual((await snapshot.readDay('2026-01-10')).map((e) => e.eventId), ['b'], 'a repeated id counts once');
    assert.deepStrictEqual(await snapshot.readDay('2026-01-11'), []);

    const rehydrated = new Aggregate();
    await rehydrated.rehydrateFrom(snapshot);
    const fromLog = new Aggregate();
    await fromLog.rehydrateFrom(log);
    assert.deepStrictEqual(rehydrated.snapshot(), fromLog.snapshot());
  });

  test('TodayAggregate counts only events on the current local day and rolls over at local midnight', () => {
    // Local-time constructors keep this independent of the machine's timezone.
    const morning = new Date(2026, 0, 10, 9, 0, 0);
    const lateNight = new Date(2026, 0, 10, 23, 59, 0);
    const nextMorning = new Date(2026, 0, 11, 0, 1, 0);
    const today = new TodayAggregate(morning);

    today.apply(makeEvent({ ts: new Date(2026, 0, 9, 22, 0, 0).toISOString() }), morning); // yesterday: ignored
    today.apply(makeEvent({ ts: morning.toISOString() }), morning);
    today.apply(makeEvent({ ts: lateNight.toISOString() }), lateNight);
    assert.strictEqual(today.snapshot(lateNight).totalTokens, 2 * 37);

    assert.strictEqual(today.snapshot(nextMorning).totalTokens, 0, 'first touch after midnight resets');
    today.apply(makeEvent({ ts: nextMorning.toISOString() }), nextMorning);
    assert.strictEqual(today.snapshot(nextMorning).totalTokens, 37);
  });

  test('TodayAggregate.rehydrateFrom picks today\'s events out of UTC-keyed daily files', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snagboat-today-'));
    const eventsDir = path.join(dir, 'events');
    await fs.promises.mkdir(eventsDir, { recursive: true });
    const now = new Date(2026, 0, 10, 12, 0, 0);
    const todayEarly = new Date(2026, 0, 10, 0, 30, 0);
    const todayLate = new Date(2026, 0, 10, 23, 30, 0);
    const yesterday = new Date(2026, 0, 9, 12, 0, 0);
    // Group by UTC day exactly as EventLog does, wherever the test machine is.
    const byUtcDay = new Map<string, NormalizedEvent[]>();
    for (const d of [todayEarly, todayLate, yesterday]) {
      const key = d.toISOString().slice(0, 10);
      byUtcDay.set(key, [...(byUtcDay.get(key) ?? []), makeEvent({ ts: d.toISOString() })]);
    }
    for (const [day, events] of byUtcDay) {
      await fs.promises.writeFile(path.join(eventsDir, `${day}.jsonl`), events.map((e) => JSON.stringify(e) + '\n').join(''));
    }

    const today = new TodayAggregate(now);
    await today.rehydrateFrom(new EventLog(dir), now);
    assert.strictEqual(today.snapshot(now).totalTokens, 2 * 37, `local day ${localDayKey(now)}`);
  });

  test('CheckpointStore round-trips a checkpoint and returns undefined when absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-checkpoint-'));
    const store = new CheckpointStore(dir);
    await store.init();

    assert.strictEqual(await store.read('claude-code'), undefined);

    const checkpoint = { updatedAt: new Date().toISOString(), state: { offset: 42 } };
    await store.write('claude-code', checkpoint);
    const readBack = await store.read('claude-code');
    assert.deepStrictEqual(readBack, checkpoint);
  });

  test('CheckpointStore: a burst of unawaited writes leaves the latest, intact, with no temp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-checkpoint-'));
    const store = new CheckpointStore(dir);
    await store.init();
    // Shrinking payloads, as when overlapping plain writes would leave a longer one's tail behind.
    const writes: Array<Promise<void>> = [];
    for (let i = 300; i > 0; i--) writes.push(store.write('claude-code', { updatedAt: String(i), state: { pad: 'x'.repeat(i * 50) } }));
    await Promise.all(writes);
    assert.deepStrictEqual(await store.read('claude-code'), { updatedAt: '1', state: { pad: 'x'.repeat(50) } });
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'checkpoints')), ['claude-code.json']);
  });

  test('EventLog.readDay keeps one copy of an event logged twice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-dupes-'));
    const log = new EventLog(dir);
    await log.init();
    const a = makeEvent({ eventId: 'a', ts: '2026-01-01T00:00:00.000Z' });
    const b = makeEvent({ eventId: 'b', ts: '2026-01-01T00:01:00.000Z' });
    for (const e of [a, b, a, b]) log.append(e);
    await log.flush();
    assert.deepStrictEqual((await log.readDay('2026-01-01')).map((e) => e.eventId), ['a', 'b']);
  });

  test('makeAdapterContext wires publish/checkpoint calls to the right agent id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-adapterctx-'));
    const store = new CheckpointStore(dir);
    await store.init();
    const bus = new EventBus();
    const received: NormalizedEvent[] = [];
    bus.onEvent((e) => received.push(e));

    const health = new HealthRegistry();
    const ctx = makeAdapterContext('copilot', bus, store, health);
    ctx.publish(makeEvent({ agent: 'copilot' }));
    assert.strictEqual(received.length, 1);

    await ctx.writeCheckpoint({ updatedAt: 'now', state: { a: 1 } });
    assert.deepStrictEqual(await store.read('copilot'), { updatedAt: 'now', state: { a: 1 } });
    assert.deepStrictEqual(await ctx.readCheckpoint(), { updatedAt: 'now', state: { a: 1 } });

    ctx.reportHealth('otlp', 'port in use');
    assert.deepStrictEqual(health.list(), [{ source: 'copilot', message: 'port in use' }]);
  });

  test('HealthRegistry tracks independent keys per source and only notifies listeners on real changes', () => {
    const health = new HealthRegistry();
    let notifications = 0;
    health.onChange(() => (notifications += 1));

    health.report('claude-code', 'transcripts', 'no workspace folder open');
    health.report('claude-code', 'hooks', 'no workspace folder open');
    assert.strictEqual(notifications, 2);
    assert.strictEqual(health.list().length, 2, 'two independent keys under the same source must not clobber each other');

    health.report('claude-code', 'transcripts', 'no workspace folder open');
    assert.strictEqual(notifications, 2, 'reporting the same message again must not notify again');

    health.report('claude-code', 'transcripts', undefined);
    assert.strictEqual(notifications, 3);
    assert.strictEqual(health.list().length, 1);
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
