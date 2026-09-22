import { Heuristic, Finding, HeuristicContext } from './types';

const DEFAULT_WINDOW_MINUTES = 5;
const DEFAULT_MIN_CALLS = 8;
const DEFAULT_MAX_DISTINCT_TARGETS = 2;

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

export const toolChurnHeuristic: Heuristic = {
  id: 'tool-churn',
  appliesTo: ['tool_call'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const windowMinutes = positiveNumberOr(ctx.settings.window, DEFAULT_WINDOW_MINUTES);
    const minCalls = positiveNumberOr(ctx.settings.minCalls, DEFAULT_MIN_CALLS);
    const maxDistinctTargets = positiveNumberOr(ctx.settings.maxDistinctTargets, DEFAULT_MAX_DISTINCT_TARGETS);

    const since = new Date(new Date(ctx.now).getTime() - windowMinutes * 60_000).toISOString();
    const calls = ctx.store.query({ since, kinds: ['tool_call'] });
    if (calls.length < minCalls) return [];

    const distinctTargets = new Set(calls.map((e) => e.target ?? '(no target)'));
    if (distinctTargets.size > maxDistinctTargets) return [];

    return [
      {
        heuristicId: 'tool-churn',
        severity: 'warn',
        summary: `${calls.length} tool calls in the last ${windowMinutes} minutes against only ${distinctTargets.size} target(s)`,
        eventRefs: calls.map((e) => e.eventId),
        detectedAt: ctx.now,
      },
    ];
  },
};
