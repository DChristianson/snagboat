import { ModelContextMarks } from '../core/contextMarks';
import { SessionIndex } from '../core/sessions';
import { NormalizedEvent } from '../core/types';
import { builtInHeuristics } from '../heuristics/builtIns';
import { FindingReplay } from '../heuristics/replay';
import { buildExplorerState, ExplorerState, SessionListPayload } from '../ui/explorerModel';
import { buildSessionView, FindingInput, SessionView } from '../ui/sessionModel';
import { EXPLORE_SESSION_CAP } from '../ui/visualizers';
import { buildMarks } from './marks';

/**
 * The web demo's stand-in for the extension's log, index, context limits,
 * and SessionController, over events held in memory: the session list per
 * day, and the explorer's state for picked ids. A view is built the way
 * SessionController.explore builds one (the session's events in time order,
 * a fresh replay of the built-in heuristics with their default settings, and
 * buildSessionView with the marks and the replay's episodes), without the
 * live findings the extension merges in, since nothing is live here.
 */
export class EventSet {
  readonly index = new SessionIndex();
  readonly marks: Record<string, ModelContextMarks>;
  private readonly bySession = new Map<string, NormalizedEvent[]>();
  private readonly views = new Map<string, SessionView>();

  constructor(readonly events: NormalizedEvent[]) {
    this.marks = buildMarks(events);
    for (const e of events) {
      this.index.ingest(e);
      const list = this.bySession.get(e.sessionId) ?? [];
      list.push(e);
      this.bySession.set(e.sessionId, list);
    }
    for (const list of this.bySession.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** The sessions of a day, as the extension lists them; the day defaults to today, else the newest. */
  list(day?: string, today = new Date().toISOString().slice(0, 10)): SessionListPayload {
    const days = this.index.days();
    const chosen = day ?? (days.includes(today) ? today : days[0] ?? today);
    return { day: chosen, days, sessions: this.index.forDay(chosen), headlines: {} };
  }

  /** The explorer's state for these ids, in order, at most EXPLORE_SESSION_CAP of them. */
  explorerState(picked: string[]): ExplorerState {
    return buildExplorerState([...new Set(picked)].slice(0, EXPLORE_SESSION_CAP), (id) => this.view(id));
  }

  /** The view of a listed session, built once; undefined for an unknown id. */
  view(sessionId: string): SessionView | undefined {
    const cached = this.views.get(sessionId);
    if (cached) return cached;
    const summary = this.index.get(sessionId);
    const events = this.bySession.get(sessionId);
    if (!summary || !events) return undefined;
    const replay = new FindingReplay(builtInHeuristics(), () => ({}), (model) => (model ? this.marks[model]?.limit : undefined));
    for (const e of events) replay.ingest(e);
    const findings: FindingInput[] = replay.episodes().map((ep) => ({ heuristicId: ep.heuristicId, severity: ep.severity, summary: ep.summary, eventRefs: ep.eventRefs, startTs: ep.startTs, endTs: ep.endTs, active: false }));
    const view = buildSessionView(summary, events, this.marks, findings);
    this.views.set(sessionId, view);
    return view;
  }
}
