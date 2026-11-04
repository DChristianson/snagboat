import { marksFromEvent, mergeMarks, ModelContextMarks } from '../core/contextMarks';
import { NormalizedEvent } from '../core/types';

/**
 * Context marks built in memory from loaded events, by the rules ContextLimits
 * applies on disk: per model, the largest context seen always, and a limit
 * only where one was met (an automatic compaction's size before, or a limit
 * the source reported with the call), the lowest winning.
 */
export function buildMarks(events: NormalizedEvent[]): Record<string, ModelContextMarks> {
  const marks: Record<string, ModelContextMarks> = {};
  for (const event of events) {
    const found = marksFromEvent(event);
    if (found) marks[found.model] = mergeMarks(marks[found.model] ?? {}, found.marks);
  }
  return marks;
}
