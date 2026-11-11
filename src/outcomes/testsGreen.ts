import { baseCategory, NormalizedEvent } from '@snagboat/schema';

/**
 * "Tests going green" (RFC step 4, outcome capture): a test or build tool call
 * (the tests-builds category) that succeeds after one or more failed in the
 * same session becomes a tests_green outcome, naming the first failure and the
 * run that passed, with how many failed and how long it took.
 *
 * Whoever writes a workspace's events runs it over them as they arrive: the
 * core, or a window writing its own folder. It remembers only failures not yet
 * followed by a pass, per session, in memory; a failure from before a restart
 * isn't remembered, so that green goes unrecorded. Its eventId is derived from
 * the passing run's, so reading the same events again produces no second one.
 */

export const OUTCOMES_ADAPTER = 'snagboat-outcomes';

/** Sessions with a failing run not yet followed by a passing one are forgotten after this long. */
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

interface Failing {
  first: NormalizedEvent;
  failures: number;
  lastAt: number;
}

export class TestsGreen {
  private readonly failing = new Map<string, Failing>();

  /** The outcomes these events complete, in order. Ignores everything but tests-builds tool calls with a known status. */
  observe(events: NormalizedEvent[]): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const e of events) {
      if (e.kind !== 'tool_call' || !e.toolCategory || baseCategory(e.toolCategory) !== 'tests-builds' || e.status === 'unknown') continue;
      const key = `${e.workspace ?? ''}\n${e.sessionId}`;
      const at = Date.parse(e.ts);
      const open = this.failing.get(key);
      if (e.status === 'failure') {
        if (open) {
          open.failures += 1;
          open.lastAt = at;
        } else this.failing.set(key, { first: e, failures: 1, lastAt: at });
        continue;
      }
      if (!open) continue;
      this.failing.delete(key);
      out.push({
        eventId: `outcome:tests_green:${e.eventId}`,
        sessionId: e.sessionId,
        agent: e.agent,
        ts: e.ts,
        kind: 'outcome',
        status: 'success',
        ...(e.turnId ? { turnId: e.turnId } : {}),
        ...(e.agentId ? { agentId: e.agentId } : {}),
        ...(e.workspace ? { workspace: e.workspace } : {}),
        outcome: { type: 'tests_green', refs: [open.first.eventId, e.eventId], failures: open.failures, afterMs: Math.max(0, at - Date.parse(open.first.ts)) },
        raw: { adapter: OUTCOMES_ADAPTER, ref: `tests:${e.eventId}` },
      });
    }
    this.forget(Date.now());
    return out;
  }

  private forget(now: number): void {
    if (this.failing.size < 64) return;
    for (const [key, f] of this.failing) if (now - f.lastAt > FORGET_AFTER_MS) this.failing.delete(key);
  }
}
