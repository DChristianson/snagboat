import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '../../core/types';
import { classifyTool } from '../../core/toolCategory';
import { makeExcerpt, makePromptText, redactSecrets } from '../../core/excerpt';
import { sessionNameId } from '../../core/sessions';

/**
 * Copilot agent sessions, read from the Copilot CLI's own event log at
 * ~/.copilot/session-state/<session>/events.jsonl. In current VS Code, Agent
 * mode runs in the built-in agent host through the Copilot CLI, which exports
 * no OpenTelemetry, so this log is the only record of agent turns. Event
 * shapes were checked against real sessions (structure only); see
 * docs/design/conversation-view.md.
 *
 * Mapping:
 *   user.message              -> user_prompt (with promptText when content capture is on)
 *   session.usage_record      -> turn_stop (one model call, with its usage and maxPromptTokens)
 *   assistant.message         -> turn_stop without tokens: endsTurn when it requests no tools,
 *                                and the reply's textExcerpt when content capture is on. Its
 *                                usage_record (same apiCallId) comes just before it.
 *   tool.execution_complete   -> tool_call (name and arguments from its tool.execution_start)
 * Turns: a user.message's interactionId starts a turn; other events carry
 * interactionId themselves or inherit their parent's turn via parentId.
 */

/** Where the Copilot CLI keeps its sessions. Test/CI seam: SNAGBOAT_COPILOT_SESSIONS_DIR. */
export function resolveCopilotSessionsDir(): string {
  return process.env.SNAGBOAT_COPILOT_SESSIONS_DIR ?? path.join(os.homedir(), '.copilot', 'session-state');
}

/**
 * Whether a session id is a Copilot agent session: Copilot keeps a folder per
 * session, and Claude Code session ids never have one. Copilot runs the hooks
 * in a project's .claude/settings.json too, Snagboat's included, so the hook
 * receiver uses this to leave those sessions to the Copilot adapter.
 */
export function isCopilotSession(sessionId: string, sessionsDir = resolveCopilotSessionsDir()): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) && fs.existsSync(path.join(sessionsDir, sessionId, 'events.jsonl'));
}

interface CliEvent {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  data?: any;
}

/** Per-session parsing state (one events.jsonl per session). */
export class CopilotCliState {
  sessionId?: string;
  cwd?: string;
  lastTurn?: string;
  /** The session name last published, so a name is published again only when it changes. */
  lastName?: string;
  private turnById = new Map<string, string>();
  private toolStarts = new Map<string, { name?: string; args?: Record<string, unknown> }>();

  constructor(initialLastTurn?: string, private readonly limit = 20_000) {
    this.lastTurn = initialLastTurn;
  }

  observeTurn(e: CliEvent): string | undefined {
    const own = typeof e.data?.interactionId === 'string' ? e.data.interactionId : undefined;
    const turn =
      e.type === 'user.message'
        ? own ?? e.id
        : own ?? (e.parentId ? this.turnById.get(e.parentId) : undefined) ?? this.lastTurn;
    if (turn) {
      if (e.id) {
        this.turnById.set(e.id, turn);
        if (this.turnById.size > this.limit) this.turnById.delete(this.turnById.keys().next().value as string);
      }
      this.lastTurn = turn;
    }
    return turn;
  }

  recordToolStart(id: string, name: string | undefined, args: Record<string, unknown> | undefined): void {
    this.toolStarts.set(id, { name, args });
    if (this.toolStarts.size > 2_000) this.toolStarts.delete(this.toolStarts.keys().next().value as string);
  }

