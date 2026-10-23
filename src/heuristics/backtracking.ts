import { currentTurnsIn } from '../core/turns';
import { NormalizedEvent } from '../core/types';
import { Heuristic, Finding, HeuristicContext } from './types';
import { positiveNumberOr } from './settings';

// In your own history, no turn failed 3 times on one target, and 99% of turns edited one file at most 8 times.
const DEFAULT_MIN_FAILURES = 3;
const DEFAULT_MIN_EDITS = 10;

/**
 * Within the current turn, the same target failing repeatedly, or the same
 * file being edited over and over. A success in between doesn't clear it:
 * fix-break-fix loops are the point. Clears on the next prompt.
 */
export const backtrackingHeuristic: Heuristic = {
  id: 'backtracking',
  appliesTo: ['tool_call', 'user_prompt'],
  onlyChangesWithEvents: true,

  evaluate(ctx: HeuristicContext): Finding[] {
    const minFailures = positiveNumberOr(ctx.settings.minFailures, DEFAULT_MIN_FAILURES);
    const minEdits = positiveNumberOr(ctx.settings.minEdits, DEFAULT_MIN_EDITS);
    const findings: Finding[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      const failures = new Map<string, NormalizedEvent[]>();
      const edits = new Map<string, NormalizedEvent[]>();
      for (const e of turn.events) {
        if (e.kind !== 'tool_call' || !e.target) continue;
        if (e.status === 'failure') failures.set(e.target, [...(failures.get(e.target) ?? []), e]);
        if (e.toolCategory === 'file-edit') edits.set(e.target, [...(edits.get(e.target) ?? []), e]);
      }
      for (const [target, group] of failures) {
        if (group.length < minFailures) continue;
        findings.push({
          heuristicId: 'backtracking',
          severity: 'warn',
          summary: `${target} failed ${group.length} times in this turn`,
          eventRefs: group.map((e) => e.eventId),
          suggestedAction: `Look at why ${target} keeps failing before the agent tries again`,
          detectedAt: ctx.now,
        });
      }
      for (const [target, group] of edits) {
        if (group.length < minEdits) continue;
        findings.push({
          heuristicId: 'backtracking',
          severity: 'warn',
          summary: `${target} edited ${group.length} times in this turn`,
          eventRefs: group.map((e) => e.eventId),
          suggestedAction: `Review recent changes to ${target}`,
          detectedAt: ctx.now,
        });
      }
    }
    return findings;
  },
};
