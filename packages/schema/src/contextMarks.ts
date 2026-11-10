import { NormalizedEvent } from './types';

/**
 * The context marks and the rules that set them, with nothing of disk in
 * them: ContextLimits keeps these per model in global storage, and the web
 * demo builds them in memory from the events it loads.
 */

/**
 * Two live marks per model (see docs/design/conversation-view.md):
 * - largestSeen: the biggest context any call to the model has sent;
 * - limit: set only when a limit is actually encountered: an automatic
 *   compaction (its preTokens), or a limit the source reports with the call
 *   (Copilot's maxPromptTokens / max_prompt_tokens). The lowest value wins.
 *   Manual compactions don't count: you chose when they happened.
 */
export interface ModelContextMarks {
  largestSeen?: number;
  largestSeenAt?: string;
  limit?: number;
  limitAt?: string;
  limitSource?: 'auto-compaction' | 'reported';
}

/** Context sent by a model call: everything it read, cached or fresh. */
export function contextSize(event: NormalizedEvent): number | undefined {
  const t = event.tokens;
  if (!t) return undefined;
  const size = (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreation ?? 0);
  return size > 0 ? size : undefined;
}

/** Folds b into a: keeps the larger largestSeen and the smaller limit. */
export function mergeMarks(a: ModelContextMarks, b: ModelContextMarks): ModelContextMarks {
  const out: ModelContextMarks = { ...a };
  if (b.largestSeen !== undefined && (out.largestSeen === undefined || b.largestSeen > out.largestSeen)) {
    out.largestSeen = b.largestSeen;
    out.largestSeenAt = b.largestSeenAt;
  }
  if (b.limit !== undefined && (out.limit === undefined || b.limit < out.limit)) {
    out.limit = b.limit;
    out.limitAt = b.limitAt;
    out.limitSource = b.limitSource;
  }
  return out;
}

/**
 * What one event says about its model's marks: a model call's context size
 * (and a reported limit), or an automatic compaction's size before. Nothing
 * for other events, calls without a model, or the synthetic model.
 */
export function marksFromEvent(event: NormalizedEvent): { model: string; marks: ModelContextMarks } | undefined {
  const model = event.model;
  if (!model || model === '<synthetic>') return undefined;
  let marks: ModelContextMarks | undefined;
  if (event.kind === 'turn_stop') {
    const size = contextSize(event);
    if (size !== undefined) marks = { largestSeen: size, largestSeenAt: event.ts };
    if (event.contextLimit) marks = { ...marks, limit: event.contextLimit, limitAt: event.ts, limitSource: 'reported' };
  } else if (event.kind === 'compaction' && event.compaction?.trigger === 'auto' && event.compaction.preTokens) {
    marks = { limit: event.compaction.preTokens, limitAt: event.ts, limitSource: 'auto-compaction' };
  }
  return marks ? { model, marks } : undefined;
}
