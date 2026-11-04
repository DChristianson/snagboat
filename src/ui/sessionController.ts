import { ModelContextMarks } from '../core/contextLimits';
import { EventLog } from '../core/eventLog';
import { SessionIndex, SessionSummary } from '../core/sessions';
import { NormalizedEvent } from '../core/types';
import { FindingReplay } from '../heuristics/replay';
import { buildExplorerState, ExplorerState } from './explorerModel';
import { buildSessionView, FindingInput, SessionView } from './sessionModel';
import { EXPLORE_SESSION_CAP } from './visualizers';

export interface SessionListPayload {
  day: string;
  /** Days with sessions, newest first, for the day picker. */
  days: string[];
  sessions: SessionSummary[];
  /** The advisor's headline per session, where there is one (model output). */
  headlines: Record<string, string>;
}

export interface SessionExtras {
  /** The advisor's headline for a session, when headlines are on. */
  headline?: (sessionId: string) => string | undefined;
}

interface FindingLike {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
}

export interface SessionFindingSources {
  /** Findings the live engine is reporting now. */
  active: () => FindingLike[];
  /** A fresh replay of the heuristics, with current settings, to find past findings; omit to show active ones only. */
  newReplay?: () => FindingReplay;
  /** Heuristics muted in this workspace, left out of the view. */
  muted?: () => string[];
}

interface LoadedSession {
  events: NormalizedEvent[];
  seen: Set<string>;
  replay?: FindingReplay;
}

/**
 * Serves the Sessions tab and the Explore tab: the session list per day, the
 * Sessions tab's one open session, and the explorer's small set. Each loaded
 * session's events are read once from its days' raw files and then kept
 * current from live events, so updates never re-read files. Past findings
 * come from replaying the session's events through the heuristics once on
 * load, then feeding that replay each live event. The open session and the
 * explore set share one map, so a session in both is loaded once, and
 * changing either set never evicts a member of the other.
 */
export class SessionController {
  private readonly loaded = new Map<string, LoadedSession>();
  private openId?: string;
  private exploreIds: string[] = [];

  constructor(
    private readonly index: SessionIndex,
    private readonly eventLog: EventLog,
    private readonly marks: () => Record<string, ModelContextMarks>,
    private readonly findings: SessionFindingSources,
    private readonly extras: SessionExtras = {}
  ) {}

  list(day: string | undefined, today: string): SessionListPayload {
    const days = this.index.days();
    const chosen = day ?? (days.includes(today) ? today : days[0] ?? today);
    const sessions = this.index.forDay(chosen);
    const headlines: Record<string, string> = {};
    for (const s of sessions) {
      const h = this.extras.headline?.(s.sessionId);
      if (h) headlines[s.sessionId] = h;
    }
    return { day: chosen, days, sessions, headlines };
  }

  /**
   * Opens a session for the Sessions tab, (re)loading its events from its
   * days' raw files; undefined if it's unknown or no longer retained. The
   * previously open session stays loaded only if the explorer has it.
   */
  async open(sessionId: string): Promise<SessionView | undefined> {
    const loaded = await this.load(sessionId);
    if (!loaded) return undefined;
    const previous = this.openId;
    this.openId = sessionId;
    if (previous && previous !== sessionId) this.evict(previous);
    return this.view();
  }

  close(): void {
    const previous = this.openId;
    this.openId = undefined;
    if (previous) this.evict(previous);
  }

  get openSessionId(): string | undefined {
    return this.openId;
  }

  /**
   * Sets the explore set to these ids, in order, at most EXPLORE_SESSION_CAP
   * of them. Ids not loaded yet are read from their days' files the way
   * open() reads; ones already loaded (including the open session) aren't
   * re-read. Sessions no longer in either set are evicted. Unknown ids stay
   * in the set and show up in the state as not loaded.
   */
  async explore(sessionIds: string[]): Promise<ExplorerState> {
    const ids = [...new Set(sessionIds)].slice(0, EXPLORE_SESSION_CAP);
    for (const id of ids) if (!this.loaded.has(id)) await this.load(id);
    const previous = this.exploreIds;
    this.exploreIds = ids;
    for (const id of previous) if (!ids.includes(id)) this.evict(id);
    return this.explorerState();
  }

