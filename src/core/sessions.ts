import { eventDay } from './eventLog';
import { NormalizedEvent } from './types';

/** One conversation (a Claude Code or Copilot agent session), summarized for the Sessions list. */
export interface SessionSummary {
  sessionId: string;
  agent: string;
  firstTs: string;
  lastTs: string;
  models: string[];
  /** Turns started by you. Several prompt messages can share one turn (a message sent while the agent was still working joins it). */
  prompts: number;
  modelCalls: number;
  toolCalls: number;
  /** All four token fields summed, as everywhere else in Snagboat. */
  tokens: number;
  subagents: number;
  /** UTC days (event-log files) holding this session's events, oldest first. */
  days: string[];
}

/** Whether an event belongs to a conversation, as opposed to editor-feature calls or file saves. */
export function isConversationEvent(event: NormalizedEvent): boolean {
  if (event.channel === 'inline') return false;
  if (event.agent === 'generic-fs') return false;
  return event.kind === 'user_prompt' || event.kind === 'turn_stop' || event.kind === 'tool_call' || event.kind === 'compaction';
}

export function eventTokens(event: NormalizedEvent): number {
  const t = event.tokens;
  return t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreation ?? 0) : 0;
}

interface MutableSummary {
  sessionId: string;
  agent: string;
  firstTs: string;
  lastTs: string;
  models: Set<string>;
  turns: Set<string>;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  subagents: Set<string>;
  days: Set<string>;
}

/**
 * Summaries of every session in the retained event log, kept current as
 * events arrive. A session only appears once it has a prompt or a model call
 * (hook-only noise such as a stray Stop doesn't make one).
 */
export class SessionIndex {
  private sessions = new Map<string, MutableSummary>();

  ingest(event: NormalizedEvent): void {
    if (!isConversationEvent(event)) return;
    let s = this.sessions.get(event.sessionId);
    if (!s) {
      s = { sessionId: event.sessionId, agent: event.agent, firstTs: event.ts, lastTs: event.ts, models: new Set(), turns: new Set(), modelCalls: 0, toolCalls: 0, tokens: 0, subagents: new Set(), days: new Set() };
      this.sessions.set(event.sessionId, s);
    }
    if (event.ts < s.firstTs) s.firstTs = event.ts;
    if (event.ts > s.lastTs) s.lastTs = event.ts;
    s.days.add(eventDay(event));
    if (event.agentId) s.subagents.add(event.agentId);
    if (event.kind === 'user_prompt') s.turns.add(event.turnId ?? event.eventId);
    if (event.kind === 'tool_call') s.toolCalls += 1;
    if (event.kind === 'turn_stop' && event.tokens) {
      s.modelCalls += 1;
      s.tokens += eventTokens(event);
      if (event.model && event.model !== '<synthetic>') s.models.add(event.model);
    }
  }

  reset(): void {
    this.sessions.clear();
  }

  /** Sessions with any events on the given UTC day, most recent activity first. */
  forDay(day: string): SessionSummary[] {
    return this.list().filter((s) => s.days.includes(day));
  }

  get(sessionId: string): SessionSummary | undefined {
    const s = this.sessions.get(sessionId);
    return s && (s.turns.size > 0 || s.modelCalls > 0) ? freeze(s) : undefined;
  }

  /** All sessions, most recent activity first. */
  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.turns.size > 0 || s.modelCalls > 0)
      .map(freeze)
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  /** Every UTC day that has at least one session, newest first (for the day picker). */
  days(): string[] {
    const all = new Set<string>();
    for (const s of this.list()) for (const d of s.days) all.add(d);
    return [...all].sort().reverse();
  }
}

function freeze(s: MutableSummary): SessionSummary {
  return {
    sessionId: s.sessionId,
    agent: s.agent,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    models: [...s.models].sort(),
    prompts: s.turns.size,
    modelCalls: s.modelCalls,
    toolCalls: s.toolCalls,
    tokens: s.tokens,
    subagents: s.subagents.size,
    days: [...s.days].sort(),
  };
}
