import { FindingInput, ModelContextMarks, NormalizedEvent } from '@snagboat/schema';
import { builtInHeuristics } from '../heuristics/builtIns';
import { FindingReplay } from '../heuristics/replay';

/**
 * Snagboat's findings for the web page's sessions (the FindingsFor that
 * factory-clock/web's EventSet takes): a fresh replay of the built-in
 * heuristics with their default settings over one session's events, as
 * SessionController.explore does, as ended episodes, since nothing is live.
 */
export function replayFindings(events: NormalizedEvent[], marks: Record<string, ModelContextMarks>): FindingInput[] {
  const replay = new FindingReplay(builtInHeuristics(), () => ({}), (model) => (model ? marks[model]?.limit : undefined));
  for (const e of events) replay.ingest(e);
  return replay.episodes().map((ep) => ({ heuristicId: ep.heuristicId, severity: ep.severity, summary: ep.summary, eventRefs: ep.eventRefs, startTs: ep.startTs, endTs: ep.endTs, active: false }));
}
