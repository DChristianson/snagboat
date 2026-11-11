import type { EventToolCategory } from './toolCategory';

export type BuiltInAgentId = 'claude-code' | 'copilot' | 'generic-fs';
export type AgentId = BuiltInAgentId | `custom:${string}`;

export type NormalizedEventKind =
  | 'tool_call'
  | 'edit'
  | 'turn_start'
  | 'turn_stop'
  /** You submitted a prompt. Its text is in promptText when text capture is on. */
  | 'user_prompt'
  /** The conversation's context was compacted. */
  | 'compaction'
  /** The session's name (a generated title, or one you set) changed; see sessionName. */
  | 'session_name'
  /**
   * Something that measures how the work went, worked out by Snagboat rather than
   * reported by an agent (schema v3): see outcome. Not agent activity: it neither
   * counts toward totals nor keeps a session or a heuristic's window alive.
   */
  | 'outcome';

export interface EventTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** What an outcome event measures (schema v3). */
export type OutcomeType =
  /** A test or build tool call succeeded after failing in the same session. */
  | 'tests_green'
  /** A finding's episode ended; response says how you met it. */
  | 'finding_response';

/** How you met a finding: marked it useful, muted it, acknowledged it, or let it pass. */
export type FindingResponse = 'useful' | 'muted' | 'acknowledged' | 'passed';

export interface EventOutcome {
  type: OutcomeType;
  /** The events it's about: for tests_green the first failing and the passing run; for finding_response the finding's events. */
  refs?: string[];
  /** tests_green: failed runs before it went green. */
  failures?: number;
  /** tests_green: milliseconds from the first failure to green. */
  afterMs?: number;
  /** finding_response: the heuristic or rule. */
  heuristicId?: string;
  /** finding_response. */
  response?: FindingResponse;
}

export interface NormalizedEvent {
  eventId: string;
  sessionId: string;
  agent: AgentId;
  ts: string;
  kind: NormalizedEventKind;
  target?: string;
  status: 'success' | 'failure' | 'unknown';
  model?: string;
  tokens?: EventTokens;
  /** The agent's own reply text, truncated and redacted; present only when snagboat.captureContent is on. */
  textExcerpt?: string;
  /** user_prompt events: the prompt's text, capped at 2,000 characters and redacted; present only when snagboat.captureContent is on. */
  promptText?: string;
  /** session_name events: the session's name. */
  sessionName?: string;
  /** The prompt (turn) this event belongs to: Claude Code's promptId. */
  turnId?: string;
  /** Set for work done by a subagent; absent for the main agent. */
  agentId?: string;
  /** For tool calls: the tool's name as the agent reported it. */
  toolName?: string;
  /** For tool calls: high-level category (see toolCategory.ts). */
  toolCategory?: EventToolCategory;
  /**
   * 'inline' marks model calls made by editor features (Copilot's inline and
   * next-edit suggestions, chat titles, intent detection) rather than an
   * agent turn: their tokens count, but they aren't turns.
   */
  channel?: 'inline';
  /**
   * Set on the event that ends a turn: the main agent's model call that
   * finished without requesting a tool, Claude Code's Stop hook, or a user
   * interruption. Until one arrives, the turn is still open.
   */
  endsTurn?: true;
  /** The model's prompt budget for this call, when the source reports it. */
  contextLimit?: number;
  /** For compaction events. */
  compaction?: {
    trigger: 'auto' | 'manual' | 'unknown';
    /** Context size that set it off. */
    preTokens?: number;
    /** Context size afterwards. */
    postTokens?: number;
  };
  /**
   * The workspace the event was recorded in (schema v2): its folder path, its
   * .code-workspace file path, or WORKSPACE_NO_FOLDER. Set on events in the
   * per-user store (~/.snagboat/data), which holds every workspace's events;
   * absent in a VS Code window's own storage, which holds only that window's.
   */
  workspace?: string;
  /** outcome events (schema v3): what was measured. */
  outcome?: EventOutcome;
  raw: {
    adapter: string;
    ref: string;
    event?: unknown;
  };
}

/** NormalizedEvent.workspace for a window with no folder open. */
export const WORKSPACE_NO_FOLDER = '(no folder)';

export interface AdapterCheckpoint {
  updatedAt: string;
  state: Record<string, unknown>;
}

export interface AdapterContext {
  publish(event: NormalizedEvent): void;
  readCheckpoint(): Promise<AdapterCheckpoint | undefined>;
  writeCheckpoint(checkpoint: AdapterCheckpoint): Promise<void>;
  /** Reports (or clears, with `message: undefined`) a named health concern for this adapter. */
  reportHealth(key: string, message: string | undefined): void;
  /** Whether snagboat.captureContent is on right now; read per event so toggling takes effect immediately. */
  captureContent(): boolean;
}

export interface AgentAdapter {
  readonly agentId: AgentId;
  init(ctx: AdapterContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
