import { currentTurnsIn, modelCalls } from '../core/turns';
import { Heuristic, Finding, HeuristicContext } from './types';
import { compactTokens, positiveNumberOr } from './settings';

const DEFAULT_MIN_TOKENS = 50_000;
const DEFAULT_MIN_CALLS = 2;
/** Anthropic's default prompt-cache lifetime; a rebuild after a gap this long is just expiry. */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Within one turn, the main agent repeatedly rewriting most of its context to
 * the prompt cache instead of reading it back: something keeps changing early
 * in the prompt, so every call pays full price. A rebuild right after a pause
 * longer than the cache lifetime, or after a compaction, is expected and not
 * counted. Never seen in your own history, so it fires only on a real problem.
 */
export const cacheThrashHeuristic: Heuristic = {
  id: 'cache-thrash',
  appliesTo: ['turn_stop', 'user_prompt'],
  onlyChangesWithEvents: true,

  evaluate(ctx: HeuristicContext): Finding[] {
    const minTokens = positiveNumberOr(ctx.settings.minTokens, DEFAULT_MIN_TOKENS);
    const minCalls = positiveNumberOr(ctx.settings.minCalls, DEFAULT_MIN_CALLS);
    const findings: Finding[] = [];
    for (const turn of currentTurnsIn(ctx.store)) {
      const compactionTs = turn.events.filter((e) => e.kind === 'compaction').map((e) => e.ts);
      const calls = modelCalls(turn, true);
      const rebuilds = calls.filter((c, i) => {
        const prev = calls[i - 1];
        if (!prev || Date.parse(c.ts) - Date.parse(prev.ts) >= CACHE_TTL_MS) return false;
        if (compactionTs.some((ts) => ts > prev.ts && ts <= c.ts)) return false;
        const created = c.tokens?.cacheCreation ?? 0;
        return created >= minTokens && created > (c.tokens?.cacheRead ?? 0);
      });
      if (rebuilds.length < minCalls) continue;
      const total = rebuilds.reduce((sum, c) => sum + (c.tokens?.cacheCreation ?? 0), 0);
      findings.push({
        heuristicId: 'cache-thrash',
        severity: 'warn',
        summary: `${rebuilds.length} model calls in this turn rewrote the prompt cache (${compactTokens(total)} tokens) instead of reusing it`,
        eventRefs: [turn.promptEventId, ...rebuilds.map((e) => e.eventId)],
        suggestedAction: 'Something early in the prompt keeps changing (instructions, tool list, or files injected each call).',
        detectedAt: ctx.now,
      });
    }
    return findings;
  },
};
