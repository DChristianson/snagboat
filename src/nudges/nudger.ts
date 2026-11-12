import { Finding, Progress } from '../heuristics/types';

/**
 * Live nudges: which findings and early warnings are worth interrupting you
 * for, as dismissible notifications. Rate-limited: one per episode (a
 * heuristic reporting, until it stops), one early warning per heuristic and
 * turn, and at most one nudge per turn whatever fires; and each advisor's
 * notify.max_per_hour over the heuristics it speaks for. See
 * docs/design/trusted-advisor.md#live-nudges.
 */

/** Which findings notify: none (the default), warnings only, or all. Early warnings notify unless it's off. */
export type NotifyLevel = 'off' | 'warnings' | 'all';

export interface NudgeSettings {
  notify: NotifyLevel;
  /** Heuristics that never notify. */
  quiet: string[];
  /** Muted heuristics never notify either. */
  muted: string[];
  /**
   * Advisors' notify limits (persona.md front matter, RFC step 4c): the
   * heuristics or rules each speaks for, and at most how many of their
   * notifications an hour. A heuristic no advisor lists has no such limit;
   * one listed by two goes by the first.
   */
  limits?: AdvisorLimit[];
}

export interface AdvisorLimit {
  advisor: string;
  rules: string[];
  maxPerHour?: number;
}

export interface Nudge {
  heuristicId: string;
  severity: 'info' | 'warn';
  /** An early warning, before the heuristic fires. */
  early: boolean;
  summary: string;
  suggestedAction?: string;
  eventRefs: string[];
  /** Where it happened, when that's one session's turn. */
  sessionId?: string;
  turnId?: string;
  /** The advisor whose notify rules it falls under. */
  advisor?: string;
}

/** The session and turn a finding's events belong to, if they're one turn's. */
export type Locate = (eventRefs: string[]) => { sessionId: string; turnId?: string } | undefined;

const MAX_REMEMBERED = 500;

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value as string);
}

export class Nudger {
  /** Heuristics whose current episode has been considered, nudged or not. */
  private episodes = new Set<string>();
  /** Turns that have had their nudge. */
  private turns = new Set<string>();
  /** Early warnings given, by heuristic and turn. */
  private early = new Set<string>();
  /** When each advisor's notifications were given, for its max_per_hour. */
  private sent = new Map<string, number[]>();

  constructor(private readonly locate: Locate, private readonly now: () => number = Date.now) {}

  /** The advisor a heuristic notifies for, and whether its hourly limit has room; records the use when it has. */
  private take(heuristicId: string, s: NudgeSettings): { ok: boolean; advisor?: string } {
    const limit = s.limits?.find((l) => l.rules.includes(heuristicId));
    if (!limit) return { ok: true };
    if (limit.maxPerHour === undefined) return { ok: true, advisor: limit.advisor };
    const now = this.now();
    const recent = (this.sent.get(limit.advisor) ?? []).filter((t) => now - t < 60 * 60_000);
    if (recent.length >= limit.maxPerHour) {
      this.sent.set(limit.advisor, recent);
      return { ok: false, advisor: limit.advisor };
    }
    this.sent.set(limit.advisor, [...recent, now]);
    return { ok: true, advisor: limit.advisor };
  }

  /**
   * The advisor a heuristic notifies for, and whether its hourly limit is used up, so its findings
   * are held back from notifying; reads only, unlike take(). For the compact findings panel.
   */
  room(heuristicId: string, s: Pick<NudgeSettings, 'limits'>): { advisor?: string; held: boolean } {
    const limit = s.limits?.find((l) => l.rules.includes(heuristicId));
    if (!limit) return { held: false };
    if (limit.maxPerHour === undefined) return { advisor: limit.advisor, held: false };
    const now = this.now();
    const recent = (this.sent.get(limit.advisor) ?? []).filter((t) => now - t < 60 * 60_000);
    return { advisor: limit.advisor, held: recent.length >= limit.maxPerHour };
  }

  private allowed(heuristicId: string, severity: 'info' | 'warn', s: NudgeSettings): boolean {
    if (s.notify === 'off' || s.quiet.includes(heuristicId) || s.muted.includes(heuristicId)) return false;
    return s.notify === 'all' || severity === 'warn';
  }

  /** Given everything active now, the nudges to show; call after each evaluation. */
  update(active: Map<string, Finding[]>, progress: Progress[], s: NudgeSettings): Nudge[] {
    const out: Nudge[] = [];
    for (const id of [...this.episodes]) if (!active.get(id)?.length) this.episodes.delete(id);

    for (const [id, findings] of active) {
      if (findings.length === 0 || this.episodes.has(id)) continue;
      // An episode is considered once, when it starts: turning notifications on later doesn't replay old ones.
      this.episodes.add(id);
      const worst = findings.find((f) => f.severity === 'warn') ?? findings[0];
      if (!this.allowed(id, worst.severity, s)) continue;
      const where = this.locate(worst.eventRefs);
      const turnKey = where?.turnId ? `${where.sessionId}:${where.turnId}` : undefined;
      if (turnKey && this.turns.has(turnKey)) continue;
      // Over its advisor's hourly limit: this episode passes without a notification (it's considered once).
      const { ok, advisor } = this.take(id, s);
      if (!ok) continue;
      if (turnKey) remember(this.turns, turnKey);
      out.push({ heuristicId: id, severity: worst.severity, early: false, summary: worst.summary, ...(worst.suggestedAction ? { suggestedAction: worst.suggestedAction } : {}), eventRefs: worst.eventRefs, ...where, ...(advisor ? { advisor } : {}) });
    }

    for (const p of progress) {
      if (s.notify === 'off' || s.quiet.includes(p.heuristicId) || s.muted.includes(p.heuristicId) || active.get(p.heuristicId)?.length) continue;
      const where = this.locate(p.eventRefs);
      const turnKey = where?.turnId ? `${where.sessionId}:${where.turnId}` : undefined;
      const earlyKey = `${p.heuristicId}|${turnKey ?? ''}`;
      if (this.early.has(earlyKey) || (turnKey && this.turns.has(turnKey))) continue;
      remember(this.early, earlyKey);
      const { ok, advisor } = this.take(p.heuristicId, s);
      if (!ok) continue;
      if (turnKey) remember(this.turns, turnKey);
      out.push({ heuristicId: p.heuristicId, severity: 'info', early: true, summary: p.summary, eventRefs: p.eventRefs, ...where, ...(advisor ? { advisor } : {}) });
    }
    return out;
  }
}
