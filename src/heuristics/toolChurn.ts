import { NormalizedEvent } from '../core/types';
import { isConversationEvent } from '../core/sessions';
import { Heuristic, Finding, HeuristicContext } from './types';
import { positiveNumberOr } from './settings';

const DEFAULT_WINDOW_MINUTES = 5;
const DEFAULT_MIN_CALLS = 8;
// In your own history, two targets took 90% of a busy 5-minute window about 1% of the time.
const DEFAULT_MIN_SHARE = 0.9;

/**
 * Per session: many tool calls in a short window, most of them on the same
 * one or two targets. Calls without a target (todo lists, searches by
 * pattern) are left out.
 */
export const toolChurnHeuristic: Heuristic = {
  id: 'tool-churn',
  appliesTo: ['tool_call'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const windowMinutes = positiveNumberOr(ctx.settings.window, DEFAULT_WINDOW_MINUTES);
    const minCalls = positiveNumberOr(ctx.settings.minCalls, DEFAULT_MIN_CALLS);
    const minShare = Math.min(positiveNumberOr(ctx.settings.minShare, DEFAULT_MIN_SHARE), 1);

    const since = new Date(new Date(ctx.now).getTime() - windowMinutes * 60_000).toISOString();
    const bySession = new Map<string, NormalizedEvent[]>();
    for (const e of ctx.store.query({ since, kinds: ['tool_call'] })) {
      if (!e.target || !isConversationEvent(e)) continue;
      bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
    }

    const findings: Finding[] = [];
    for (const calls of bySession.values()) {
      if (calls.length < minCalls) continue;
      const counts = new Map<string, number>();
      for (const e of calls) counts.set(e.target!, (counts.get(e.target!) ?? 0) + 1);
      const top = [...counts.values()].sort((a, b) => b - a);
      const topTwo = top[0] + (top[1] ?? 0);
      if (topTwo / calls.length < minShare) continue;
      findings.push({
        heuristicId: 'tool-churn',
        severity: 'warn',
        summary: `${topTwo} of ${calls.length} tool calls in the last ${windowMinutes} minutes hit the same ${Math.min(counts.size, 2) === 1 ? 'target' : 'two targets'}`,
        eventRefs: calls.map((e) => e.eventId),
        detectedAt: ctx.now,
      });
    }
    return findings;
  },
};
