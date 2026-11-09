import * as assert from 'assert';
import { Headliner, HeadlineEntry } from '../../advisor/headlines';
import { buildDigest, LOCAL_POLICY } from '../../advisor/digest';
import { headlineLine, headlineMessages } from '../../advisor/summarizeSession';
import { proposeTacticsMessages } from '../../advisor/proposeTactics';
import { SessionSummary } from '../../schema/sessions';
import { NormalizedEvent } from '../../schema/types';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) + min * 60_000).toISOString();
const summary = (sessionId: string, lastMin: number, prompts = 2): SessionSummary => ({ sessionId, agent: 'claude-code', firstTs: at(lastMin - 30), lastTs: at(lastMin), models: ['m'], prompts, modelCalls: 3, toolCalls: 4, tokens: 100, subagents: 0, days: ['2026-01-01'] });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a session is due once idle past the window, within the day limit, with a prompt, and again only when it grows', async () => {
    const saved: Array<Record<string, HeadlineEntry>> = [];
    const h = new Headliner({}, async (c) => void saved.push(c));
    const now = at(60);
    const sessions = [summary('idle', 30), summary('live', 55), summary('old', -10 * 24 * 60), summary('noprompt', 20, 0), summary('older', 10)];
    assert.deepStrictEqual(h.due(sessions, now, 15, 7).map((s) => s.sessionId), ['idle', 'older'], 'newest first; live, old, and promptless sessions left out');
    await h.record('idle', at(30), 'Fixed the login bug after two failed test runs.', 'qwen', now);
    assert.strictEqual(h.get('idle'), 'Fixed the login bug after two failed test runs.');
    assert.deepStrictEqual(h.due(sessions, now, 15, 7).map((s) => s.sessionId), ['older'], 'headlined at its current size: not due');
    assert.deepStrictEqual(h.due([summary('idle', 40)], at(70), 15, 7).map((s) => s.sessionId), ['idle'], 'grown since: due again');
    await h.record('older', at(10), undefined, 'qwen', now);
    assert.strictEqual(h.get('older'), undefined, 'nothing specific: recorded, no line');
    assert.deepStrictEqual(h.due(sessions, now, 15, 7), [], 'and not asked again at this size');
    await h.prune(new Set(['idle']));
    assert.deepStrictEqual(Object.keys(saved[saved.length - 1]), ['idle']);
    assert.strictEqual(saved.length, 3);
  });

  test('the headline form asks for one line and reads one back; the tactics form sends the digests and your model tiers', () => {
    const ev = (overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind' | 'eventId'>): NormalizedEvent => ({ sessionId: 's1', turnId: 't1', agent: 'claude-code', ts: at(0), status: 'success', raw: { adapter: 'test', ref: 'n/a' }, ...overrides });
    const digest = buildDigest({ sessionId: 's1', events: [ev({ eventId: 'p', kind: 'user_prompt', promptText: 'push it' }), ev({ eventId: 'c', kind: 'turn_stop', model: 'opus', tokens: { input: 5, output: 1 }, endsTurn: true })], findings: [], roots: [] }, LOCAL_POLICY);
    const [system, user] = headlineMessages(digest, { persona: 'P' });
    assert.ok(system.content.startsWith('P\n\n') && system.content.includes('one line of at most 15 words'));
    assert.ok(user.content.startsWith('Give this session a headline.') && user.content.includes('"prompt":"push it"'));
    assert.strictEqual(headlineLine('  "Pushed a one-line change with a top-tier model."\n'), 'Pushed a one-line change with a top-tier model.');
    assert.strictEqual(headlineLine('nothing specific'), undefined);
    assert.strictEqual(headlineLine('x'.repeat(200))!.length, 120);

    const [tSystem, tUser] = proposeTacticsMessages([digest], {}, { opus: 'high', haiku: 'low' });
    assert.ok(tSystem.content.includes('"Model use", "Prompt tactics", and "What to try"'));
    assert.ok(tUser.content.startsWith('Propose tactics for this session') && tUser.content.includes('"modelTiers":{"opus":"high","haiku":"low"}') && tUser.content.includes('"model":"opus"'));
    const [, many] = proposeTacticsMessages([digest, digest]);
    assert.ok(many.content.startsWith('Propose tactics from these 2 sessions') && !many.content.includes('modelTiers'), 'no tiers when none are set');
  });

  test('a digest can be capped to fewer turns than the default', () => {
    const events: NormalizedEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push({ eventId: `p${i}`, sessionId: 's1', turnId: `t${i}`, agent: 'claude-code', ts: at(i * 10), status: 'success', raw: { adapter: 'test', ref: 'n/a' }, kind: 'user_prompt' });
      events.push({ eventId: `c${i}`, sessionId: 's1', turnId: `t${i}`, agent: 'claude-code', ts: at(i * 10 + 1), status: 'success', raw: { adapter: 'test', ref: 'n/a' }, kind: 'turn_stop', model: 'm', tokens: { input: 1, output: 1 }, endsTurn: true });
    }
    const d = buildDigest({ sessionId: 's1', events, findings: [], roots: [], maxTurns: 2 }, LOCAL_POLICY);
    assert.deepStrictEqual([d.turns.map((t) => t.turn), d.turnsOmitted], [[4, 5], 3], 'the latest turns, and how many were left out');
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
