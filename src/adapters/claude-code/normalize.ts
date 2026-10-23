import * as crypto from 'crypto';
import { NormalizedEvent } from '../../core/types';
import { makeExcerpt } from '../../core/excerpt';
import { classifyTool } from '../../core/toolCategory';

interface ClaudeTranscriptLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  agentId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    content?: Array<{ type?: string; text?: string }> | string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Parses a line, keeping only token-bearing assistant entries (everything else in the transcript is ignored). */
function parseAssistantLine(rawLine: string): ClaudeTranscriptLine | undefined {
  let parsed: ClaudeTranscriptLine;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return undefined;
  }
  return parsed.type === 'assistant' && parsed.message?.usage ? parsed : undefined;
}

function toEvent(
  line: ClaudeTranscriptLine,
  filePath: string,
  chunkStartOffset: number,
  opts: { withTokens: boolean; textExcerpt?: string }
): NormalizedEvent {
  const usage = line.message?.usage ?? {};
  return {
    eventId: line.uuid ?? `claude-code:${filePath}:${chunkStartOffset}`,
    sessionId: line.sessionId ?? 'unknown-session',
    agent: 'claude-code',
    ts: line.timestamp ?? new Date().toISOString(),
    kind: 'turn_stop',
    status: 'unknown',
    model: line.message?.model,
    tokens: opts.withTokens
      ? {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheCreation: usage.cache_creation_input_tokens,
        }
      : undefined,
    textExcerpt: opts.textExcerpt,
    // Every line of a message repeats its stop_reason; a subagent finishing doesn't end the turn.
    endsTurn: opts.withTokens && line.message?.stop_reason === 'end_turn' && !line.agentId && !line.isSidechain ? true : undefined,
    raw: { adapter: 'claude-code', ref: `${filePath}#offset~${chunkStartOffset}` },
  };
}

/**
 * Maps a single Claude Code transcript JSONL line to a NormalizedEvent, per the
 * transformation matrix in docs/schema.md ("Transcript message with usage block").
 * Returns undefined for lines that aren't a token-bearing assistant turn.
 *
 * Counts the line's usage unconditionally, so it is only correct for a line
 * known to be the first of its message; the tailer uses
 * normalizeTranscriptChunk, which handles messages split across lines.
 */
export function normalizeTranscriptLine(
  rawLine: string,
  filePath: string,
  chunkStartOffset: number,
  opts: { captureContent?: boolean } = {}
): NormalizedEvent | undefined {
  const line = parseAssistantLine(rawLine);
  if (!line) return undefined;
  return toEvent(line, filePath, chunkStartOffset, {
    withTokens: true,
    textExcerpt: opts.captureContent ? makeExcerpt(textBlocks(line)) : undefined,
  });
}

/**
 * A prompt you typed: a main-session `user` line carrying text rather than a
 * tool result, and not a meta, compact-summary, or subagent line (a
 * subagent's opening `user` line is the main agent's instructions to it).
 */
/** Claude Code's "[Request interrupted by user]" line (also "... for tool use"): a turn end, not a prompt. */
export function isInterruption(line: ClaudeTranscriptLine): boolean {
  if (line.type !== 'user' || line.isSidechain || line.agentId) return false;
  const content = line.message?.content;
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '') : [];
  return texts.length > 0 && texts.every((t) => t.startsWith('[Request interrupted by user'));
}

export function isUserPrompt(line: ClaudeTranscriptLine): boolean {
  if (line.type !== 'user' || line.toolUseResult || line.isMeta || line.isCompactSummary) return false;
  if (line.isSidechain || line.agentId || isInterruption(line)) return false;
  const content = line.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((b) => b?.type === 'text') && !content.some((b) => b?.type === 'tool_result');
}

/**
 * Attributes transcript lines to turns. A prompt line starts a turn (its
 * promptId); every other line inherits its parent's turn through parentUuid.
 * Subagent lines carry the spawning turn's promptId directly. Lines whose
 * parent is unknown (e.g. after a restart) fall back to the file's most
 * recent turn, which is persisted in the adapter checkpoint.
 */
