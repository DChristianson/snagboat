import { contextSize } from '../core/contextLimits';
import { currentTurnsIn, modelCalls } from '../core/turns';
import { Heuristic, Finding, HeuristicContext, Progress } from './types';
import { earlyWarningOr } from './runawayTurn';
import { compactTokens, positiveNumberOr } from './settings';

// 1 in 10 of your turns peaks above 80%, so 90% keeps this rare.
const DEFAULT_PERCENT = 90;

/**
 * The current turn's context nearing the model's limit (info), or an automatic
 * compaction during it (warn: earlier context was summarized away). The limit
 * is the call's own reported limit, else the lowest seen for the model.
 */
export const contextPressureHeuristic: Heuristic = {
  id: 'context-pressure',
  appliesTo: ['turn_stop', 'compaction', 'user_prompt'],
  onlyChangesWithEvents: true,

  evaluate(ctx: HeuristicContext): Finding[] {
    const percent = Math.min(positiveNumberOr(ctx.settings.percent, DEFAULT_PERCENT), 100);
    const findings: Finding[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      const compactions = turn.events.filter((e) => e.kind === 'compaction' && e.compaction?.trigger === 'auto' && !e.agentId);
      if (compactions.length > 0) {
        const c = compactions[compactions.length - 1].compaction!;
        const sizes = c.preTokens !== undefined && c.postTokens !== undefined ? ` from ${compactTokens(c.preTokens)} to ${compactTokens(c.postTokens)} tokens` : '';
        findings.push({
          heuristicId: 'context-pressure',
          severity: 'warn',
          summary: `Context was compacted automatically${sizes} during this turn`,
          eventRefs: [turn.promptEventId, ...compactions.map((e) => e.eventId)],
          suggestedAction: 'Earlier details were summarized; restate anything the agent still needs, or start a fresh session.',
          detectedAt: ctx.now,
        });
        continue;
      }
      const last = modelCalls(turn, true).pop();
      const size = last && contextSize(last);
      const limit = last && (last.contextLimit ?? ctx.contextLimit?.(last.model));
      if (!last || !size || !limit || size < (limit * percent) / 100) continue;
      findings.push({
        heuristicId: 'context-pressure',
        severity: 'info',
        summary: `Context is at ${Math.round((100 * size) / limit)}% of the limit (${compactTokens(size)} of ${compactTokens(limit)})`,
        eventRefs: [turn.promptEventId, last.eventId],
        suggestedAction: 'Compaction is near; consider wrapping up this thread or starting a fresh session.',
        detectedAt: ctx.now,
      });
    }
    return findings;
  },

  progress(ctx: HeuristicContext): Progress[] {
    // Warn at 80% of the threshold (72% of the limit by default): compaction is coming.
    const early = earlyWarningOr(ctx.settings.earlyWarning, 0.8);
    if (early === undefined) return [];
    const percent = Math.min(positiveNumberOr(ctx.settings.percent, DEFAULT_PERCENT), 100);
    const out: Progress[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      if (!turn.open || turn.events.some((e) => e.kind === 'compaction' && e.compaction?.trigger === 'auto' && !e.agentId)) continue;
      const last = modelCalls(turn, true).pop();
      const size = last && contextSize(last);
      const limit = last && (last.contextLimit ?? ctx.contextLimit?.(last.model));
      if (!last || !size || !limit) continue;
      const share = (100 * size) / limit / percent;
      if (share >= early && share < 1) out.push({ heuristicId: 'context-pressure', share, summary: `Heading for compaction: context is at ${Math.round((100 * size) / limit)}% of the limit`, eventRefs: [turn.promptEventId, last.eventId] });
    }
    return out;
  },
};
