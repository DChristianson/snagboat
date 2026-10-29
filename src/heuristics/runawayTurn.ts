import { currentTurnsIn, modelCalls } from '../core/turns';
import { Heuristic, Finding, HeuristicContext, Progress } from './types';
import { positiveNumberOr } from './settings';

// Your own history's 99th percentile is around 80 of each per turn.
const DEFAULT_MAX_MODEL_CALLS = 100;
const DEFAULT_MAX_TOOL_CALLS = 100;
const MAX_REFS = 200;
// Warn at 80% of the threshold: tokens are still being spent, so knowing early saves some.
const DEFAULT_EARLY_WARNING = 0.8;

/** The early-warning point as a share of the threshold; 0 (or anything outside 0 to 1) turns it off. */
export function earlyWarningOr(value: unknown, fallback: number): number | undefined {
  const v = typeof value === 'number' ? value : fallback;
  return v > 0 && v < 1 ? v : undefined;
}

/** One prompt driving many model or tool calls without you prompting again. Clears on the next prompt. */
export const runawayTurnHeuristic: Heuristic = {
  id: 'runaway-turn',
  appliesTo: ['turn_stop', 'tool_call', 'user_prompt'],
  onlyChangesWithEvents: true,

  evaluate(ctx: HeuristicContext): Finding[] {
    const maxCalls = positiveNumberOr(ctx.settings.maxModelCalls, DEFAULT_MAX_MODEL_CALLS);
    const maxTools = positiveNumberOr(ctx.settings.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
    const findings: Finding[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      const calls = modelCalls(turn);
      const tools = turn.events.filter((e) => e.kind === 'tool_call');
      if (calls.length < maxCalls && tools.length < maxTools) continue;
      findings.push({
        heuristicId: 'runaway-turn',
        severity: 'warn',
        summary: `One prompt has driven ${calls.length} model calls and ${tools.length} tool calls${turn.open ? ' so far' : ''}`,
        eventRefs: [turn.promptEventId, ...[...calls, ...tools].slice(-MAX_REFS).map((e) => e.eventId)],
        suggestedAction: 'Check the turn is still on track; a narrower prompt may do the job in fewer steps.',
        detectedAt: ctx.now,
      });
    }
    return findings;
  },

  progress(ctx: HeuristicContext): Progress[] {
    const early = earlyWarningOr(ctx.settings.earlyWarning, DEFAULT_EARLY_WARNING);
    if (early === undefined) return [];
    const maxCalls = positiveNumberOr(ctx.settings.maxModelCalls, DEFAULT_MAX_MODEL_CALLS);
    const maxTools = positiveNumberOr(ctx.settings.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
    const out: Progress[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      if (!turn.open) continue;
      const calls = modelCalls(turn).length;
      const tools = turn.events.filter((e) => e.kind === 'tool_call').length;
      if (calls >= maxCalls || tools >= maxTools) continue;
      const [share, what] = calls / maxCalls >= tools / maxTools ? [calls / maxCalls, `${calls} of ${maxCalls} model calls`] : [tools / maxTools, `${tools} of ${maxTools} tool calls`];
      if (share >= early) out.push({ heuristicId: 'runaway-turn', share, summary: `Heading for a runaway turn: ${what}`, eventRefs: [turn.promptEventId] });
    }
    return out;
  },
};