export class TurnTracker {
  private turnByUuid = new Map<string, string>();
  private lastTurnByFile = new Map<string, string>();
  private lastTurnBySession = new Map<string, string>();
  private lastModelByFile = new Map<string, string>();

  constructor(initialLastTurnByFile: Record<string, string> = {}, private readonly limit = 20_000) {
    for (const [file, turn] of Object.entries(initialLastTurnByFile)) {
      if (typeof turn === 'string') this.lastTurnByFile.set(file, turn);
    }
  }

  /** Records a line and returns the turn it belongs to, if any can be determined. */
  observe(file: string, line: ClaudeTranscriptLine): string | undefined {
    let turn: string | undefined;
    if (isUserPrompt(line)) {
      turn = line.promptId ?? line.uuid;
    } else if (line.agentId && line.promptId) {
      turn = line.promptId;
    } else {
      turn = (line.parentUuid ? this.turnByUuid.get(line.parentUuid) : undefined) ?? this.lastTurnByFile.get(file);
    }
    if (turn) {
      if (line.uuid) {
        this.turnByUuid.set(line.uuid, turn);
        if (this.turnByUuid.size > this.limit) this.turnByUuid.delete(this.turnByUuid.keys().next().value as string);
      }
      this.lastTurnByFile.set(file, turn);
      if (line.sessionId && !line.agentId) this.lastTurnBySession.set(line.sessionId, turn);
    }
    const model = line.message?.model;
    if (line.type === 'assistant' && model && model !== '<synthetic>') this.lastModelByFile.set(file, model);
    return turn;
  }

  /** The current turn of a session, for events (hooks) that don't name one. */
  latestTurnForSession(sessionId: string): string | undefined {
    return this.lastTurnBySession.get(sessionId);
  }

  lastModel(file: string): string | undefined {
    return this.lastModelByFile.get(file);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.lastTurnByFile);
  }
}

/**
 * Remembers the most recent message ids seen per transcript file, so a message
 * whose lines straddle two reads (or a restart) is still counted once. Lines of
 * a message are always consecutive, so a short per-file history is plenty.
 */
export class SeenMessages {
  private byFile = new Map<string, string[]>();

  constructor(initial: Record<string, string[]> = {}, private readonly perFileLimit = 32) {
    for (const [file, ids] of Object.entries(initial)) {
      if (Array.isArray(ids)) this.byFile.set(file, ids.filter((id) => typeof id === 'string').slice(-perFileLimit));
    }
  }

  has(file: string, messageId: string): boolean {
    return this.byFile.get(file)?.includes(messageId) ?? false;
  }

  add(file: string, messageId: string): void {
    const ids = this.byFile.get(file) ?? [];
    if (ids.includes(messageId)) return;
    ids.push(messageId);
    if (ids.length > this.perFileLimit) ids.shift();
    this.byFile.set(file, ids);
  }

  /** Restores a snapshot(), e.g. to undo a chunk whose events failed to publish. */
  restore(snapshot: Record<string, string[]>): void {
    this.byFile = new Map(Object.entries(snapshot).map(([file, ids]) => [file, [...ids]]));
  }

  snapshot(): Record<string, string[]> {
    return Object.fromEntries([...this.byFile].map(([file, ids]) => [file, [...ids]]));
  }
}

/**
 * Maps a chunk of newly appended transcript lines to events, one per API
 * message. Claude Code writes each content block of a response (thinking,
 * text, tool_use) as its own line, and every line repeats the whole message's
 * usage block, so counting per line overcounts tokens roughly twofold.
 * Consecutive lines sharing a message.id are merged into one event carrying
 * the usage once and all of the message's text. A line whose message was
 * already counted in an earlier chunk contributes only its text (if capture is
 * on), never its tokens. Lines without a message.id count individually.
 */
