# Architecture

## Design principle

Adapters know agent-specific formats; nothing downstream does. The normalization layer is the only place that understands the common schema, which keeps new adapters additive instead of invasive.

## Adapter contract

```ts
interface AdapterCheckpoint {
  updatedAt: string;
  state: Record<string, unknown>;
}

interface AdapterContext {
  publish(event: NormalizedEvent): void;
  readCheckpoint(): Promise<AdapterCheckpoint | undefined>;
  writeCheckpoint(checkpoint: AdapterCheckpoint): Promise<void>;
}

interface AgentAdapter {
  readonly agentId: AgentId;
  init(ctx: AdapterContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Snagboat initializes an adapter once with an `AdapterContext`, then starts and stops collection separately. Adapters publish `NormalizedEvent` records directly through the context event stream, optionally embedding the source agent payload in `event.raw.event` for inspection or debugging. Checkpoints are adapter-owned state blobs so polling adapters can resume from the last processed file, line, or byte offset instead of rescanning from the beginning.

## Planned built-in adapters

### `claude-code-adapter`

- Registers `PostToolUse` and `Stop` hooks.
- Tails the Claude Code JSONL transcript for the workspace.
- Uses checkpoints to resume transcript tailing and hooks plus transcripts as redundant data paths so token usage and text still work when hooks are missing.

### `copilot-adapter`

Two user-selectable modes:

1. **OTel mode** — run a local OTLP HTTP receiver and configure Copilot to export to it. This is a real, shipped feature (VS Code 1.119+, added ~May 2026), confirmed against Microsoft's own [monitoring guide](https://code.visualstudio.com/docs/agents/guides/monitoring-agents) and [microsoft/vscode-copilot-chat's agent_monitoring.md](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md) — not just the placeholder setting names this doc originally guessed at. Confirmed settings: `github.copilot.chat.otel.enabled` (boolean), `github.copilot.chat.otel.otlpEndpoint` (default `http://localhost:4318`), `github.copilot.chat.otel.exporterType` (`"otlp-http"` | `"otlp-grpc"` | `"console"` | `"file"` — hyphenated, not `"otlp/http"`), and `github.copilot.chat.otel.captureContent` (boolean, opt-in). Confirmed span names: `invoke_agent` (carries `gen_ai.usage.input_tokens`/`.output_tokens` directly — the simplest token source), `chat`, `execute_tool`, `execute_hook`. Confirmed metric: `gen_ai.client.token.usage` (a Histogram, with a `gen_ai.token.type` attribute of `"input"`/`"output"`). Important gotcha: `session.id` is a **resource-level** attribute (attached once per `resourceSpans`/`resourceMetrics` entry), not a per-span/per-datapoint one.
2. **Log-scrape mode** — parse Copilot Chat local session logs directly for zero-configuration fallback coverage, resuming from the last saved checkpoint. Confirmed on a real local log file: the model field in "request done" lines is always empty (`model deployment ID: []`) regardless of which model served the request, so this mode must never populate `model` or `tokens` — event/status only.

Content capture remains an explicit opt-in because it affects privacy and retention. The design should treat upstream Copilot monitoring docs as the authoritative source for any additional OTel settings such as exporter headers or debug-span exporters.

### `generic-fs-adapter`

- Watches `workspace.onDidSaveTextDocument`.
- Uses terminal shell-integration exit codes for command/test results.
- Polls `git status` and `git diff` to separate real edits from no-op saves.

This adapter stays active regardless of chat agent so behavioral heuristics still have a stable fallback signal.

## Extension points

- `snagboat.adapters` — lets third parties register new adapters through `package.json` contributions.
- `snagboat.heuristics` — lets teams ship project-specific heuristics without forking core.

Every new adapter should add or update its row in the transformation matrix documented in [docs/schema.md](schema.md).

## Event log and indexing

- Raw storage format: append-only daily JSONL files under the extension storage URI.
- Default behavior: local-only, no sync, no telemetry.
- Queryability: readable directly via `jq`, DuckDB, or notebooks.
- Optional export: `snagboat.exportLog` should offer SQLite and CSV export.
- Optional SQLite side index: rebuilt from JSONL if missing or corrupt so JSONL remains the source of truth.

## UI

### Status bar

A single item combines:

- today's token total across all agents
- a hover breakdown by agent
- the worst unacknowledged finding in the current window

### Detail webview

The planned detail page includes:

- a filterable timeline of normalized events
- linked findings and triggering events
- acknowledge/mute support per finding
- jump-to-file actions
- a per-agent, per-day token usage chart

## Longer-horizon rollups

The design also reserves room for session/day/PR rollups that evaluate laziness, impatience, and hubris over longer windows than the short heuristics engine uses. If those rollups need more context than the current schema exposes, a future schema revision could add explicit annotations for concepts such as explanation-oriented turns or verification runs without overloading the current `kind` values.
