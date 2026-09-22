import * as assert from 'assert';
import { formatCount, agentEventTotal, buildStatusBarText, buildBreakdownLines } from '../../ui/format';
import { Aggregate } from '../../core/aggregate';
import { NormalizedEvent } from '../../core/types';
import { Finding } from '../../heuristics/types';

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

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('formatCount abbreviates thousands without a spurious ".0"', () => {
    assert.strictEqual(formatCount(0), '0');
    assert.strictEqual(formatCount(999), '999');
    assert.strictEqual(formatCount(1000), '1k');
    assert.strictEqual(formatCount(1500), '1.5k');
    assert.strictEqual(formatCount(12400), '12.4k');
  });

  test('agentEventTotal sums event counts across agents but excludes generic-fs', () => {
    const agg = new Aggregate();
    agg.apply(makeEvent({ agent: 'claude-code', kind: 'tool_call', tokens: undefined }));
    agg.apply(makeEvent({ agent: 'copilot', kind: 'turn_stop' }));
    agg.apply(makeEvent({ agent: 'generic-fs', kind: 'edit', tokens: undefined }));

    const snap = agg.snapshot();
    assert.strictEqual(agentEventTotal(snap), 2, 'generic-fs edits must not count as agent events');
    assert.strictEqual(snap.localEditCount, 1);
  });

  test('buildStatusBarText switches to a warning icon when health issues are present', () => {
    const agg = new Aggregate();
    const snap = agg.snapshot();
    assert.ok(buildStatusBarText(snap, []).startsWith('$(pulse)'));
    assert.ok(buildStatusBarText(snap, [{ source: 'copilot', message: 'oops' }]).startsWith('$(warning)'));
  });

  test('buildStatusBarText includes tokens, agent events, and local edits', () => {
    const agg = new Aggregate();
    agg.apply(makeEvent({ agent: 'claude-code' }));
    agg.apply(makeEvent({ agent: 'generic-fs', kind: 'edit', tokens: undefined }));
    const text = buildStatusBarText(agg.snapshot(), []);
    assert.ok(text.includes('37 tokens'), text);
    assert.ok(text.includes('1 events'), text);
    assert.ok(text.includes('1 edits'), text);
  });

  test('buildBreakdownLines includes a per-source cache breakdown and a grand-total section', () => {
    const agg = new Aggregate();
    agg.apply(makeEvent({ agent: 'claude-code', tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 2 } }));
    agg.apply(makeEvent({ agent: 'generic-fs', kind: 'edit', tokens: undefined }));

    const lines = buildBreakdownLines(agg.snapshot(), []).join('\n');
    assert.ok(lines.includes('10 in, 20 out, 5 cache-read, 2 cache-create'), lines);
    assert.ok(lines.includes('Total:'), lines);
    assert.ok(lines.includes('Local edits: 1'), lines);
  });

  test('buildBreakdownLines includes a Health section only when there are issues', () => {
    const agg = new Aggregate();
    const snap = agg.snapshot();
    assert.ok(!buildBreakdownLines(snap, []).join('\n').includes('Health:'));

    const withHealth = buildBreakdownLines(snap, [{ source: 'copilot', message: 'port in use' }]).join('\n');
    assert.ok(withHealth.includes('Health:'));
    assert.ok(withHealth.includes('copilot: port in use'));
  });

  test('buildStatusBarText uses a finding-specific glyph and appends its summary when present', () => {
    const agg = new Aggregate();
    const snap = agg.snapshot();
    const finding = makeFinding();

    const text = buildStatusBarText(snap, [], finding);
    assert.ok(text.startsWith('$(clock)'), text); // stalled -> $(clock) per README's indicator table
    assert.ok(text.includes('No activity for 20 minutes'), text);
  });

  test('buildStatusBarText prioritizes the health warning icon over a finding glyph', () => {
    const agg = new Aggregate();
    const snap = agg.snapshot();
    const text = buildStatusBarText(snap, [{ source: 'copilot', message: 'oops' }], makeFinding());
    assert.ok(text.startsWith('$(warning)'), text);
  });

  test('buildBreakdownLines includes a Findings section only when there are active findings', () => {
    const agg = new Aggregate();
    const snap = agg.snapshot();
    assert.ok(!buildBreakdownLines(snap, []).join('\n').includes('Findings:'));

    const withFinding = buildBreakdownLines(snap, [], [makeFinding({ suggestedAction: 'take a break' })]).join('\n');
    assert.ok(withFinding.includes('Findings:'));
    assert.ok(withFinding.includes('[warn] stalled: No activity for 20 minutes'));
    assert.ok(withFinding.includes('take a break'));
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
