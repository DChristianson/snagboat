import { SessionSummary } from '@snagboat/schema';

/**
 * Session headlines: one line per ended session from the summarize-session
 * advisor, asked quietly, one at a time, and cached per workspace. A session
 * is due once it has been idle past the stalled window; a session that grows
 * afterwards is due again. Opt-in (`snagboat.advisor.headlines`).
 */

export interface HeadlineEntry {
  /** Absent when the advisor had nothing specific to say. */
  line?: string;
  model?: string;
  /** The session's last event when it was headlined, so growth makes it due again. */
  lastTs: string;
  at: string;
}

export class Headliner {
  constructor(private cache: Record<string, HeadlineEntry>, private readonly save: (cache: Record<string, HeadlineEntry>) => Promise<void>) {}

  get(sessionId: string): string | undefined {
    return this.cache[sessionId]?.line;
  }

  /** Sessions due a headline, newest first: idle past the window, within `days`, with a prompt, and not headlined at their current size. */
  due(sessions: SessionSummary[], now: string, idleMinutes: number, days: number): SessionSummary[] {
    const t = Date.parse(now);
    return sessions
      .filter((s) => s.prompts > 0 && t - Date.parse(s.lastTs) >= idleMinutes * 60_000 && t - Date.parse(s.lastTs) <= days * 86_400_000 && this.cache[s.sessionId]?.lastTs !== s.lastTs)
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  async record(sessionId: string, lastTs: string, line: string | undefined, model: string | undefined, at: string): Promise<void> {
    this.cache = { ...this.cache, [sessionId]: { ...(line ? { line } : {}), ...(model ? { model } : {}), lastTs, at } };
    await this.save(this.cache);
  }

  /** Drops entries for sessions no longer in the index. */
  async prune(keep: Set<string>): Promise<void> {
    const kept = Object.fromEntries(Object.entries(this.cache).filter(([id]) => keep.has(id)));
    if (Object.keys(kept).length === Object.keys(this.cache).length) return;
    this.cache = kept;
    await this.save(this.cache);
  }
}
