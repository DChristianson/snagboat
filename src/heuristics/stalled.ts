import { Heuristic, Finding, HeuristicContext } from './types';

const DEFAULT_MINUTES = 15;

function minutesSetting(settings: Record<string, unknown>): number {
  const value = settings.minutes;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_MINUTES;
}

export const stalledHeuristic: Heuristic = {
  id: 'stalled',
  // Every kind, not a subset: any new event should promptly clear an active
  // "stalled" finding on the push path, rather than waiting up to
  // POLL_INTERVAL_MS for the next timer tick to notice activity resumed.
  appliesTo: ['tool_call', 'edit', 'turn_start', 'turn_stop', 'user_prompt', 'compaction'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const latestTs = ctx.store.latestTs();
    if (!latestTs) return [];

    const thresholdMs = minutesSetting(ctx.settings) * 60_000;
    const elapsedMs = new Date(ctx.now).getTime() - new Date(latestTs).getTime();
    if (elapsedMs < thresholdMs) return [];

    return [
      {
        heuristicId: 'stalled',
        severity: 'warn',
        summary: `No activity for ${Math.round(elapsedMs / 60_000)} minutes`,
        eventRefs: [],
        detectedAt: ctx.now,
      },
    ];
  },
};
