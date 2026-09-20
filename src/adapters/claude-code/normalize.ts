import { NormalizedEvent } from '../../core/types';

interface ClaudeTranscriptLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    model?: string;
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
  chunkStartOffset: number
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
    raw: { adapter: 'claude-code', ref: `${filePath}#offset~${chunkStartOffset}` },
  };
}
