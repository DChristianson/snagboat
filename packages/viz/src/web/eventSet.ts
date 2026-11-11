import { ModelContextMarks } from '@snagboat/schema';
import { SessionIndex } from '@snagboat/schema';
import { NormalizedEvent } from '@snagboat/schema';
import { buildExplorerState, byNewestStart, ExploreSessionList, ExplorerState } from '../explorerModel';
import { buildSessionView, FindingInput, SessionView } from '@snagboat/schema';
import { EXPLORE_SESSION_CAP } from '../catalog';
import { buildMarks } from './marks';

/** A session's findings from its events (in time order) and the context marks. */
export type FindingsFor = (events: NormalizedEvent[], marks: Record<string, ModelContextMarks>) => FindingInput[];

const noFindings: FindingsFor = () => [];

/**
 * The web demo's stand-in for the extension's log, index, context limits,
 * and SessionController, over events held in memory: the session list, and the explorer's state for picked ids. A view is built the way
 * SessionController.explore builds one (the session's events in time order,
 * the findings for them, and buildSessionView with the marks and those
 * findings), without the live findings the extension merges in, since
 * nothing is live here. The findings come from the host: Snagboat's build of
 * the page replays its built-in heuristics (Snagboat's src/web/findings.ts); without
 * one, views have no findings.
 */
export class EventSet {
  readonly index = new SessionIndex();
  readonly marks: Record<string, ModelContextMarks>;
  private readonly bySession = new Map<string, NormalizedEvent[]>();
  private readonly views = new Map<string, SessionView>();

  constructor(readonly events: NormalizedEvent[], private readonly findingsFor: FindingsFor = noFindings) {
    this.marks = buildMarks(events);
    for (const e of events) {
      this.index.ingest(e);
      const list = this.bySession.get(e.sessionId) ?? [];
      list.push(e);
      this.bySession.set(e.sessionId, list);
    }
    for (const list of this.bySession.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** Every session for the picker, as the extension lists them: newest start first. */
  listAll(): ExploreSessionList {
    return { sessions: byNewestStart(this.index.list()), headlines: {} };
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
    const findings = this.findingsFor(events, this.marks);
    const view = buildSessionView(summary, events, this.marks, findings);
    this.views.set(sessionId, view);
    return view;
  }
}
