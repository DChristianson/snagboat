import { AgentId, NormalizedEvent, NormalizedEventKind } from './types';
import { EventLog } from './eventLog';
import type { AggregateStore, DailyAggregate } from './retention';

export interface AgentAggregate {
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  eventCount: number;
  eventCountByKind: Partial<Record<NormalizedEventKind, number>>;
}

export interface AggregateSnapshot {
  perAgent: Record<string, AgentAggregate>;
  localEditCount: number;
  totalTokens: number;
}

function emptyAgentAggregate(): AgentAggregate {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, eventCount: 0, eventCountByKind: {} };
}

export class Aggregate {
  private perAgent = new Map<AgentId, AgentAggregate>();
  private localEditCount = 0;
  private totalTokens = 0;

  apply(event: NormalizedEvent): void {
    let agentAgg = this.perAgent.get(event.agent);
    if (!agentAgg) {
      agentAgg = emptyAgentAggregate();
      this.perAgent.set(event.agent, agentAgg);
    }
    agentAgg.eventCount += 1;
    agentAgg.eventCountByKind[event.kind] = (agentAgg.eventCountByKind[event.kind] ?? 0) + 1;

    if (event.tokens) {
      const { input = 0, output = 0, cacheRead = 0, cacheCreation = 0 } = event.tokens;
      agentAgg.tokens.input += input;
      agentAgg.tokens.output += output;
      agentAgg.tokens.cacheRead += cacheRead;
      agentAgg.tokens.cacheCreation += cacheCreation;
      this.totalTokens += input + output + cacheRead + cacheCreation;
    }

    if (event.kind === 'edit') {
      this.localEditCount += 1;
    }
  }

  /** Folds a rolled-up day in (sign 1) or back out (sign -1) of the running totals. */
  applyDaily(daily: DailyAggregate, sign: 1 | -1 = 1): void {
    for (const [agent, dayAgg] of Object.entries(daily.perAgent)) {
      let agentAgg = this.perAgent.get(agent as AgentId);
      if (!agentAgg) {
        agentAgg = emptyAgentAggregate();
        this.perAgent.set(agent as AgentId, agentAgg);
      }
      agentAgg.eventCount += sign * dayAgg.eventCount;
      for (const [kind, count] of Object.entries(dayAgg.eventCountByKind)) {
        const k = kind as NormalizedEventKind;
        agentAgg.eventCountByKind[k] = (agentAgg.eventCountByKind[k] ?? 0) + sign * (count ?? 0);
      }
      agentAgg.tokens.input += sign * dayAgg.tokens.input;
      agentAgg.tokens.output += sign * dayAgg.tokens.output;
      agentAgg.tokens.cacheRead += sign * dayAgg.tokens.cacheRead;
      agentAgg.tokens.cacheCreation += sign * dayAgg.tokens.cacheCreation;
    }
    this.localEditCount += sign * daily.localEditCount;
    this.totalTokens += sign * daily.totalTokens;
  }

  reset(): void {
    this.perAgent.clear();
    this.localEditCount = 0;
    this.totalTokens = 0;
  }

  /**
   * Rebuilds totals from rolled-up daily aggregates plus the raw days still on
   * disk. A day present in both (a crash between writing its aggregate and
   * deleting its raw file) is counted from the raw file only.
   */
  async rehydrateFrom(eventLog: EventLog, aggregates?: AggregateStore): Promise<void> {
    const rawDays = new Set(await eventLog.listDays());
    if (aggregates) {
      for (const day of await aggregates.listDays()) {
        if (rawDays.has(day)) continue;
        const daily = await aggregates.read(day);
        if (daily) this.applyDaily(daily);
      }
    }
    for (const event of await eventLog.readAll()) {
      this.apply(event);
    }
  }

  snapshot(): AggregateSnapshot {
    const perAgent: Record<string, AgentAggregate> = {};
    for (const [agent, agg] of this.perAgent) {
      perAgent[agent] = {
        tokens: { ...agg.tokens },
        eventCount: agg.eventCount,
        eventCountByKind: { ...agg.eventCountByKind },
      };
    }
    return {
      perAgent,
      localEditCount: this.localEditCount,
      totalTokens: this.totalTokens,
    };
  }
}

/** YYYY-MM-DD in the machine's local timezone -- what a person means by "today". */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * An Aggregate restricted to events whose timestamp falls on the current local
 * day. Rolls over (resets) on its own the first time it's touched after local
 * midnight, so the status bar's 30s poll is enough to zero it overnight.
 */
export class TodayAggregate {
  private day: string;
  private agg = new Aggregate();

  constructor(now: Date = new Date()) {
    this.day = localDayKey(now);
  }

  apply(event: NormalizedEvent, now: Date = new Date()): void {
    this.rollTo(now);
    if (localDayKey(new Date(event.ts)) === this.day) this.agg.apply(event);
  }

  /**
   * Seeds from the raw daily files that can overlap the local day. Those files
   * are keyed by UTC date, so local "today" spans at most the UTC days either
   * side of it.
   */
  async rehydrateFrom(eventLog: EventLog, now: Date = new Date()): Promise<void> {
    this.rollTo(now);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const utcDays = new Set([-1, 0, 1].map((offset) => new Date(now.getTime() + offset * DAY_MS).toISOString().slice(0, 10)));
    for (const day of [...utcDays].sort()) {
      for (const event of await eventLog.readDay(day)) this.apply(event, now);
    }
  }

  reset(): void {
    this.agg.reset();
  }

  snapshot(now: Date = new Date()): AggregateSnapshot {
    this.rollTo(now);
    return this.agg.snapshot();
  }

  private rollTo(now: Date): void {
    const today = localDayKey(now);
    if (today !== this.day) {
      this.day = today;
      this.agg.reset();
    }
  }
}
