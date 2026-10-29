import { EventLogReader } from '../core/eventLog';
import { SessionSummary } from '../core/sessions';
import { NormalizedEvent } from '../core/types';
import { FindingReplay } from '../heuristics/replay';
import { DigestFinding, DigestInput } from './digest';

/**
 * A stored session as digest input: its events from the days it spans, and
 * its findings from replaying them through the heuristics in use.
 */
export async function sessionDigestInput(
  summary: SessionSummary,
  log: EventLogReader,
  replay: FindingReplay,
  extra: Pick<DigestInput, 'roots' | 'contextLimit' | 'turnId'> & { sessionName?: string }
): Promise<DigestInput> {
  const events: NormalizedEvent[] = [];
  for (const day of summary.days) for (const e of await log.readDay(day)) if (e.sessionId === summary.sessionId) events.push(e);
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  for (const e of events) replay.ingest(e);
  const findings: DigestFinding[] = replay.episodes().map((e) => ({ heuristicId: e.heuristicId, severity: e.severity, summary: e.summary, startTs: e.startTs, endTs: e.endTs, eventRefs: e.eventRefs }));
  return { sessionId: summary.sessionId, events, findings, ...extra };
}
