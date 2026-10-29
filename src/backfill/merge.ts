import { eventTokens } from '../core/sessions';
import { baseCategory, classifyCommand, classifyTool, isShellTool } from '../core/toolCategory';
import { NormalizedEvent } from '../core/types';

/**
 * The pure half of the backfill command: which source file an event came
 * from, what a day looks like (for the dry run), and how a day's stored
 * events merge with events rebuilt from re-reading its sources.
 */

/** Adapters whose events come from a session log file that can be re-read; their refs are "<file>#...". */
const REREADABLE_ADAPTERS = new Set(['claude-code', 'copilot-cli']);

export function sourceFileOf(event: NormalizedEvent): string | undefined {
  if (!REREADABLE_ADAPTERS.has(event.raw.adapter)) return undefined;
  const hash = event.raw.ref.indexOf('#');
  return hash > 0 ? event.raw.ref.slice(0, hash) : undefined;
}

/** Copilot token-usage metrics, which older builds counted as agent turns; spans carry the same counts. */
export function isRetiredCopilotMetric(event: NormalizedEvent): boolean {
  return event.agent === 'copilot' && event.raw.ref.startsWith('otlp:metric:');
}

export interface DayStats {
  /** Agent model calls with tokens (editor-feature calls excluded). */
  modelCalls: number;
  /** Of those, calls not tied to a known prompt. */
  unlinkedCalls: number;
  toolCalls: number;
  turnEnds: number;
  tokens: number;
  retiredMetrics: number;
}

/** Turns with a prompt among these events. */
export function promptedTurns(events: NormalizedEvent[]): Set<string> {
  return new Set(events.filter((e) => e.kind === 'user_prompt' && e.turnId).map((e) => e.turnId!));
}

/** prompts: turns counted as linked; default, those prompted on the same day (a turn can cross midnight, so pass a wider set when known). */
export function dayStats(events: NormalizedEvent[], prompts: Set<string> = promptedTurns(events)): DayStats {
  const calls = events.filter((e) => e.kind === 'turn_stop' && e.tokens && e.channel !== 'inline' && !isRetiredCopilotMetric(e));
  return {
    modelCalls: calls.length,
    unlinkedCalls: calls.filter((e) => !e.turnId || !prompts.has(e.turnId)).length,
    toolCalls: events.filter((e) => e.kind === 'tool_call' && e.agent !== 'generic-fs').length,
    turnEnds: events.filter((e) => e.endsTurn).length,
    tokens: events.reduce((sum, e) => sum + eventTokens(e), 0),
    retiredMetrics: events.filter(isRetiredCopilotMetric).length,
  };
}

/** A hook tool call and a rebuilt one this close together, for the same tool and target, are the same call. */
const SAME_CALL_WITHIN_MS = 10_000;

/**
 * A day's events after backfill:
 *   - events from a re-read source are replaced by the rebuilt ones, except
 *     those logged after the re-read began (live events the re-read missed);
 *     rebuilt events are filed under their own day, so an event an older
 *     build filed under the wrong day moves to the right one;
 *   - retired Copilot metric events are dropped, as are hook events logged
 *     under a Copilot agent session's id (Copilot runs .claude/settings.json
 *     hooks too; its own log already has those calls);
 *   - hook events are kept, gaining what older builds didn't record (tool
 *     category, the Stop hook's turn end, a turn from the session's prompt
 *     times);
 *   - a rebuilt tool call that a hook already logged is left out;
 *   - one event per id, in time order.
 */
export function mergeDay(
  current: NormalizedEvent[],
  rebuilt: NormalizedEvent[],
  rereadSources: Set<string>,
  rereadStartedAt: string,
  /** Old events from a re-read source to keep anyway: those filed under the wrong day whose own day can't take them. */
  keepOld: (event: NormalizedEvent) => boolean = () => false
): NormalizedEvent[] {
  const rebuiltIds = new Set(rebuilt.map((e) => e.eventId));
  // Copilot runs the hooks in .claude/settings.json too, and older builds logged those as Claude Code events under the Copilot session's id.
  const copilotSessions = new Set([...current, ...rebuilt].filter((e) => e.raw.adapter === 'copilot-cli').map((e) => e.sessionId));
  const kept = current.filter((e) => {
    if (isRetiredCopilotMetric(e)) return false;
    if (e.agent === 'claude-code' && e.raw.ref.startsWith('hook:') && copilotSessions.has(e.sessionId)) return false;
    const source = sourceFileOf(e);
    if (!source || !rereadSources.has(source)) return true;
    if (keepOld(e)) return true;
    return !rebuiltIds.has(e.eventId) && e.ts >= rereadStartedAt;
  });

  const hookCalls = kept.filter((e) => e.kind === 'tool_call' && e.raw.ref.startsWith('hook:'));
  const loggedByHook = (t: NormalizedEvent) =>
    hookCalls.some(
      (h) =>
        h.eventId === t.eventId ||
        (h.sessionId === t.sessionId && h.toolName === t.toolName && h.target === t.target && Math.abs(Date.parse(h.ts) - Date.parse(t.ts)) <= SAME_CALL_WITHIN_MS)
    );
  const added = rebuilt.filter((e) => !(e.kind === 'tool_call' && loggedByHook(e)));

  const seen = new Set<string>();
  const merged = [...kept, ...added].filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)));
  merged.sort((a, b) => a.ts.localeCompare(b.ts));

  // Prompt times per session, for hook events older builds logged without a turn.
  const promptsBySession = new Map<string, NormalizedEvent[]>();
  for (const e of merged) if (e.kind === 'user_prompt' && e.turnId) promptsBySession.set(e.sessionId, [...(promptsBySession.get(e.sessionId) ?? []), e]);
  const turnAt = (e: NormalizedEvent) => [...(promptsBySession.get(e.sessionId) ?? [])].reverse().find((p) => p.ts <= e.ts)?.turnId;

  return merged.map((e) => {
    if (!e.raw.ref.startsWith('hook:')) return e;
    const fixed: NormalizedEvent = { ...e };
    if (e.kind === 'tool_call' && !e.toolCategory && e.toolName) fixed.toolCategory = classifyTool(e.toolName, e.target);
    if (e.raw.ref === 'hook:Stop' && !e.endsTurn) fixed.endsTurn = true;
    if (!e.turnId) {
      const turnId = turnAt(e);
      if (turnId) fixed.turnId = turnId;
    }
    return fixed;
  });
}

/**
 * Re-applies the shell sub-categories in use to stored shell calls: calls
 * classified as shell (plain or a sub-category) are classified again from
 * their command line, so an accepted category reaches past calls and a
 * removed one goes back to "Shell command". Other categories never change.
 */
export function relabelShellCalls(events: NormalizedEvent[]): { events: NormalizedEvent[]; changed: number } {
  let changed = 0;
  const out = events.map((e) => {
    if (e.kind !== 'tool_call' || !e.toolCategory || baseCategory(e.toolCategory) !== 'shell' || !isShellTool(e.toolName) || !e.target) return e;
    const category = classifyCommand(e.target);
    if (category === e.toolCategory) return e;
    changed += 1;
    return { ...e, toolCategory: category };
  });
  return { events: out, changed };
}
