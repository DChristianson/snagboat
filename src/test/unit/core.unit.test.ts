import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventBus } from '../../core/eventBus';
import { EventLog } from '../../core/eventLog';
import { Aggregate } from '../../core/aggregate';
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
