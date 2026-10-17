import { Finding } from './types';

/** A finding plus how the user has chosen to treat its heuristic. */
export interface FindingView {
  finding: Finding;
  acknowledged: boolean;
  muted: boolean;
}

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
  // Acknowledgement is per episode: it lasts until the heuristic next reports
  // nothing, so a fresh occurrence of the same problem resurfaces. Muting is
  // indefinite (persisted by the caller via onMutedChange).
  private acknowledged = new Set<string>();
  private muted: Set<string>;

  constructor(initiallyMuted: Iterable<string> = []) {
    this.muted = new Set(initiallyMuted);
  }

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
      this.acknowledged.delete(heuristicId);
    }
    if (changed) this.notify();
  }

  /** Hides a heuristic's current findings from the status bar until it next clears. No-op if nothing is active. */
  acknowledge(heuristicId: string): void {
    if (!this.byHeuristic.has(heuristicId) || this.acknowledged.has(heuristicId)) return;
    this.acknowledged.add(heuristicId);
    this.notify();
  }

  setMuted(heuristicId: string, muted: boolean): void {
    if (this.muted.has(heuristicId) === muted) return;
    if (muted) this.muted.add(heuristicId);
    else this.muted.delete(heuristicId);
    this.notify();
  }

  mutedHeuristics(): string[] {
    return [...this.muted].sort();
  }

  /** Every active finding, including acknowledged and muted ones. */
  list(): Finding[] {
    return [...this.byHeuristic.values()].flat();
  }

  /** Active findings that aren't muted -- what the tooltip and breakdown show. */
  visible(): Finding[] {
    return this.list().filter((f) => !this.muted.has(f.heuristicId));
  }

  views(): FindingView[] {
    return this.list().map((finding) => ({
      finding,
      acknowledged: this.acknowledged.has(finding.heuristicId),
      muted: this.muted.has(finding.heuristicId),
    }));
  }

  /** Highest severity first, then most recently detected, among findings neither acknowledged nor muted. */
  worst(): Finding | undefined {
    const rank = (f: Finding): number => (f.severity === 'warn' ? 1 : 0);
    return this.views()
      .filter((v) => !v.acknowledged && !v.muted)
      .map((v) => v.finding)
      .sort((a, b) => rank(b) - rank(a) || b.detectedAt.localeCompare(a.detectedAt))[0];
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
