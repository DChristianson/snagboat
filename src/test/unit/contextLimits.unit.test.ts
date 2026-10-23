import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextLimits, contextSize } from '../../core/contextLimits';
import { NormalizedEvent } from '../../core/types';

function call(model: string, context: number, ts = '2026-10-20T12:00:00.000Z'): NormalizedEvent {
  return { eventId: `e-${Math.random()}`, sessionId: 's', agent: 'claude-code', ts, kind: 'turn_stop', status: 'unknown', model, tokens: { input: 10, cacheRead: context - 110, cacheCreation: 100, output: 999 }, raw: { adapter: 't', ref: 'n/a' } };
}

function compaction(model: string, trigger: 'auto' | 'manual', preTokens: number): NormalizedEvent {
  return { eventId: `c-${Math.random()}`, sessionId: 's', agent: 'claude-code', ts: '2026-10-20T13:00:00.000Z', kind: 'compaction', status: 'unknown', model, compaction: { trigger, preTokens, postTokens: 50_000 }, raw: { adapter: 't', ref: 'n/a' } };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-limits-'));

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('context size is everything a call read, not its output', () => {
    assert.strictEqual(contextSize(call('m', 500_000)), 500_000);
  });

  test('largest seen tracks the biggest context per model', () => {
    const limits = new ContextLimits(tempDir());
    limits.observe(call('opus', 400_000));
    limits.observe(call('opus', 964_050, '2026-10-20T14:00:00.000Z'));
    limits.observe(call('opus', 700_000));
    limits.observe(call('sonnet', 100_000));
    assert.deepStrictEqual(limits.get('opus'), { largestSeen: 964_050, largestSeenAt: '2026-10-20T14:00:00.000Z' });
    assert.strictEqual(limits.get('sonnet')?.largestSeen, 100_000);
  });

  test('a limit is set only by an automatic compaction, and the lowest one wins', () => {
    const limits = new ContextLimits(tempDir());
    assert.strictEqual(limits.observe(compaction('opus', 'manual', 400_000)), false, 'manual compactions do not count');
    assert.strictEqual(limits.get('opus')?.limit, undefined);
    limits.observe(compaction('opus', 'auto', 987_250));
    limits.observe(compaction('opus', 'auto', 995_000));
    assert.strictEqual(limits.get('opus')?.limit, 987_250);
    assert.strictEqual(limits.get('opus')?.limitSource, 'auto-compaction');
  });

  test('synthetic or model-less events are ignored', () => {
    const limits = new ContextLimits(tempDir());
    assert.strictEqual(limits.observe(call('<synthetic>', 10)), false);
    assert.strictEqual(limits.observe({ ...call('x', 10), model: undefined }), false);
    assert.deepStrictEqual(limits.all(), {});
  });

  test('marks persist, and two windows writing concurrently keep each other\'s values', async () => {
    const dir = tempDir();
    const windowA = new ContextLimits(dir, 60_000);
    const windowB = new ContextLimits(dir, 60_000);
    await windowA.load();
    await windowB.load();
    windowA.observe(call('opus', 900_000));
    windowB.observe(call('opus', 950_000));
    windowB.observe(compaction('opus', 'auto', 987_250));
    windowA.observe(call('sonnet', 300_000));
    await windowA.flush();
    await windowB.flush();

    const reopened = new ContextLimits(dir);
    await reopened.load();
    assert.strictEqual(reopened.get('opus')?.largestSeen, 950_000);
    assert.strictEqual(reopened.get('opus')?.limit, 987_250);
    assert.strictEqual(reopened.get('sonnet')?.largestSeen, 300_000, "window A's model survives window B's later write");
    assert.strictEqual(windowB.get('sonnet')?.largestSeen, 300_000, "flushing also picks up other windows' values");
  });

  test('an unreadable file starts fresh instead of failing', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'context-limits.json'), '{not json');
    const limits = new ContextLimits(dir, 60_000);
    await limits.load();
    limits.observe(call('opus', 1_000));
    await limits.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'context-limits.json'), 'utf8')).models.opus.largestSeen, 1_000);
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
  process.exit(0);
}

main();
