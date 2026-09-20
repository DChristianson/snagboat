import { AgentId, NormalizedEvent } from './types';
import { EventLog } from './eventLog';

export interface AgentAggregate {
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  eventCount: number;
}

export interface AggregateSnapshot {
  perAgent: Record<string, AgentAggregate>;
  localEditCount: number;
  totalTokens: number;
}

function emptyAgentAggregate(): AgentAggregate {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, eventCount: 0 };
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

  async rehydrateFrom(eventLog: EventLog): Promise<void> {
    const events = await eventLog.readAll();
    for (const event of events) {
      this.apply(event);
    }
  }

  snapshot(): AggregateSnapshot {
    const perAgent: Record<string, AgentAggregate> = {};
    for (const [agent, agg] of this.perAgent) {
      perAgent[agent] = { tokens: { ...agg.tokens }, eventCount: agg.eventCount };
    }
    return {
      perAgent,
      localEditCount: this.localEditCount,
      totalTokens: this.totalTokens,
    };
  }
}
