import { ReadonlyEventStore } from './eventStore';
import { isConversationEvent } from './sessions';
import { AgentId, NormalizedEvent } from './types';

/** A session's latest turn: everything from its prompt up to now, or to the next prompt. */
export interface CurrentTurn {
  sessionId: string;
  agent: AgentId;
  turnId: string;
  /** The turn's first prompt message in the given events. */
  promptTs: string;
  promptEventId: string;
  /** The turn's conversation events (main agent and subagents), in time order. */
  events: NormalizedEvent[];
  /** No turn end (endsTurn) since the turn's last prompt message. */
  open: boolean;
  /**
   * Whether turn ends are being recorded for this session: it has recorded
   * one, or this is its only turn so far. False for sessions logged before
   * Snagboat recorded turn ends, where every turn would look open.
   */
  endsRecorded: boolean;
  /** The session's latest conversation event of any kind. */
  lastActivityTs: string;
}

/**
 * Each session's latest turn, from time-ordered events (the event store's
 * window). Sessions whose latest turn's prompt isn't among the events are left
 * out, since there's no telling where that turn began.
 */
export function currentTurns(events: NormalizedEvent[]): CurrentTurn[] {
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    if (!isConversationEvent(e)) continue;
    const list = bySession.get(e.sessionId) ?? [];
    list.push(e);
    bySession.set(e.sessionId, list);
  }
  const turns: CurrentTurn[] = [];
  for (const [sessionId, list] of bySession) {
    const latestPrompt = [...list].reverse().find((e) => e.kind === 'user_prompt' && e.turnId);
    if (!latestPrompt) continue;
    const turnId = latestPrompt.turnId!;
    const inTurn = list.filter((e) => e.turnId === turnId);
    const firstPrompt = inTurn.find((e) => e.kind === 'user_prompt')!;
    const lastPromptTs = latestPrompt.ts;
    turns.push({
      sessionId,
      agent: latestPrompt.agent,
      turnId,
      promptTs: firstPrompt.ts,
      promptEventId: firstPrompt.eventId,
      events: inTurn,
      open: !inTurn.some((e) => e.endsTurn && e.ts >= lastPromptTs),
      endsRecorded: list.some((e) => e.endsTurn) || !list.some((e) => e.kind === 'user_prompt' && e.turnId && e.turnId !== turnId),
      lastActivityTs: list[list.length - 1].ts,
    });
  }
  return turns;
}

const cache = new WeakMap<ReadonlyEventStore, { key: string; turns: CurrentTurn[] }>();

/**
 * currentTurns over a store's events, computed once per store state: several
 * heuristics ask for it on each event, and it only changes when events do.
 */
export function currentTurnsIn(store: ReadonlyEventStore): CurrentTurn[] {
  const events = store.query();
  const key = events.length === 0 ? '' : `${events.length}|${events[0].eventId}|${events[events.length - 1].eventId}`;
  const hit = cache.get(store);
  if (hit?.key === key) return hit.turns;
  const turns = currentTurns(events);
  cache.set(store, { key, turns });
  return turns;
}

/** The turn's model calls that carry tokens, optionally only the main agent's. */
export function modelCalls(turn: CurrentTurn, mainOnly = false): NormalizedEvent[] {
  return turn.events.filter((e) => e.kind === 'turn_stop' && e.tokens && (!mainOnly || !e.agentId));
}
