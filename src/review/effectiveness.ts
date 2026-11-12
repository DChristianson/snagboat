import { NormalizedEvent } from '@snagboat/schema';
import { FindingReplay, ReplayEpisode } from '../heuristics/replay';
import { ResponseEpisode, ResponseStats, responseStats } from '../heuristics/responses';
import { Heuristic } from '../heuristics/types';

/**
 * How each heuristic and rule did over a window: episodes replayed from the
 * log with the current settings, and what the person did about them when
 * they were live (acknowledged, muted, or let them expire). The review
 * reports it, and propose-heuristics reads it to judge what to retire or
 * re-threshold.
 */

export interface EffectivenessRow {
  id: string;
  episodes: number;
  warnings: number;
  /** Sessions it fired in. */
  sessions: number;
  /** Recorded responses, where any exist for it. */
  response?: ResponseStats;
  /** Muted in this workspace now. */
  muted: boolean;
}

export interface Effectiveness {
  rows: EffectivenessRow[];
  /** Every replayed episode, session by session. */
  episodes: ReplayEpisode[];
  responses: Map<string, ResponseStats>;
}

export function heuristicEffectiveness(
  events: NormalizedEvent[],
  heuristics: Heuristic[],
  settingsFor: (id: string) => Record<string, unknown>,
  contextLimit: ((model: string | undefined) => number | undefined) | undefined,
  responseEpisodes: ResponseEpisode[],
  muted: string[]
): Effectiveness {
  // Each session replayed through the heuristics in use, as the live engine would have run them.
  const sessionEvents = new Map<string, NormalizedEvent[]>();
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) sessionEvents.set(e.sessionId, [...(sessionEvents.get(e.sessionId) ?? []), e]);
  const episodes: ReplayEpisode[] = [];
  const episodeSessions = new Map<string, Set<string>>();
  for (const [sessionId, list] of sessionEvents) {
    const replay = new FindingReplay(heuristics, settingsFor, contextLimit);
    for (const e of list) replay.ingest(e);
    for (const ep of replay.episodes()) {
      episodes.push(ep);
      episodeSessions.set(ep.heuristicId, new Set([...(episodeSessions.get(ep.heuristicId) ?? []), sessionId]));
    }
  }
  const responses = responseStats(responseEpisodes);
  const fired = new Map<string, { episodes: number; warnings: number }>();
  for (const ep of episodes) {
    const f = fired.get(ep.heuristicId) ?? { episodes: 0, warnings: 0 };
    f.episodes += 1;
    if (ep.severity === 'warn') f.warnings += 1;
    fired.set(ep.heuristicId, f);
  }
  const rows = [...new Set([...fired.keys(), ...responses.keys()])]
    .map((id) => ({ id, episodes: fired.get(id)?.episodes ?? 0, warnings: fired.get(id)?.warnings ?? 0, sessions: episodeSessions.get(id)?.size ?? 0, response: responses.get(id), muted: muted.includes(id) }))
    .sort((a, b) => b.episodes - a.episodes);
  return { rows, episodes, responses };
}