  /** The explore set, in picked order, with a view for each loaded session. */
  explorerState(): ExplorerState {
    return buildExplorerState(this.exploreIds, (id) => this.viewOf(id));
  }

  get exploredSessionIds(): string[] {
    return [...this.exploreIds];
  }

  closeExplorer(): void {
    const previous = this.exploreIds;
    this.exploreIds = [];
    for (const id of previous) this.evict(id);
  }

  /** Keeps every loaded session current; returns true if the event belonged to one of them. */
  ingest(event: NormalizedEvent): boolean {
    const session = this.loaded.get(event.sessionId);
    if (!session || session.seen.has(event.eventId)) return false;
    session.seen.add(event.eventId);
    session.events.push(event);
    session.replay?.ingest(event);
    return true;
  }

  /** The Sessions tab's open session. */
  view(): SessionView | undefined {
    return this.openId ? this.viewOf(this.openId) : undefined;
  }

  /** Reads a session's events from its days' raw files and replays them; undefined if it's unknown or no longer retained. */
  private async load(sessionId: string): Promise<LoadedSession | undefined> {
    const summary = this.index.get(sessionId);
    if (!summary) return undefined;
    await this.eventLog.flush(); // include appends still queued
    const events: NormalizedEvent[] = [];
    for (const day of summary.days) for (const e of await this.eventLog.readDay(day)) if (e.sessionId === sessionId) events.push(e);
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    const replay = this.findings.newReplay?.();
    for (const e of events) replay?.ingest(e);
    const loaded: LoadedSession = { events, seen: new Set(events.map((e) => e.eventId)), replay };
    this.loaded.set(sessionId, loaded);
    return loaded;
  }

  /** Drops a session's events unless the other tab still has it. */
  private evict(sessionId: string): void {
    if (sessionId === this.openId || this.exploreIds.includes(sessionId)) return;
    this.loaded.delete(sessionId);
  }

  private viewOf(sessionId: string): SessionView | undefined {
    const session = this.loaded.get(sessionId);
    const summary = this.index.get(sessionId);
    if (!session || !summary) return undefined;
    const headline = this.extras.headline?.(sessionId);
    return { ...buildSessionView(summary, session.events, this.marks(), this.sessionFindings(session.replay)), ...(headline ? { headline } : {}) };
  }

  /**
   * Replayed episodes plus live findings. A replayed episode still reporting
   * at the end that shares events with a live finding of the same heuristic is
   * that finding, so it shows once, as active.
   */
  private sessionFindings(replay: FindingReplay | undefined): FindingInput[] {
    const muted = new Set(this.findings.muted?.() ?? []);
    const active = this.findings.active().filter((f) => !muted.has(f.heuristicId));
    const out: FindingInput[] = [];
    const matched = new Set<FindingLike>();
    for (const ep of replay?.episodes() ?? []) {
      if (muted.has(ep.heuristicId)) continue;
      const refs = new Set(ep.eventRefs);
      const live = ep.open ? active.find((f) => !matched.has(f) && f.heuristicId === ep.heuristicId && f.eventRefs.some((r) => refs.has(r))) : undefined;
      if (live) matched.add(live);
      out.push({
        heuristicId: ep.heuristicId,
        severity: live?.severity ?? ep.severity,
        summary: live?.summary ?? ep.summary,
        eventRefs: live ? [...new Set([...ep.eventRefs, ...live.eventRefs])] : ep.eventRefs,
        startTs: ep.startTs,
        endTs: ep.endTs,
        active: !!live,
      });
    }
    for (const f of active) if (!matched.has(f)) out.push({ ...f, active: true });
    return out;
  }
}
