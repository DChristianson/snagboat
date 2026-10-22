import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventLog } from '../../core/eventLog';
import { Aggregate } from '../../core/aggregate';
import { AggregateStore, EventSink, applyRetention, oldestKeptDay, summarizeDay } from '../../core/retention';
import { NormalizedEvent } from '../../core/types';

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

async function tempStorage(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'snagboat-retention-'));
}

/** Writes a raw daily file directly, since EventLog.append always targets the real "today". */
async function writeRawDay(storageDir: string, day: string, events: NormalizedEvent[]): Promise<void> {
  const dir = path.join(storageDir, 'events');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${day}.jsonl`), events.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
}

async function setup(): Promise<{ dir: string; log: EventLog; store: AggregateStore }> {
  const dir = await tempStorage();
  const log = new EventLog(dir);
  await log.init();
  const store = new AggregateStore(dir);
  await store.init();
  return { dir, log, store };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('oldestKeptDay counts today as day one and crosses month boundaries', () => {
    assert.strictEqual(oldestKeptDay('2026-10-16', 1), '2026-10-16');
    assert.strictEqual(oldestKeptDay('2026-10-16', 3), '2026-10-14');
    assert.strictEqual(oldestKeptDay('2026-03-01', 2), '2026-02-28');
  });

  test('summarizeDay matches what Aggregate computes for the same events', () => {
    const events = [
      makeEvent({ agent: 'claude-code' }),
      makeEvent({ agent: 'generic-fs', kind: 'edit', tokens: undefined }),
      makeEvent({ agent: 'copilot', kind: 'tool_call', tokens: { input: 1 } }),
    ];
    const live = new Aggregate();
    for (const e of events) live.apply(e);
    const daily = summarizeDay('2026-01-01', events);
    assert.strictEqual(daily.date, '2026-01-01');
    assert.deepStrictEqual({ perAgent: daily.perAgent, localEditCount: daily.localEditCount, totalTokens: daily.totalTokens }, live.snapshot());
  });

  test('raw days older than rawDays are rolled up and deleted; recent days are untouched', async () => {
    const { dir, log, store } = await setup();
    await writeRawDay(dir, '2026-01-01', [makeEvent()]);
    await writeRawDay(dir, '2026-01-09', [makeEvent()]);
    await writeRawDay(dir, '2026-01-10', [makeEvent()]);

    const result = await applyRetention(log, store, { rawDays: 2, aggregateDays: -1 }, '2026-01-10');

    assert.deepStrictEqual(result.rolledUp, ['2026-01-01']);
    assert.deepStrictEqual(result.dropped, []);
    assert.deepStrictEqual(await log.listDays(), ['2026-01-09', '2026-01-10']);
    assert.deepStrictEqual(await store.listDays(), ['2026-01-01']);
    assert.strictEqual((await store.read('2026-01-01'))?.totalTokens, 37);
  });

  test('all-time totals survive a rollup unchanged after rehydrating', async () => {
    const { dir, log, store } = await setup();
    await writeRawDay(dir, '2026-01-01', [makeEvent(), makeEvent({ kind: 'edit', agent: 'generic-fs', tokens: undefined })]);
    await writeRawDay(dir, '2026-01-10', [makeEvent({ agent: 'copilot' })]);

    const before = new Aggregate();
    await before.rehydrateFrom(log, store);
    await applyRetention(log, store, { rawDays: 1, aggregateDays: -1 }, '2026-01-10');
    const after = new Aggregate();
    await after.rehydrateFrom(log, store);

    assert.deepStrictEqual(after.snapshot(), before.snapshot());
  });

  test('rawDays below 1 is clamped so today is never deleted', async () => {
    const { dir, log, store } = await setup();
    await writeRawDay(dir, '2026-01-10', [makeEvent()]);
    const result = await applyRetention(log, store, { rawDays: 0, aggregateDays: -1 }, '2026-01-10');
    assert.deepStrictEqual(result.rolledUp, []);
    assert.deepStrictEqual(await log.listDays(), ['2026-01-10']);
  });

  test('aggregateDays prunes old aggregates and reports them as dropped', async () => {
    const { dir, log, store } = await setup();
    await store.write(summarizeDay('2025-12-01', [makeEvent()]));
    await writeRawDay(dir, '2026-01-05', [makeEvent()]);

    const result = await applyRetention(log, store, { rawDays: 1, aggregateDays: 10 }, '2026-01-10');

    assert.deepStrictEqual(await store.listDays(), ['2026-01-05'], 'in-window rollup kept, old aggregate pruned');
    assert.deepStrictEqual(result.dropped.map((d) => d.date), ['2025-12-01']);
  });

  test('aggregateDays 0 deletes expired raw days without writing an aggregate', async () => {
    const { dir, log, store } = await setup();
    await store.write(summarizeDay('2025-12-01', [makeEvent()]));
    await writeRawDay(dir, '2026-01-01', [makeEvent()]);

    const result = await applyRetention(log, store, { rawDays: 1, aggregateDays: 0 }, '2026-01-10');

    assert.deepStrictEqual(await store.listDays(), []);
    assert.deepStrictEqual(await log.listDays(), []);
    assert.deepStrictEqual(result.dropped.map((d) => d.date).sort(), ['2025-12-01', '2026-01-01']);
  });

  test('subtracting dropped dailies from a live Aggregate matches a fresh rehydrate', async () => {
    const { dir, log, store } = await setup();
    await store.write(summarizeDay('2025-12-01', [makeEvent(), makeEvent({ agent: 'copilot', kind: 'tool_call' })]));
    await writeRawDay(dir, '2026-01-10', [makeEvent()]);

    const live = new Aggregate();
    await live.rehydrateFrom(log, store);
    const result = await applyRetention(log, store, { rawDays: 1, aggregateDays: 5 }, '2026-01-10');
    for (const daily of result.dropped) live.applyDaily(daily, -1);

    const fresh = new Aggregate();
    await fresh.rehydrateFrom(log, store);
    assert.strictEqual(live.snapshot().totalTokens, fresh.snapshot().totalTokens);
    assert.strictEqual(live.snapshot().perAgent['claude-code'].eventCount, fresh.snapshot().perAgent['claude-code'].eventCount);
  });

  test('a day with both raw and aggregate (crash mid-rollup) is counted once, and retention finishes the job', async () => {
    const { dir, log, store } = await setup();
    const events = [makeEvent()];
    await store.write(summarizeDay('2026-01-01', events));
    await writeRawDay(dir, '2026-01-01', events);

    const agg = new Aggregate();
    await agg.rehydrateFrom(log, store);
    assert.strictEqual(agg.snapshot().totalTokens, 37, 'raw file wins; aggregate not double counted');

    await applyRetention(log, store, { rawDays: 1, aggregateDays: -1 }, '2026-01-10');
    assert.deepStrictEqual(await log.listDays(), []);
    assert.deepStrictEqual(await store.listDays(), ['2026-01-01']);
  });

  test('retention is idempotent', async () => {
    const { dir, log, store } = await setup();
    await writeRawDay(dir, '2026-01-01', [makeEvent()]);
    const policy = { rawDays: 1, aggregateDays: -1 };
    await applyRetention(log, store, policy, '2026-01-10');
    const second = await applyRetention(log, store, policy, '2026-01-10');
    assert.deepStrictEqual(second, { rolledUp: [], dropped: [] });
    assert.deepStrictEqual(await store.listDays(), ['2026-01-01']);
  });

  test('unrelated files in the storage dirs are ignored', async () => {
    const { dir, log, store } = await setup();
    await fs.promises.writeFile(path.join(dir, 'events', 'notes.txt'), 'hi');
    await fs.promises.writeFile(path.join(dir, 'aggregates', '2026-01-01.json.tmp'), '{');
    assert.deepStrictEqual(await log.listDays(), []);
    assert.deepStrictEqual(await store.listDays(), []);
  });

  test('EventLog.clear waits for queued appends and removes every day', async () => {
    const { dir, log } = await setup();
    await writeRawDay(dir, '2026-01-01', [makeEvent()]);
    log.append(makeEvent());
    await log.clear();
    assert.deepStrictEqual(await log.listDays(), []);
    assert.deepStrictEqual(await log.readAll(), []);
  });

  /** An EventSink whose queued aggregate merges are collected, to run on demand. */
  function sinkFor(log: EventLog, store: AggregateStore, policy: { rawDays: number; aggregateDays: number }, today: string) {
    const ops: Array<() => Promise<void>> = [];
    const sink = new EventSink(log, store, () => policy, () => today, (op) => ops.push(op));
    const drain = async () => {
      while (ops.length > 0) await ops.shift()!();
      await log.flush();
    };
    return { sink, drain };
  }

  test('events are filed under the UTC day they happened, not the day they were written', async () => {
    const { log } = await setup();
    log.append(makeEvent({ ts: '2026-01-05T23:30:00.000Z' }));
    log.append(makeEvent({ ts: '2026-01-06T00:30:00.000-05:00' })); // 05:30 UTC on the 6th
    log.append(makeEvent({ ts: 'not a timestamp' }));
    await log.flush();
    const today = new Date().toISOString().slice(0, 10);
    assert.deepStrictEqual(await log.listDays(), ['2026-01-05', '2026-01-06', today].sort());
    assert.ok(log.hasDay('2026-01-05'));
  });

  test('EventSink: inside the raw window goes to that day\'s raw file', async () => {
    const { log, store } = await setup();
    const { sink, drain } = sinkFor(log, store, { rawDays: 10, aggregateDays: -1 }, '2026-01-10');
    assert.strictEqual(sink.write(makeEvent({ ts: '2026-01-10T12:00:00.000Z' })), true);
    assert.strictEqual(sink.write(makeEvent({ ts: '2026-01-03T12:00:00.000Z' })), true);
    await drain();
    assert.deepStrictEqual(await log.listDays(), ['2026-01-03', '2026-01-10']);
    assert.deepStrictEqual(await store.listDays(), []);
  });

  test('EventSink: older than the raw window is merged into that day\'s aggregate, batched', async () => {
    const { log, store } = await setup();
    await store.write(summarizeDay('2025-12-01', [makeEvent()]));
    const { sink, drain } = sinkFor(log, store, { rawDays: 10, aggregateDays: -1 }, '2026-01-10');
    sink.write(makeEvent({ ts: '2025-12-01T08:00:00.000Z' }));
    sink.write(makeEvent({ ts: '2025-12-01T09:00:00.000Z' }));
    sink.write(makeEvent({ ts: '2025-11-15T09:00:00.000Z' }));
    await drain();
    assert.deepStrictEqual(await log.listDays(), [], 'nothing written raw');
    assert.strictEqual((await store.read('2025-12-01'))?.totalTokens, 3 * 37, 'merged with the existing aggregate');
    assert.strictEqual((await store.read('2025-11-15'))?.totalTokens, 37, 'new aggregate created');
  });

  test('EventSink: a day that already has an aggregate stays aggregate-only, even inside the raw window', async () => {
    const { log, store } = await setup();
    await store.write(summarizeDay('2026-01-08', [makeEvent()])); // e.g. rolled up before rawDays was raised
    const { sink, drain } = sinkFor(log, store, { rawDays: 10, aggregateDays: -1 }, '2026-01-10');
    sink.write(makeEvent({ ts: '2026-01-08T12:00:00.000Z' }));
    await drain();
    assert.ok(!log.hasDay('2026-01-08'));
    assert.strictEqual((await store.read('2026-01-08'))?.totalTokens, 2 * 37);
  });

  test('EventSink: older than aggregate retention is not stored', async () => {
    const { log, store } = await setup();
    const { sink, drain } = sinkFor(log, store, { rawDays: 2, aggregateDays: 5 }, '2026-01-10');
    assert.strictEqual(sink.write(makeEvent({ ts: '2025-06-01T00:00:00.000Z' })), false);
    const zero = sinkFor(log, store, { rawDays: 2, aggregateDays: 0 }, '2026-01-10');
    assert.strictEqual(zero.sink.write(makeEvent({ ts: '2026-01-01T00:00:00.000Z' })), false);
    await drain();
    await zero.drain();
    assert.deepStrictEqual(await log.listDays(), []);
    assert.deepStrictEqual(await store.listDays(), []);
  });

  test('a late event for a day being rolled up lands in its aggregate, not a deleted raw file', async () => {
    const { dir, log, store } = await setup();
    await writeRawDay(dir, '2026-01-01', [makeEvent()]);
    await log.init(); // pick up the raw file written directly
    const { sink, drain } = sinkFor(log, store, { rawDays: 1, aggregateDays: -1 }, '2026-01-10');
    assert.ok(log.hasDay('2026-01-01'));

    // Retention releases the day before reading it; an event arriving now must not go raw.
    await log.releaseDay('2026-01-01');
    sink.write(makeEvent({ ts: '2026-01-01T18:00:00.000Z' }));
    // Checked directly: the timing that would lose a raw append (landing after
    // retention reads the file, before it deletes it) can't be forced here.
    assert.ok(!log.hasDay('2026-01-01'), 'a released day must not receive raw appends');
    await applyRetention(log, store, { rawDays: 1, aggregateDays: -1 }, '2026-01-10');
    await drain(); // the sink's merge is queued behind the retention run, as in the extension

    assert.deepStrictEqual(await log.listDays(), []);
    assert.strictEqual((await store.read('2026-01-01'))?.totalTokens, 2 * 37);
  });

  test('a reload reproduces exactly the totals the live session counted', async () => {
    const { log, store } = await setup();
    const policy = { rawDays: 5, aggregateDays: 30 };
    const { sink, drain } = sinkFor(log, store, policy, '2026-01-10');
    const live = new Aggregate();
    for (const ts of ['2026-01-10T01:00:00.000Z', '2026-01-07T01:00:00.000Z', '2025-12-20T01:00:00.000Z', '2025-12-20T02:00:00.000Z', '2025-06-01T00:00:00.000Z']) {
      const event = makeEvent({ ts });
      if (sink.write(event)) live.apply(event);
    }
    await drain();
    await applyRetention(log, store, policy, '2026-01-10');
    const reloaded = new Aggregate();
    await reloaded.rehydrateFrom(log, store);
    assert.deepStrictEqual(reloaded.snapshot(), live.snapshot());
    assert.strictEqual(live.snapshot().totalTokens, 4 * 37, 'the event beyond aggregate retention was not counted');
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
