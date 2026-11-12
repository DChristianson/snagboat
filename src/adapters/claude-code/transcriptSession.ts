import * as fs from 'fs';
import * as path from 'path';
import { classifyTool } from '@snagboat/schema';
import { NormalizedEvent } from '@snagboat/schema';
import { EventTaskOp, EventTodos } from '@snagboat/schema';
import { normalizeTranscriptChunk, SeenMessages, TASK_TOOLS, TurnTracker, taskOpOf, todosOf } from './normalize';

/**
 * Reads a whole Claude Code session from its transcripts in one pass, for the
 * backfill command and heuristic replay rather than live tailing: the main
 * transcript, then its subagent transcripts, sharing turn attribution. Unlike
 * the live adapter, it also rebuilds tool calls from each message's tool_use
 * blocks, as the live tailer does (LiveToolCalls) alongside the hooks.
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

/**
 * A tool_result's output: the user line's toolUseResult (the tool's structured
 * output, which holds a new task's id) when the line carries only this result,
 * else the block's own content.
 */
function resultOutput(line: any, block: any): unknown {
  const results = line.message.content.filter((b: any) => b?.type === 'tool_result');
  return results.length === 1 && line.toolUseResult !== undefined ? line.toolUseResult : block.content;
}

/** A tool call from its tool_use block, with status and time from its tool_result when there is one. */
function toolCallEvent(
  use: { id?: string; name?: string; input?: { file_path?: unknown; command?: unknown }; todos?: EventTodos; taskOp?: EventTaskOp; sessionId?: string; agentId?: string; ts: string; fallbackId: string },
  result: { failed: boolean; ts: string } | undefined,
  file: string,
  turnId: string | undefined
): NormalizedEvent {
  const input = use.input ?? {};
  const target = typeof input.file_path === 'string' ? input.file_path : typeof input.command === 'string' ? input.command : undefined;
  const command = typeof input.command === 'string' ? input.command : undefined;
  const event: NormalizedEvent = {
    // Same id as the PostToolUse/PostToolUseFailure hook's event for this call, so the two never both count.
    eventId: use.id ? `tool:${use.id}` : use.fallbackId,
    sessionId: use.sessionId ?? 'unknown-session',
    agent: 'claude-code',
    ts: result?.ts ?? use.ts,
    kind: 'tool_call',
    target,
    status: result ? (result.failed ? 'failure' : 'success') : 'unknown',
    toolName: use.name,
    toolCategory: classifyTool(use.name, command),
    raw: { adapter: 'claude-code', ref: `${file}#tool` },
  };
  if (use.todos) event.todos = use.todos;
  if (use.taskOp) event.taskOp = use.taskOp;
  if (turnId) event.turnId = turnId;
  if (use.agentId) event.agentId = use.agentId;
  return event;
}

/**
 * Tool calls as a transcript is tailed (3c / RFC step 4): a tool_use is held
 * until its tool_result arrives, then becomes a tool_call with that result's
 * status and time. Hooks report the same calls with the same ids, so where
 * both are on, whichever comes first counts and the other is dropped; where
 * the project has no hooks (the core collects every project, VS Code adds
 * hooks only to those it opens), this is where its tool calls come from. Only
 * a call's name, file path or command (and a TodoWrite call's todo list, its
 * text only with capture on, or a task tool's input) are kept while it waits;
 * one whose result comes after a restart is lost. A task tool's change to the
 * plan is read when its result arrives, which holds a new task's id.
 */
export class LiveToolCalls {
  private readonly pending = new Map<string, { name?: string; input: { file_path?: unknown; command?: unknown }; todos?: EventTodos; taskInput?: unknown; sessionId?: string; agentId?: string; ts: string; turnId?: string }>();

  constructor(private readonly maxPending = 2_000) {}

  /** The tool calls this transcript line completes. */
  observe(line: any, file: string, turnId: string | undefined, captureContent = false): NormalizedEvent[] {
    if (!Array.isArray(line?.message?.content)) return [];
    if (line.type === 'assistant') {
      for (const b of line.message.content) {
        if (b?.type !== 'tool_use' || !b.id) continue;
        const input = b.input ?? {};
        const todos = todosOf(b.name, input, captureContent);
        // Only what taskOpOf reads; the subject is dropped there without capture.
        const taskInput = TASK_TOOLS.has(b.name) ? { subject: input.subject, taskId: input.taskId, id: input.id, task_id: input.task_id, status: input.status } : undefined;
        this.pending.set(b.id, { name: b.name, input: { file_path: input.file_path, command: input.command }, ...(todos ? { todos } : {}), ...(taskInput ? { taskInput } : {}), sessionId: line.sessionId, agentId: line.agentId, ts: line.timestamp, turnId });
        if (this.pending.size > this.maxPending) this.pending.delete(this.pending.keys().next().value!);
      }
      return [];
    }
    if (line.type !== 'user') return [];
    const out: NormalizedEvent[] = [];
    for (const b of line.message.content) {
      if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
      const use = this.pending.get(b.tool_use_id);
      if (!use) continue;
      this.pending.delete(b.tool_use_id);
      const failed = b.is_error === true;
      const { taskInput, ...rest } = use;
      const taskOp = taskInput ? taskOpOf(use.name, taskInput, resultOutput(line, b), captureContent, failed) : undefined;
      out.push(toolCallEvent({ ...rest, ...(taskOp ? { taskOp } : {}), id: b.tool_use_id, fallbackId: `tool:${b.tool_use_id}` }, { failed, ts: line.timestamp ?? use.ts }, file, use.turnId));
    }
    return out;
  }
}

/** Tool calls rebuilt from tool_use blocks, with status and time from the matching tool_result. */
export function transcriptToolCalls(lines: any[], file: string, turns: TurnTracker, captureContent = false): NormalizedEvent[] {
  const results = new Map<string, { failed: boolean; ts: string; output: unknown }>();
  for (const d of lines) {
    if (d?.type !== 'user' || !Array.isArray(d.message?.content)) continue;
    for (const b of d.message.content) {
      if (b?.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { failed: b.is_error === true, ts: d.timestamp, output: resultOutput(d, b) });
    }
  }
  const events: NormalizedEvent[] = [];
  for (const d of lines) {
    if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
    const turnId = turns.observe(file, d); // re-observing is idempotent
    d.message.content.forEach((b: any, index: number) => {
      if (b?.type !== 'tool_use') return;
      const result = b.id ? results.get(b.id) : undefined;
      const todos = todosOf(b.name, b.input, captureContent);
      // A task tool's change needs its result (a new task's id); with none yet, there's nothing to apply.
      const taskOp = result ? taskOpOf(b.name, b.input, result.output, captureContent, result.failed) : undefined;
      events.push(toolCallEvent({ id: b.id, name: b.name, input: b.input, ...(todos ? { todos } : {}), ...(taskOp ? { taskOp } : {}), sessionId: d.sessionId, agentId: d.agentId, ts: d.timestamp, fallbackId: `tool:${d.uuid}:${index}` }, result, file, turnId));
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
    events.push(...transcriptToolCalls(parsed, file, turns, opts.captureContent));
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
