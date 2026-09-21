export interface HealthIssue {
  source: string;
  message: string;
}

/**
 * Tracks named, independently-settable/clearable health issues per adapter
 * (e.g. an agent can have both a "transcripts" and a "hooks" concern at once,
 * and clearing one shouldn't clobber the other). Notifies listeners only when
 * the set of issues actually changes, so the status bar doesn't re-render on
 * every redundant "still fine" report.
 */
export class HealthRegistry {
  private issues = new Map<string, string>();
  private listeners: Array<() => void> = [];

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  report(source: string, key: string, message: string | undefined): void {
    const fullKey = `${source}:${key}`;
    const changed = message ? this.issues.get(fullKey) !== message : this.issues.has(fullKey);
    if (message) {
      this.issues.set(fullKey, message);
    } else {
      this.issues.delete(fullKey);
    }
    if (changed) {
      for (const listener of this.listeners) listener();
    }
  }

  list(): HealthIssue[] {
    return [...this.issues.entries()]
      .map(([fullKey, message]) => ({ source: fullKey.split(':')[0], message }))
      .sort((a, b) => a.source.localeCompare(b.source));
  }
}
