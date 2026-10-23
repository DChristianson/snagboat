import * as fs from 'fs';
import * as path from 'path';
import { classifyTool } from '../../core/toolCategory';
import { NormalizedEvent } from '../../core/types';
import { normalizeTranscriptChunk, SeenMessages, TurnTracker } from './normalize';

/**
 * Reads a whole Claude Code session from its transcripts in one pass, for the
 * backfill command and heuristic replay rather than live tailing: the main
 * transcript, then its subagent transcripts, sharing turn attribution. Unlike
 * the live adapter, it also rebuilds tool calls from each message's tool_use
 * blocks (live tool calls come from hooks, which transcripts read back later
 * never had).
 */

/** The main transcript and its subagent transcripts (<session>/subagents/*.jsonl). */
export function sessionFiles(mainFile: string, listDir: (dir: string) => string[]): string[] {
  const subDir = path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'), 'subagents');
  let subs: string[] = [];
  try {
    subs = listDir(subDir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(subDir, f));
  } catch {
    // no subagents
  }
  return [mainFile, ...subs];
}

/** The main transcript a file belongs to: itself, or for a subagent transcript, its session's. */
export function mainTranscriptOf(file: string): string {
  const dir = path.dirname(file);
  return path.basename(dir) === 'subagents' ? `${path.dirname(dir)}.jsonl` : file;
}

/** Tool calls rebuilt from tool_use blocks, with status and time from the matching tool_result. */
export function transcriptToolCalls(lines: any[], file: string, turns: TurnTracker): NormalizedEvent[] {
  const results = new Map<string, { failed: boolean; ts: string }>();
  for (const d of lines) {
    if (d?.type !== 'user' || !Array.isArray(d.message?.content)) continue;
    for (const b of d.message.content) {
      if (b?.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { failed: b.is_error === true, ts: d.timestamp });
    }
  }
  const events: NormalizedEvent[] = [];
  for (const d of lines) {
    if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
    const turnId = turns.observe(file, d); // re-observing is idempotent
    d.message.content.forEach((b: any, index: number) => {
      if (b?.type !== 'tool_use') return;
      const result = b.id ? results.get(b.id) : undefined;
      const input = b.input ?? {};
      const event: NormalizedEvent = {
        // Same id as the PostToolUse hook's event for this call, so the two never both count.
        eventId: b.id ? `tool:${b.id}` : `tool:${d.uuid}:${index}`,
        sessionId: d.sessionId ?? 'unknown-session',
        agent: 'claude-code',
        ts: result?.ts ?? d.timestamp,
        kind: 'tool_call',
        target: input.file_path ?? input.command,
        status: result ? (result.failed ? 'failure' : 'success') : 'unknown',
        toolName: b.name,
        toolCategory: classifyTool(b.name, input.command),
        raw: { adapter: 'claude-code', ref: `${file}#tool` },
      };
      if (turnId) event.turnId = turnId;
      if (d.agentId) event.agentId = d.agentId;
      events.push(event);
    });
  }
  return events;
}

/** Events for a session from each of its files' lines (main transcript first), in time order. */
export function normalizeTranscriptSession(files: Array<{ file: string; lines: string[] }>, opts: { captureContent: boolean }): NormalizedEvent[] {
  const turns = new TurnTracker();
  const seen = new SeenMessages();
  const events: NormalizedEvent[] = [];
  for (const { file, lines } of files) {
    const raw = lines.filter((l) => l.trim());
    events.push(...normalizeTranscriptChunk(raw, file, 0, { captureContent: opts.captureContent, seen, turns }));
    const parsed = raw.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    });
    events.push(...transcriptToolCalls(parsed, file, turns));
  }
  return events.filter((e) => !Number.isNaN(Date.parse(e.ts))).sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Reads a session's transcripts from disk; files that can't be read are reported, not thrown. */
export async function readTranscriptSession(mainFile: string, opts: { captureContent: boolean }): Promise<{ events: NormalizedEvent[]; files: string[]; missing: string[] }> {
  const names = sessionFiles(mainFile, (dir) => fs.readdirSync(dir));
  const files: Array<{ file: string; lines: string[] }> = [];
  const missing: string[] = [];
  for (const file of names) {
    try {
      files.push({ file, lines: (await fs.promises.readFile(file, 'utf8')).split('\n') });
    } catch {
      missing.push(file);
    }
  }
  if (files[0]?.file !== mainFile) return { events: [], files: [], missing };
  return { events: normalizeTranscriptSession(files, opts), files: files.map((f) => f.file), missing };
}
