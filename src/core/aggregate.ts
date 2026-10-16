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