export function normalizeTranscriptChunk(
  rawLines: string[],
  filePath: string,
  chunkStartOffset: number,
  opts: { captureContent?: boolean; seen: SeenMessages; turns?: TurnTracker }
): NormalizedEvent[] {
  const turns = opts.turns ?? new TurnTracker();
  const events: NormalizedEvent[] = [];
  let group: { first: ClaudeTranscriptLine; id: string; texts: Array<string | undefined>; turnId?: string } | undefined;

  const withAttribution = (event: NormalizedEvent, line: ClaudeTranscriptLine, turnId: string | undefined): NormalizedEvent => {
    if (turnId) event.turnId = turnId;
    if (line.agentId) event.agentId = line.agentId;
    return event;
  };

  const flushGroup = () => {
    if (!group) return;
    events.push(
      withAttribution(
        toEvent(group.first, filePath, chunkStartOffset, {
          withTokens: true,
          textExcerpt: opts.captureContent ? makeExcerpt(group.texts) : undefined,
        }),
        group.first,
        group.turnId
      )
    );
    group = undefined;
  };

  for (const rawLine of rawLines) {
    let line: ClaudeTranscriptLine;
    try {
      line = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!line || typeof line !== 'object') continue;
    const turnId = turns.observe(filePath, line);

    if (isUserPrompt(line)) {
      flushGroup();
      events.push(promptEvent(line, filePath, chunkStartOffset, turnId));
      continue;
    }
    if (isInterruption(line)) {
      flushGroup();
      events.push(interruptionEvent(line, filePath, chunkStartOffset, turnId));
      continue;
    }
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      flushGroup();
      events.push(compactionEvent(line, filePath, chunkStartOffset, turnId, turns.lastModel(filePath)));
      continue;
    }
    if (line.type !== 'assistant' || !line.message?.usage) continue;
    const id = line.message.id;

    if (!id) {
      flushGroup();
      events.push(
        withAttribution(
          toEvent(line, filePath, chunkStartOffset, {
            withTokens: true,
            textExcerpt: opts.captureContent ? makeExcerpt(textBlocks(line)) : undefined,
          }),
          line,
          turnId
        )
      );
      continue;
    }

    if (group?.id === id) {
      group.texts.push(...textBlocks(line));
      continue;
    }

    flushGroup();
    if (opts.seen.has(filePath, id)) {
      const textExcerpt = opts.captureContent ? makeExcerpt(textBlocks(line)) : undefined;
      if (textExcerpt) events.push(withAttribution(toEvent(line, filePath, chunkStartOffset, { withTokens: false, textExcerpt }), line, turnId));
      continue;
    }
    opts.seen.add(filePath, id);
    group = { first: line, id, texts: textBlocks(line), turnId };
  }
  flushGroup();
  return events;
}

function promptEvent(line: ClaudeTranscriptLine, filePath: string, chunkStartOffset: number, turnId: string | undefined): NormalizedEvent {
  return {
    eventId: line.uuid ?? `claude-code:${filePath}:${chunkStartOffset}:prompt`,
    sessionId: line.sessionId ?? 'unknown-session',
    agent: 'claude-code',
    ts: line.timestamp ?? new Date().toISOString(),
    kind: 'user_prompt',
    status: 'unknown',
    turnId,
    raw: { adapter: 'claude-code', ref: `${filePath}#offset~${chunkStartOffset}` },
  };
}

function interruptionEvent(line: ClaudeTranscriptLine, filePath: string, chunkStartOffset: number, turnId: string | undefined): NormalizedEvent {
  return {
    eventId: line.uuid ?? `claude-code:${filePath}:${chunkStartOffset}:interrupt`,
    sessionId: line.sessionId ?? 'unknown-session',
    agent: 'claude-code',
    ts: line.timestamp ?? new Date().toISOString(),
    kind: 'turn_stop',
    status: 'unknown',
    turnId,
    endsTurn: true,
    raw: { adapter: 'claude-code', ref: `${filePath}#offset~${chunkStartOffset}` },
  };
}

