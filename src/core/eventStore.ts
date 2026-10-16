import { NormalizedEvent, NormalizedEventKind, AgentId, EventTokens } from './types';
import { EventLog } from './eventLog';

export interface EventQuery {
  since?: string;
  until?: string;
  kinds?: NormalizedEventKind[];
  agents?: AgentId[];
  sessionId?: string;
  target?: string;
  limit?: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** The only interface heuristics are allowed to see -- no ingest/eviction exposed. */
export interface ReadonlyEventStore {
  query(filter?: EventQuery): NormalizedEvent[];
  lastN(n: number): NormalizedEvent[];
  latestTs(): string | undefined;
  cumulativeTokens(scope: { sessionId?: string; day?: string }): TokenTotals;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function addTokens(totals: TokenTotals, tokens: EventTokens | undefined): void {
  if (!tokens) return;
  totals.input += tokens.input ?? 0;
  totals.output += tokens.output ?? 0;
  totals.cacheRead += tokens.cacheRead ?? 0;
  totals.cacheCreation += tokens.cacheCreation ?? 0;
}

/** YYYY-MM-DD, matching EventLog's daily file naming. */
function dayKeyOf(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Bounded in-memory window of recent events plus incremental per-session/
 * per-day token accumulators. Query-time never falls back to disk: the window
 * is seeded once via rehydrateFrom() and maintained incrementally via ingest(),
 * so a query never re-parses the on-disk log.
 *
 * windowMs/maxEvents must be sized by the caller (extension.ts) from the
 * configured heuristic windows -- this class stays ignorant of heuristics. If
 * a heuristic's window is later widened past what's retained, query() results
 * silently truncate; there is no error surfaced for that today.
 */
export class EventStore implements ReadonlyEventStore {
  private events: NormalizedEvent[] = [];
  private readonly windowMs: number;
  private readonly maxEvents: number;

  private sessionTotals = new Map<string, TokenTotals>();
  private dayTotals = new Map<string, TokenTotals>();

  constructor(opts: { windowMs: number; maxEvents: number }) {
    this.windowMs = opts.windowMs;
    this.maxEvents = opts.maxEvents;
  }

  ingest(event: NormalizedEvent): void {
    this.events.push(event);
    this.evictOld(event.ts);

    if (event.tokens) {
      const sessionTotal = this.sessionTotals.get(event.sessionId) ?? emptyTotals();
      addTokens(sessionTotal, event.tokens);
      this.sessionTotals.set(event.sessionId, sessionTotal);

      const dayKey = dayKeyOf(event.ts);
      const dayTotal = this.dayTotals.get(dayKey) ?? emptyTotals();
      addTokens(dayTotal, event.tokens);
      this.dayTotals.set(dayKey, dayTotal);
    }
  }

  reset(): void {
    this.events = [];
    this.sessionTotals.clear();
    this.dayTotals.clear();
  }

  async rehydrateFrom(eventLog: EventLog): Promise<void> {
    const events = await eventLog.readAll();
    for (const event of events) {
      this.ingest(event);
    }
  }

  private evictOld(latestTs: string): void {
    const cutoff = new Date(latestTs).getTime() - this.windowMs;
    while (this.events.length > 0 && new Date(this.events[0].ts).getTime() < cutoff) {
      this.events.shift();
    }
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  query(filter: EventQuery = {}): NormalizedEvent[] {
    let results = this.events;
    if (filter.since !== undefined) {
      const since = filter.since;
      results = results.filter((e) => e.ts >= since);
    }
    if (filter.until !== undefined) {
      const until = filter.until;
      results = results.filter((e) => e.ts < until);
    }
    if (filter.kinds) {
      const kinds = filter.kinds;
      results = results.filter((e) => kinds.includes(e.kind));
    }
    if (filter.agents) {
      const agents = filter.agents;
      results = results.filter((e) => agents.includes(e.agent));
    }
    if (filter.sessionId !== undefined) {
      const sessionId = filter.sessionId;
      results = results.filter((e) => e.sessionId === sessionId);
    }
    if (filter.target !== undefined) {
      const target = filter.target;
      results = results.filter((e) => e.target === target);
    }
    if (filter.limit !== undefined) {
      results = results.slice(-filter.limit);
    }
    return results;
  }

  lastN(n: number): NormalizedEvent[] {
    return this.events.slice(-n);
  }

  latestTs(): string | undefined {
    return this.events.length > 0 ? this.events[this.events.length - 1].ts : undefined;
  }

  cumulativeTokens(scope: { sessionId?: string; day?: string }): TokenTotals {
    if (scope.sessionId !== undefined) {
      return { ...(this.sessionTotals.get(scope.sessionId) ?? emptyTotals()) };
    }
    if (scope.day !== undefined) {
      return { ...(this.dayTotals.get(scope.day) ?? emptyTotals()) };
    }
    return emptyTotals();
  }
}
