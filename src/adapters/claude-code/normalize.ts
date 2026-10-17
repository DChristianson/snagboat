import * as crypto from 'crypto';
import { NormalizedEvent } from '../../core/types';
import { makeExcerpt } from '../../core/excerpt';

interface ClaudeTranscriptLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
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

/**
 * Maps a single Claude Code transcript JSONL line to a NormalizedEvent, per the
 * transformation matrix in docs/schema.md ("Transcript message with usage block").
 * Returns undefined for lines that aren't a token-bearing assistant turn (v0 only
 * cares about token accounting from the transcript; tool_call events come from hooks).
 */
export function normalizeTranscriptLine(
  rawLine: string,
  filePath: string,
  chunkStartOffset: number,
  opts: { captureContent?: boolean } = {}
): NormalizedEvent | undefined {
  let parsed: ClaudeTranscriptLine;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return undefined;
  }

  const usage = parsed.message?.usage;
  if (parsed.type !== 'assistant' || !usage) {
    return undefined;
  }

  return {
    eventId: parsed.uuid ?? `claude-code:${filePath}:${chunkStartOffset}`,
    sessionId: parsed.sessionId ?? 'unknown-session',
    agent: 'claude-code',
    ts: parsed.timestamp ?? new Date().toISOString(),
    kind: 'turn_stop',
    status: 'unknown',
    model: parsed.message?.model,
    tokens: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheCreation: usage.cache_creation_input_tokens,
    },
    textExcerpt: opts.captureContent ? assistantText(parsed) : undefined,
    raw: { adapter: 'claude-code', ref: `${filePath}#offset~${chunkStartOffset}` },
  };
}

/** The reply's text blocks only: never thinking, tool_use inputs, or anything the user wrote. */
function assistantText(line: ClaudeTranscriptLine): string | undefined {
  const content = line.message?.content;
  if (typeof content === 'string') return makeExcerpt([content]);
  if (!Array.isArray(content)) return undefined;
  return makeExcerpt(content.filter((block) => block?.type === 'text').map((block) => block.text));
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
