import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FindingRecord, NormalizedEvent } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { FINDINGS_FILE, findingId, readFindings } from '../../core/findingRecords';
import { FindingsService } from '../../core/service/findings';
import { StoreWriter } from '../../core/service/storeWriter';
import { workspaceStoreDir } from '../../core/userStore';

// Finding episodes in findings.jsonl (docs/design/export.md, "Findings: findings.jsonl"): each
// written as it was shown when it closes, and again when a response to it lands.

const RULE = {
  id: 'test:busy',
  title: 'Busy',
  scope: 'window',
  windowMinutes: 5,
  measure: { type: 'count', filter: { kind: 'turn_stop', hasTokens: true } },
  when: { gte: 2 },
  severity: 'warn',
  summary: '{value} model calls',
  earlyWarning: 0.5,
};
const MIN = 60_000;

let n = 0;
const call = (at: number, workspace: string): NormalizedEvent => ({
  eventId: `call-${(n += 1)}`,
  sessionId: 's1',
  turnId: 't1',
  agent: 'claude-code',
  ts: new Date(at).toISOString(),
  kind: 'turn_stop',
  status: 'success',
  model: 'claude-sonnet-5',
  tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
  raw: { adapter: 'test', ref: `r${n}` },
  workspace,
});

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a closed episode is written as shown (version, session, turn, summary, refs, early warning, response); a response landing later appends it again', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-episodes-')));
    const home = path.join(root, '.snagboat');
    const w = path.join(root, 'project');
    fs.mkdirSync(w);
    saveConfig(home, { version: 1, defaults: {}, projects: { [w]: { rules: [RULE] } } });
    let now = Date.now();
    const writer = new StoreWriter(home);
    const outcomes: NormalizedEvent[] = [];
    const svc = new FindingsService({
      home,
      onChange: () => undefined,
      now: () => now,
      version: '9.9.9',
      record: (_w, events) => outcomes.push(...events),
      store: (workspace, records) => fs.appendFileSync(path.join(workspaceStoreDir(home, workspace), FINDINGS_FILE), records.map((r) => JSON.stringify(r) + '\n').join('')),
    });
    const first = call(now, w);
    await writer.write([first]);
    const warned = await svc.current(w);
    assert.deepStrictEqual(warned.progress.map((p) => p.heuristicId), ['test:busy'], 'an early warning first');
    now += MIN;
    const second = call(now, w);
    await writer.write([second]);
    svc.ingest(w, [second]);
    const firing = await svc.current(w);
    assert.deepStrictEqual(firing.findings.map((f) => f.heuristicId), ['test:busy']);
    const startedAt = new Date(now).toISOString();
    now += 20 * MIN; // out of its window: the episode closes
    assert.deepStrictEqual((await svc.current(w)).findings, []);
    const store = workspaceStoreDir(home, w);
    const records = [...readFindings(store).values()];
    assert.strictEqual(records.length, 1);
    const r = records[0];
    assert.deepStrictEqual(
      { ...r, heuristicVersion: r.heuristicVersion.length },
      {
        record: 'finding',
        version: 1,
        id: findingId('test:busy', 's1', startedAt),
        heuristicId: 'test:busy',
        heuristicVersion: 16,
        sessionId: 's1',
        turnId: 't1',
        severity: 'warn',
        summary: '2 model calls',
        firstTs: startedAt,
        lastTs: new Date(now).toISOString(),
        eventRefs: r.eventRefs,
        earlyWarning: true,
        response: 'passed',
      } as unknown as FindingRecord
    );
    assert.ok(/^[0-9a-f]{16}$/.test(r.heuristicVersion), 'a saved rule: a hash of its definition');
    assert.deepStrictEqual([...r.eventRefs].sort(), [first.eventId, second.eventId].sort());
    // The outcome for the same episode, as the core records it.
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].outcome?.response, 'passed');
    // It lands again with another response (marked useful elsewhere): appended under the same id.
    svc.ingest(w, [{ ...outcomes[0], outcome: { ...outcomes[0].outcome!, response: 'useful' }, workspace: w }]);
    const lines = fs.readFileSync(path.join(store, FINDINGS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FindingRecord);
    assert.deepStrictEqual(lines.map((l) => [l.id, l.response]), [[r.id, 'passed'], [r.id, 'useful']]);
    // The same response again: nothing.
    svc.ingest(w, [{ ...outcomes[0], outcome: { ...outcomes[0].outcome!, response: 'useful' }, workspace: w }]);
    assert.strictEqual(fs.readFileSync(path.join(store, FINDINGS_FILE), 'utf8').trim().split('\n').length, 2);
    await svc.dispose();
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
