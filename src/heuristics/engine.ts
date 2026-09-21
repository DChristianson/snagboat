import { NormalizedEventKind } from '../core/types';
import { ReadonlyEventStore } from '../core/eventStore';
import { Heuristic, Finding } from './types';

export class HeuristicsEngine {
  constructor(
    private readonly heuristics: Heuristic[],
    private readonly store: ReadonlyEventStore,
    private readonly settingsFor: (id: string) => Record<string, unknown>
  ) {}

  /** Runs every heuristic. Used by the timer tick, since some heuristics (e.g. "stalled") depend on the absence of events. */
  tick(now: string): Map<string, Finding[]> {
    return this.runAll(this.heuristics, now);
  }

  /** Runs only heuristics whose appliesTo includes this event kind -- a cheap prefilter for the push-triggered path. */
  tickFor(kind: NormalizedEventKind, now: string): Map<string, Finding[]> {
    return this.runAll(
      this.heuristics.filter((h) => h.appliesTo.includes(kind)),
      now
    );
  }

  private runAll(heuristics: Heuristic[], now: string): Map<string, Finding[]> {
    const results = new Map<string, Finding[]>();
    for (const heuristic of heuristics) {
      results.set(heuristic.id, heuristic.evaluate({ now, store: this.store, settings: this.settingsFor(heuristic.id) }));
    }
    return results;
  }
}
