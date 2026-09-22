import { Heuristic, Finding, HeuristicContext } from './types';
import { TokenTotals } from '../core/eventStore';

function sumTokens(totals: TokenTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheCreation;
}

function positiveNumberSetting(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** YYYY-MM-DD, matching EventStore's/EventLog's day-key convention. */
function dayKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Local (per session) and project (per workspace/day) levels only, per the
 * confirmed v1 increment-1 scope -- a global cross-workspace rollup and a
 * treemap detail view were explicitly deferred to a separate later increment.
 */
export const tokenBudgetHeuristic: Heuristic = {
  id: 'token-budget',
  // Tokens are only ever attached to turn_stop events (per docs/schema.md's
  // transformation matrix), so that's the only kind that can change a total.
  appliesTo: ['turn_stop'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const findings: Finding[] = [];
    const sessionBudget = positiveNumberSetting(ctx.settings.session);
    const dayBudget = positiveNumberSetting(ctx.settings.day);

    if (sessionBudget !== undefined) {
      const activeSessionIds = new Set(ctx.store.query().map((e) => e.sessionId));
      for (const sessionId of activeSessionIds) {
        const total = sumTokens(ctx.store.cumulativeTokens({ sessionId }));
        if (total > sessionBudget) {
          findings.push({
            heuristicId: 'token-budget',
            severity: 'warn',
            summary: `Session ${sessionId} used ${total} tokens, over the ${sessionBudget}-token session budget`,
            eventRefs: [],
            suggestedAction: 'Consider starting a fresh session or reviewing recent usage.',
            detectedAt: ctx.now,
          });
        }
      }
    }

    if (dayBudget !== undefined) {
      const total = sumTokens(ctx.store.cumulativeTokens({ day: dayKeyOf(ctx.now) }));
      if (total > dayBudget) {
        findings.push({
          heuristicId: 'token-budget',
          severity: 'warn',
          summary: `Today's usage is ${total} tokens, over the ${dayBudget}-token daily budget`,
          eventRefs: [],
          detectedAt: ctx.now,
        });
      }
    }

    return findings;
  },
};
