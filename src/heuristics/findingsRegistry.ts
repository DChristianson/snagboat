import { Finding } from './types';

function sameFindings(a: Finding[], b: Finding[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Tracks the current set of findings per heuristic (a heuristic's whole set is
 * replaced on each report, since a single evaluation can produce several
 * findings at once). Mirrors HealthRegistry's proven shape: notify listeners
 * only when something actually changed, so the status bar doesn't re-render
 * on every redundant "still fine" tick.
 */
export class FindingsRegistry {
  private byHeuristic = new Map<string, Finding[]>();
  private listeners: Array<() => void> = [];

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  report(heuristicId: string, findings: Finding[]): void {
    const prev = this.byHeuristic.get(heuristicId) ?? [];
    const changed = !sameFindings(prev, findings);
    if (findings.length > 0) {
      this.byHeuristic.set(heuristicId, findings);
    } else {
      this.byHeuristic.delete(heuristicId);
    }
    if (changed) {
      for (const listener of this.listeners) listener();
    }
  }

  list(): Finding[] {
    return [...this.byHeuristic.values()].flat();
  }

  /** Highest severity first, then most recently detected; undefined if nothing active. */
  worst(): Finding | undefined {
    const rank = (f: Finding): number => (f.severity === 'warn' ? 1 : 0);
    return [...this.list()].sort((a, b) => rank(b) - rank(a) || b.detectedAt.localeCompare(a.detectedAt))[0];
  }
}