function compactionEvent(
  line: ClaudeTranscriptLine,
  filePath: string,
  chunkStartOffset: number,
  turnId: string | undefined,
  model: string | undefined
): NormalizedEvent {
  const meta = line.compactMetadata ?? {};
  const trigger = meta.trigger === 'auto' || meta.trigger === 'manual' ? meta.trigger : 'unknown';
  const event: NormalizedEvent = {
    eventId: line.uuid ?? `claude-code:${filePath}:${chunkStartOffset}:compaction`,
    sessionId: line.sessionId ?? 'unknown-session',
    agent: 'claude-code',
    ts: line.timestamp ?? new Date().toISOString(),
    kind: 'compaction',
    status: 'unknown',
    model,
    turnId,
    compaction: {
      trigger,
      preTokens: typeof meta.preTokens === 'number' ? meta.preTokens : undefined,
      postTokens: typeof meta.postTokens === 'number' ? meta.postTokens : undefined,
    },
    raw: { adapter: 'claude-code', ref: `${filePath}#offset~${chunkStartOffset}` },
  };
  if (line.agentId) event.agentId = line.agentId;
  return event;
}

/** The reply's text blocks only: never thinking, tool_use inputs, or anything the user wrote. */
function textBlocks(line: ClaudeTranscriptLine): string[] {
  const content = line.message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text as string);
}

interface ClaudeHookPayload {
  session_id?: string;
  /** The prompt (turn) the hook fired in; documented on every hook event. */
  prompt_id?: string;
  /** Set when the hook fired inside a subagent. */
  agent_id?: string;
  tool_use_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
  tool_response?: { error?: unknown };
}

function isClaudeHookPayload(value: unknown): value is ClaudeHookPayload {
  return typeof value === 'object' && value !== null;
}

/**
 * Maps a Claude Code hook JSON payload (received over the local hooks HTTP
 * receiver) to a NormalizedEvent, per the transformation matrix's "PostToolUse
 * hook payload" and "Stop hook payload" rows. Token totals never come from
 * here -- only the transcript path populates `tokens`, so the two redundant
 * paths (hooks + transcript) never double-count.
 */
/**
 * `turnFallback` supplies the session's current turn (from the transcript)
 * for payloads that don't carry prompt_id, e.g. from older Claude Code.
 */
export function normalizeHookPayload(payload: unknown, turnFallback?: (sessionId: string) => string | undefined): NormalizedEvent | undefined {
  if (!isClaudeHookPayload(payload)) return undefined;

  const sessionId = payload.session_id ?? 'unknown-session';
  const ts = new Date().toISOString();
  const attribution: Pick<NormalizedEvent, 'turnId' | 'agentId'> = {};
  const turnId = payload.prompt_id ?? turnFallback?.(sessionId);
  if (turnId) attribution.turnId = turnId;
  if (payload.agent_id) attribution.agentId = payload.agent_id;

  if (payload.hook_event_name === 'PostToolUse') {
    const target = payload.tool_input?.file_path ?? payload.tool_input?.command;
    const status: NormalizedEvent['status'] = payload.tool_response?.error ? 'failure' : 'success';
    return {
      // Keyed by the call's tool_use_id, as tool calls rebuilt from transcripts are, so the two never both count.
      eventId: payload.tool_use_id ? `tool:${payload.tool_use_id}` : crypto.randomUUID(),
      sessionId,
      agent: 'claude-code',
      ts,
      kind: 'tool_call',
      target,
      status,
      toolName: payload.tool_name,
      toolCategory: classifyTool(payload.tool_name, payload.tool_input?.command),
      ...attribution,
      raw: { adapter: 'claude-code', ref: `hook:PostToolUse:${payload.tool_name ?? 'unknown'}` },
    };
  }

  if (payload.hook_event_name === 'Stop') {
    return {
      eventId: crypto.randomUUID(),
      sessionId,
      agent: 'claude-code',
      ts,
      kind: 'turn_stop',
      status: 'unknown',
      endsTurn: true,
      ...attribution,
      raw: { adapter: 'claude-code', ref: 'hook:Stop' },
    };
  }

  return undefined;
}
