import { Aggregate } from './aggregate';
import { EventLog } from './eventLog';
import type { AggregateStore, DailyAggregate } from './retention';
import { NormalizedEvent } from './types';

export interface DailyTokens {
  /** YYYY-MM-DD, UTC -- the same key the daily log and aggregate files use. */
  date: string;
  /** Total tokens (all four fields summed) per agent that used any that day. */
  perAgent: Record<string, number>;
}

/**
 * Per-day, per-agent totals across all retained history (raw days plus
 * rolled-up aggregates), for the detail view's usage chart. Keyed by UTC day
 * so it lines up exactly with what retention rolls up and prunes.
 */
export class DailyHistory {
  private days = new Map<string, Aggregate>();

  apply(event: NormalizedEvent): void {
    this.dayAggregate(event.ts.slice(0, 10)).apply(event);
  }

  applyDaily(daily: DailyAggregate): void {
    this.dayAggregate(daily.date).applyDaily(daily);
  }

  removeDay(date: string): void {
    this.days.delete(date);
  }

  reset(): void {
    this.days.clear();
  }

  /** Same precedence as Aggregate.rehydrateFrom: a raw file wins over an aggregate for the same day. */
  async rehydrateFrom(eventLog: EventLog, aggregates: AggregateStore): Promise<void> {
    const rawDays = new Set(await eventLog.listDays());
    for (const day of await aggregates.listDays()) {
      if (rawDays.has(day)) continue;
      const daily = await aggregates.read(day);
      if (daily) this.applyDaily(daily);
    }
    for (const day of rawDays) {
      for (const event of await eventLog.readDay(day)) this.apply(event);
    }
  }

  /** Oldest first; days with no token usage at all are omitted. */
  tokensByDay(): DailyTokens[] {
    const result: DailyTokens[] = [];
    for (const date of [...this.days.keys()].sort()) {
      const perAgent: Record<string, number> = {};
      for (const [agent, agg] of Object.entries(this.days.get(date)!.snapshot().perAgent)) {
        const total = agg.tokens.input + agg.tokens.output + agg.tokens.cacheRead + agg.tokens.cacheCreation;
        if (total > 0) perAgent[agent] = total;
      }
      if (Object.keys(perAgent).length > 0) result.push({ date, perAgent });
    }
    return result;
  }

  private dayAggregate(date: string): Aggregate {
    let agg = this.days.get(date);
    if (!agg) {
      agg = new Aggregate();
      this.days.set(date, agg);
    }
    return agg;
  }
}
