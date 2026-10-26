import type { ToolCategory } from './toolCategory';

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
  | 'session_name';

export interface EventTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
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
  toolCategory?: ToolCategory;
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
  raw: {
    adapter: string;
    ref: string;
    event?: unknown;
  };
}

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
