import { FindingInput } from '@snagboat/schema';
import { ReplayEpisode } from './replay';

/** A finding reported now, as the live engine (or the core) reports it. */
export interface LiveFinding {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
}

/**
 * A session's findings: its replayed episodes plus the live findings. A
 * replayed episode still reporting at the end that shares events with a live
 * finding of the same heuristic is that finding, so it shows once, as active.
 * Muted heuristics are left out. Shared by VS Code's Sessions tab and the
 * core's session pages, so both show a session's findings the same way.
 */
export function sessionFindings(episodes: ReplayEpisode[], live: LiveFinding[], muted: Iterable<string> = []): FindingInput[] {
  const mutedSet = new Set(muted);
  const active = live.filter((f) => !mutedSet.has(f.heuristicId));
  const out: FindingInput[] = [];
  const matched = new Set<LiveFinding>();
  for (const ep of episodes) {
    if (mutedSet.has(ep.heuristicId)) continue;
    const refs = new Set(ep.eventRefs);
    const match = ep.open ? active.find((f) => !matched.has(f) && f.heuristicId === ep.heuristicId && f.eventRefs.some((r) => refs.has(r))) : undefined;
    if (match) matched.add(match);
    out.push({
      heuristicId: ep.heuristicId,
      severity: match?.severity ?? ep.severity,
      summary: match?.summary ?? ep.summary,
      eventRefs: match ? [...new Set([...ep.eventRefs, ...match.eventRefs])] : ep.eventRefs,
      startTs: ep.startTs,
      endTs: ep.endTs,
      active: !!match,
    });
  }
  for (const f of active) if (!matched.has(f)) out.push({ ...f, active: true });
  return out;
}
