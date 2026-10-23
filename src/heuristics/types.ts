import { NormalizedEvent } from '../core/types';
import { ReadonlyEventStore } from '../core/eventStore';

export interface HeuristicContext {
  /** Injected rather than Date.now(), so heuristics are deterministically unit-testable. */
  readonly now: string;
  readonly store: ReadonlyEventStore;
  readonly settings: Record<string, unknown>;
  /** The lowest context limit seen for a model, across workspaces; undefined until one is encountered. */
  readonly contextLimit?: (model: string | undefined) => number | undefined;
}

export interface Heuristic {
  readonly id: string;
  /**
   * Kinds this heuristic cares about. Used only as a cheap prefilter on the
   * push-triggered path (skip re-running a heuristic whose verdict can't have
   * changed) -- the timer-triggered tick always runs every heuristic
   * regardless, since some (e.g. "stalled") depend on the *absence* of events.
   */
  readonly appliesTo: NormalizedEvent['kind'][];
  /**
   * True when the verdict depends only on the stored events, not on the
   * current time, so it can't change between events. Lets a replay skip
   * re-running it on timer ticks.
   */
  readonly onlyChangesWithEvents?: boolean;
  evaluate(ctx: HeuristicContext): Finding[];
}

export interface Finding {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
  suggestedAction?: string;
  /** When this finding was produced -- needed to break ties when picking the "worst" finding. */
  detectedAt: string;
}
