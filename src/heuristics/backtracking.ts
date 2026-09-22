import { Heuristic, Finding, HeuristicContext } from './types';
import { NormalizedEvent } from '../core/types';

const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_MIN_REPEATS = 3;

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

export const backtrackingHeuristic: Heuristic = {
  id: 'backtracking',
  appliesTo: ['edit', 'tool_call'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const windowMinutes = positiveNumberOr(ctx.settings.window, DEFAULT_WINDOW_MINUTES);
    const minRepeats = positiveNumberOr(ctx.settings.minRepeats, DEFAULT_MIN_REPEATS);

    const since = new Date(new Date(ctx.now).getTime() - windowMinutes * 60_000).toISOString();
    const events = ctx.store.query({ since, kinds: ['edit', 'tool_call'] });

    const byTarget = new Map<string, NormalizedEvent[]>();
    for (const event of events) {
      if (!event.target) continue; // no target means nothing to group repeats by
      const group = byTarget.get(event.target) ?? [];
      group.push(event);
      byTarget.set(event.target, group);
    }

    const findings: Finding[] = [];
    for (const [target, group] of byTarget) {
      if (group.length < minRepeats) continue;

      // group is in ascending ts order, since query() preserves that order.
      const first = group[0];
      const last = group[group.length - 1];
      const hadInterveningSuccess = group.some((e) => e !== first && e !== last && e.status === 'success');
      if (hadInterveningSuccess) continue; // legitimate iteration, not looping

      findings.push({
        heuristicId: 'backtracking',
        severity: 'warn',
        summary: `${target} touched ${group.length} times in the last ${windowMinutes} minutes with no success in between`,
        eventRefs: group.map((e) => e.eventId),
        suggestedAction: `Review recent changes to ${target}`,
        detectedAt: ctx.now,
      });
    }

    return findings;
  },
};
