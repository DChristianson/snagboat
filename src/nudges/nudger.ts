import { Finding, Progress } from '../heuristics/types';

/**
 * Live nudges: which findings and early warnings are worth interrupting you
 * for, as dismissible notifications. Rate-limited: one per episode (a
 * heuristic reporting, until it stops), one early warning per heuristic and
 * turn, and at most one nudge per turn whatever fires. See
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

  constructor(private readonly locate: Locate) {}

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
      if (turnKey) remember(this.turns, turnKey);
      out.push({ heuristicId: id, severity: worst.severity, early: false, summary: worst.summary, ...(worst.suggestedAction ? { suggestedAction: worst.suggestedAction } : {}), eventRefs: worst.eventRefs, ...where });
    }

    for (const p of progress) {
      if (s.notify === 'off' || s.quiet.includes(p.heuristicId) || s.muted.includes(p.heuristicId) || active.get(p.heuristicId)?.length) continue;
      const where = this.locate(p.eventRefs);
      const turnKey = where?.turnId ? `${where.sessionId}:${where.turnId}` : undefined;
      const earlyKey = `${p.heuristicId}|${turnKey ?? ''}`;
      if (this.early.has(earlyKey) || (turnKey && this.turns.has(turnKey))) continue;
      remember(this.early, earlyKey);
      if (turnKey) remember(this.turns, turnKey);
      out.push({ heuristicId: p.heuristicId, severity: 'info', early: true, summary: p.summary, eventRefs: p.eventRefs, ...where });
    }
    return out;
  }
}
