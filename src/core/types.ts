export type BuiltInAgentId = 'claude-code' | 'copilot' | 'generic-fs';
export type AgentId = BuiltInAgentId | `custom:${string}`;

export type NormalizedEventKind =
  | 'tool_call'
  | 'edit'
  | 'turn_start'
  | 'turn_stop'
  /** You submitted a prompt. A marker only: prompt text is never stored. */
  | 'user_prompt'
  /** The conversation's context was compacted. */
  | 'compaction';

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
  /** The agent's own reply text, truncated; present only when snagboat.captureContent is on. */
  textExcerpt?: string;
  /** The prompt (turn) this event belongs to: Claude Code's promptId. */
  turnId?: string;
  /** Set for work done by a subagent; absent for the main agent. */
  agentId?: string;
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