  takeToolStart(id: string): { name?: string; args?: Record<string, unknown> } | undefined {
    const start = this.toolStarts.get(id);
    this.toolStarts.delete(id);
    return start;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function normalizeCopilotCliChunk(
  rawLines: string[],
  filePath: string,
  chunkStartOffset: number,
  state: CopilotCliState,
  opts: { captureContent?: boolean } = {}
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const fallbackSession = path.basename(path.dirname(filePath));
  for (const raw of rawLines) {
    let e: CliEvent;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const data = e.data ?? {};
    if (e.type === 'session.start') {
      state.sessionId = str(data.sessionId) ?? state.sessionId;
      state.cwd = str(data.context?.cwd) ?? state.cwd;
      continue;
    }
    const turnId = state.observeTurn(e);
    const base = {
      sessionId: state.sessionId ?? fallbackSession,
      agent: 'copilot' as const,
      ts: e.timestamp ?? new Date().toISOString(),
      turnId,
      raw: { adapter: 'copilot-cli', ref: `${filePath}#offset~${chunkStartOffset}` },
    };

    if (e.type === 'user.message') {
      const promptText = opts.captureContent ? makePromptText([str(data.content)]) : undefined;
      events.push({ ...base, eventId: e.id ?? `${filePath}:${chunkStartOffset}:prompt`, kind: 'user_prompt', status: 'unknown', ...(promptText ? { promptText } : {}) });
    } else if (e.type === 'session.usage_record') {
      const u = data.usage ?? {};
      const cacheRead = num(u.cacheReadTokens) ?? 0;
      const cacheWrite = num(u.cacheWriteTokens) ?? 0;
      // inputTokens already includes cached tokens (checked on real sessions), so subtract them out.
      const input = Math.max((num(u.inputTokens) ?? 0) - cacheRead - cacheWrite, 0);
      events.push({
        ...base,
        eventId: e.id ?? `${filePath}:${chunkStartOffset}:usage`,
        kind: 'turn_stop',
        status: 'unknown',
        model: str(u.model),
        tokens: { input, output: num(u.outputTokens) ?? 0, cacheRead, cacheCreation: cacheWrite },
        contextLimit: num(u.maxPromptTokens),
      });
    } else if (e.type === 'assistant.message') {
      // A reply that requests no tools finishes the turn.
      const ends = Array.isArray(data.toolRequests) && data.toolRequests.length === 0 && !str(data.parentToolCallId);
      const textExcerpt = opts.captureContent ? makeExcerpt([str(data.content)]) : undefined;
      if (ends || textExcerpt) {
        events.push({
          ...base,
          eventId: `${e.id ?? `${filePath}:${chunkStartOffset}`}:${ends ? 'end' : 'reply'}`,
          kind: 'turn_stop',
          status: 'unknown',
          model: str(data.model),
          ...(ends ? { endsTurn: true } : {}),
          ...(textExcerpt ? { textExcerpt } : {}),
        });
      }
    } else if (e.type === 'tool.execution_start' && str(data.toolCallId)) {
      state.recordToolStart(data.toolCallId, str(data.toolName), data.arguments && typeof data.arguments === 'object' ? data.arguments : undefined);
    } else if (e.type === 'tool.execution_complete') {
      const start = str(data.toolCallId) ? state.takeToolStart(data.toolCallId) : undefined;
      const name = start?.name ?? str(data.toolName);
      const args = start?.args ?? {};
      const command = str(args.command);
      const exitCode = num(data.shellExecution?.exitCode);
      events.push({
        ...base,
        eventId: e.id ?? `${filePath}:${chunkStartOffset}:tool`,
        kind: 'tool_call',
        target: command ?? str(args.path) ?? str(args.file_path) ?? str(args.filePath),
        status: data.success === false || (exitCode !== undefined && exitCode !== 0) ? 'failure' : data.success === true ? 'success' : 'unknown',
        toolName: name,
        toolCategory: classifyTool(name, command),
        model: str(data.model),
      });
    }
  }
  return events;
}

/** The working directory a session started in, from its session.start event (the first lines of the file). */
export function readSessionCwd(eventsFile: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(eventsFile, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  for (const line of head.split('\n')) {
    try {
      const e = JSON.parse(line) as CliEvent;
      if (e?.type === 'session.start') return str(e.data?.context?.cwd);
    } catch {
      // partial last line of the read window
    }
  }
  return undefined;
}

/**
 * The session's name from the workspace.yaml Copilot keeps beside events.jsonl:
 * a generated title, or one you set (user_named). A minimal reader for the
 * top-level scalar keys it needs, not a YAML parser.
 */
export function readSessionName(eventsFile: string): { name: string; userNamed: boolean; updatedAt?: string } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(path.dirname(eventsFile), 'workspace.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const field = (key: string) => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text);
    if (!m) return undefined;
    const raw = m[1].trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    return quoted ? quoted[2] : raw;
  };
  const name = field('name');
  if (!name || name === '~' || name === 'null') return undefined;
  return { name, userNamed: field('user_named') === 'true', updatedAt: field('updated_at') };
}

/** A session_name event for a Copilot session, keyed like Claude Code's so a repeat is dropped as already logged. */
export function copilotSessionNameEvent(sessionId: string, name: string, eventsFile: string, ts: string | undefined): NormalizedEvent {
  const parsed = ts ? Date.parse(ts) : NaN;
  return {
    eventId: sessionNameId('copilot', sessionId, name),
    sessionId,
    agent: 'copilot',
    ts: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
    kind: 'session_name',
    status: 'unknown',
    sessionName: redactSecrets(name),
    raw: { adapter: 'copilot-cli', ref: `${eventsFile}#workspace.yaml` },
  };
}
