import * as crypto from 'crypto';
import { NormalizedEvent } from '../../core/types';
import { makeExcerpt } from '../../core/excerpt';

interface ClaudeTranscriptLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
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
  opts: { captureContent?: boolean; seen: SeenMessages }
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let group: { first: ClaudeTranscriptLine; id: string; texts: Array<string | undefined> } | undefined;

  const flushGroup = () => {
    if (!group) return;
    events.push(
      toEvent(group.first, filePath, chunkStartOffset, {
        withTokens: true,
        textExcerpt: opts.captureContent ? makeExcerpt(group.texts) : undefined,
      })
    );
    group = undefined;
  };

  for (const rawLine of rawLines) {
    const line = parseAssistantLine(rawLine);
    if (!line) continue;
    const id = line.message?.id;

    if (!id) {
      flushGroup();
      events.push(
        toEvent(line, filePath, chunkStartOffset, {
          withTokens: true,
          textExcerpt: opts.captureContent ? makeExcerpt(textBlocks(line)) : undefined,
        })
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
      if (textExcerpt) events.push(toEvent(line, filePath, chunkStartOffset, { withTokens: false, textExcerpt }));
      continue;
    }
    opts.seen.add(filePath, id);
    group = { first: line, id, texts: textBlocks(line) };
  }
  flushGroup();
  return events;
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
export function normalizeHookPayload(payload: unknown): NormalizedEvent | undefined {
  if (!isClaudeHookPayload(payload)) return undefined;

  const sessionId = payload.session_id ?? 'unknown-session';
  const ts = new Date().toISOString();

  if (payload.hook_event_name === 'PostToolUse') {
    const target = payload.tool_input?.file_path ?? payload.tool_input?.command;
    const status: NormalizedEvent['status'] = payload.tool_response?.error ? 'failure' : 'success';
    return {
      eventId: crypto.randomUUID(),
      sessionId,
      agent: 'claude-code',
      ts,
      kind: 'tool_call',
      target,
      status,
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
      raw: { adapter: 'claude-code', ref: 'hook:Stop' },
    };
  }

  return undefined;
}
