import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../../core/eventStore';
import { EventLog } from '../../core/eventLog';
import { NormalizedEvent } from '../../core/types';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: `evt-${Math.random()}`,
    sessionId: 'session-1',
    agent: 'claude-code',
    ts: new Date().toISOString(),
    kind: 'turn_stop',
    status: 'unknown',
    tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 2 },
    raw: { adapter: 'unit-test', ref: 'n/a' },
    ...overrides,
  };
}

function tsAt(msFromEpoch: number): string {
  return new Date(msFromEpoch).toISOString();
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('query() filters by since/until/kinds/agents/sessionId/target/limit', () => {
    const store = new EventStore({ windowMs: 1_000_000, maxEvents: 1000 });
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    store.ingest(makeEvent({ eventId: 'a', ts: tsAt(base), kind: 'edit', agent: 'generic-fs', target: 'x.ts', tokens: undefined }));
    store.ingest(makeEvent({ eventId: 'b', ts: tsAt(base + 1000), kind: 'tool_call', agent: 'claude-code', target: 'x.ts', tokens: undefined }));
    store.ingest(makeEvent({ eventId: 'c', ts: tsAt(base + 2000), kind: 'tool_call', agent: 'copilot', target: 'y.ts', sessionId: 'session-2', tokens: undefined }));

    assert.deepStrictEqual(store.query({ since: tsAt(base + 1000) }).map((e) => e.eventId), ['b', 'c']);
    assert.deepStrictEqual(store.query({ until: tsAt(base + 2000) }).map((e) => e.eventId), ['a', 'b']);
    assert.deepStrictEqual(store.query({ kinds: ['tool_call'] }).map((e) => e.eventId), ['b', 'c']);
    assert.deepStrictEqual(store.query({ agents: ['claude-code'] }).map((e) => e.eventId), ['b']);
    assert.deepStrictEqual(store.query({ sessionId: 'session-2' }).map((e) => e.eventId), ['c']);
    assert.deepStrictEqual(store.query({ target: 'x.ts' }).map((e) => e.eventId), ['a', 'b']);
    assert.deepStrictEqual(store.query({ limit: 1 }).map((e) => e.eventId), ['c']);
    assert.strictEqual(store.query().length, 3, 'no filter returns everything');
  });

  test('lastN and latestTs', () => {
    const store = new EventStore({ windowMs: 1_000_000, maxEvents: 1000 });
    assert.strictEqual(store.latestTs(), undefined, 'empty store has no latest timestamp');

    const base = Date.parse('2026-01-01T00:00:00.000Z');
    store.ingest(makeEvent({ eventId: 'a', ts: tsAt(base) }));
    store.ingest(makeEvent({ eventId: 'b', ts: tsAt(base + 1000) }));
    store.ingest(makeEvent({ eventId: 'c', ts: tsAt(base + 2000) }));

    assert.deepStrictEqual(store.lastN(2).map((e) => e.eventId), ['b', 'c']);
    assert.strictEqual(store.latestTs(), tsAt(base + 2000));
  });

  test('events older than windowMs are evicted from the query window', () => {
    const store = new EventStore({ windowMs: 5000, maxEvents: 1000 });
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    store.ingest(makeEvent({ eventId: 'old', ts: tsAt(base) }));
    store.ingest(makeEvent({ eventId: 'new', ts: tsAt(base + 10_000) })); // 10s later, outside a 5s window

    assert.deepStrictEqual(store.query().map((e) => e.eventId), ['new'], 'old event must be evicted once outside windowMs');
  });

  test('maxEvents caps the window even within windowMs', () => {
    const store = new EventStore({ windowMs: 1_000_000, maxEvents: 2 });
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    store.ingest(makeEvent({ eventId: 'a', ts: tsAt(base) }));
    store.ingest(makeEvent({ eventId: 'b', ts: tsAt(base + 1000) }));
    store.ingest(makeEvent({ eventId: 'c', ts: tsAt(base + 2000) }));

    assert.deepStrictEqual(store.query().map((e) => e.eventId), ['b', 'c'], 'oldest event evicted once over maxEvents');
  });

  test('cumulativeTokens accumulates per session and per day independently of window eviction', () => {
    const store = new EventStore({ windowMs: 1, maxEvents: 1 }); // aggressively small window
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    store.ingest(makeEvent({ sessionId: 's1', ts: tsAt(base), tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } }));
    store.ingest(makeEvent({ sessionId: 's1', ts: tsAt(base + 1000), tokens: { input: 3, output: 1, cacheRead: 0, cacheCreation: 0 } }));
    store.ingest(makeEvent({ sessionId: 's2', ts: tsAt(base + 2000), tokens: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 } }));

    // Eviction is relative to the *latest* ingested event, so the most recent
    // one always survives even with a 1ms window -- it's never literally
    // empty. What matters here: the first two events are long gone from the
    // raw window, yet cumulative totals still reflect every token ingested.
    assert.ok(store.query().length < 3, 'sanity: eviction actually happened given the tiny window');
    assert.deepStrictEqual(store.cumulativeTokens({ sessionId: 's1' }), { input: 13, output: 6, cacheRead: 0, cacheCreation: 0 });
    assert.deepStrictEqual(store.cumulativeTokens({ sessionId: 's2' }), { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 });
    assert.deepStrictEqual(store.cumulativeTokens({ day: '2026-01-01' }), { input: 113, output: 6, cacheRead: 0, cacheCreation: 0 });
    assert.deepStrictEqual(store.cumulativeTokens({}), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, 'no scope given means no total');
  });

  test('rehydrateFrom reproduces the same state as live-ingesting the same events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-eventstore-rehydrate-'));
    const log = new EventLog(dir);
    await log.init();
    const events = [
      makeEvent({ eventId: 'x', sessionId: 's1' }),
      makeEvent({ eventId: 'y', sessionId: 's2', agent: 'copilot' }),
    ];
    for (const e of events) log.append(e);
    await new Promise((r) => setTimeout(r, 50));

    const live = new EventStore({ windowMs: 1_000_000, maxEvents: 1000 });
    for (const e of events) live.ingest(e);

    const rehydrated = new EventStore({ windowMs: 1_000_000, maxEvents: 1000 });
    await rehydrated.rehydrateFrom(log);

    assert.deepStrictEqual(
      rehydrated.query().map((e) => e.eventId).sort(),
      live.query().map((e) => e.eventId).sort()
    );
    assert.deepStrictEqual(rehydrated.cumulativeTokens({ sessionId: 's1' }), live.cumulativeTokens({ sessionId: 's1' }));
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
