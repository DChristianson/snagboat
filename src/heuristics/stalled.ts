import { currentTurnsIn } from '../core/turns';
import { Heuristic, Finding, HeuristicContext } from './types';
import { positiveNumberOr } from './settings';

const DEFAULT_MINUTES = 15;
const DEFAULT_MAX_MINUTES = 180;

/**
 * An open turn (prompted, not yet finished) with no agent activity for a
 * while: the agent is stuck, or waiting on something. A finished turn going
 * quiet is just you being away, so it never fires. Turns quiet for longer than
 * maxMinutes are treated as abandoned (an agent that was closed mid-turn never
 * records a turn end).
 */
export const stalledHeuristic: Heuristic = {
  id: 'stalled',
  // Every kind, not a subset: any new event should promptly clear an active
  // "stalled" finding on the push path, rather than waiting up to
  // POLL_INTERVAL_MS for the next timer tick to notice activity resumed.
  appliesTo: ['tool_call', 'edit', 'turn_start', 'turn_stop', 'user_prompt', 'compaction'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const minMs = positiveNumberOr(ctx.settings.minutes, DEFAULT_MINUTES) * 60_000;
    const maxMs = positiveNumberOr(ctx.settings.maxMinutes, DEFAULT_MAX_MINUTES) * 60_000;
    const now = Date.parse(ctx.now);
    const findings: Finding[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      if (!turn.open || !turn.endsRecorded) continue;
      const idleMs = now - Date.parse(turn.lastActivityTs);
      if (idleMs < minMs || idleMs > maxMs) continue;
      findings.push({
        heuristicId: 'stalled',
        severity: 'warn',
        summary: `No agent activity for ${Math.round(idleMs / 60_000)} minutes in an unfinished turn`,
        eventRefs: [turn.promptEventId],
        suggestedAction: 'Check whether the agent is waiting for permission or input, or is stuck.',
        detectedAt: ctx.now,
      });
    }
    return findings;
  },
};
