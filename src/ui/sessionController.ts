import { ModelContextMarks } from '../core/contextLimits';
import { EventLog } from '../core/eventLog';
import { SessionIndex, SessionSummary } from '../core/sessions';
import { NormalizedEvent } from '../core/types';
import { buildSessionView, SessionView } from './sessionModel';

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

/**
 * Serves the Sessions tab: the session list per day, and one open session's
 * view. The open session's events are loaded once from its days' raw files
 * and then kept current from live events, so updates never re-read files.
 */
export class SessionController {
  private openId?: string;
  private openEvents: NormalizedEvent[] = [];
  private openSeen = new Set<string>();

  constructor(
    private readonly index: SessionIndex,
    private readonly eventLog: EventLog,
    private readonly marks: () => Record<string, ModelContextMarks>,
    private readonly findings: () => FindingLike[]
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
    this.openId = sessionId;
    this.openEvents = events;
    this.openSeen = new Set(events.map((e) => e.eventId));
    return this.view();
  }

  close(): void {
    this.openId = undefined;
    this.openEvents = [];
    this.openSeen.clear();
  }

  get openSessionId(): string | undefined {
    return this.openId;
  }

  /** Keeps the open session current; returns true if the event belonged to it. */
  ingest(event: NormalizedEvent): boolean {
    if (!this.openId || event.sessionId !== this.openId || this.openSeen.has(event.eventId)) return false;
    this.openSeen.add(event.eventId);
    this.openEvents.push(event);
    return true;
  }

  view(): SessionView | undefined {
    if (!this.openId) return undefined;
    const summary = this.index.get(this.openId);
    return summary ? buildSessionView(summary, this.openEvents, this.marks(), this.findings()) : undefined;
  }
}
