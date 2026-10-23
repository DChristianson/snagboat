import { ModelContextMarks } from '../core/contextLimits';
import { EventLog } from '../core/eventLog';
import { SessionIndex, SessionSummary } from '../core/sessions';
import { NormalizedEvent } from '../core/types';
import { FindingReplay } from '../heuristics/replay';
import { buildSessionView, FindingInput, SessionView } from './sessionModel';

export interface SessionListPayload {
  day: string;
  /** Days with sessions, newest first, for the day picker. */
  days: string[];
  sessions: SessionSummary[];
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

/**
 * Serves the Sessions tab: the session list per day, and one open session's
 * view. The open session's events are loaded once from its days' raw files
 * and then kept current from live events, so updates never re-read files.
 * Past findings come from replaying the session's events through the
 * heuristics once on open, then feeding the replay each live event.
 */
export class SessionController {
  private openId?: string;
  private openEvents: NormalizedEvent[] = [];
  private openSeen = new Set<string>();
  private replay?: FindingReplay;

  constructor(
    private readonly index: SessionIndex,
    private readonly eventLog: EventLog,
    private readonly marks: () => Record<string, ModelContextMarks>,
    private readonly findings: SessionFindingSources
  ) {}

  list(day: string | undefined, today: string): SessionListPayload {
    const days = this.index.days();
    const chosen = day ?? (days.includes(today) ? today : days[0] ?? today);
    return { day: chosen, days, sessions: this.index.forDay(chosen) };
  }

  /** Loads a session's events from its days' raw files; undefined if it's unknown or no longer retained. */
  async open(sessionId: string): Promise<SessionView | undefined> {
    const summary = this.index.get(sessionId);
    if (!summary) return undefined;
    await this.eventLog.flush(); // include appends still queued
    const events: NormalizedEvent[] = [];
    for (const day of summary.days) for (const e of await this.eventLog.readDay(day)) if (e.sessionId === sessionId) events.push(e);
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    this.openId = sessionId;
    this.openEvents = events;
    this.openSeen = new Set(events.map((e) => e.eventId));
    this.replay = this.findings.newReplay?.();
    for (const e of events) this.replay?.ingest(e);
    return this.view();
  }

  close(): void {
    this.openId = undefined;
    this.openEvents = [];
    this.openSeen.clear();
    this.replay = undefined;
  }

  get openSessionId(): string | undefined {
    return this.openId;
  }

  /** Keeps the open session current; returns true if the event belonged to it. */
  ingest(event: NormalizedEvent): boolean {
    if (!this.openId || event.sessionId !== this.openId || this.openSeen.has(event.eventId)) return false;
    this.openSeen.add(event.eventId);
    this.openEvents.push(event);
    this.replay?.ingest(event);
    return true;
  }

  view(): SessionView | undefined {
    if (!this.openId) return undefined;
    const summary = this.index.get(this.openId);
    return summary ? buildSessionView(summary, this.openEvents, this.marks(), this.sessionFindings()) : undefined;
  }

  /**
   * Replayed episodes plus live findings. A replayed episode still reporting
   * at the end that shares events with a live finding of the same heuristic is
   * that finding, so it shows once, as active.
   */
  private sessionFindings(): FindingInput[] {
    const muted = new Set(this.findings.muted?.() ?? []);
    const active = this.findings.active().filter((f) => !muted.has(f.heuristicId));
    const out: FindingInput[] = [];
    const matched = new Set<FindingLike>();
    for (const ep of this.replay?.episodes() ?? []) {
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
