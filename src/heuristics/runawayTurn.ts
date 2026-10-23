import { currentTurnsIn, modelCalls } from '../core/turns';
import { Heuristic, Finding, HeuristicContext } from './types';
import { positiveNumberOr } from './settings';

// Your own history's 99th percentile is around 80 of each per turn.
const DEFAULT_MAX_MODEL_CALLS = 100;
const DEFAULT_MAX_TOOL_CALLS = 100;
const MAX_REFS = 200;

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
};
