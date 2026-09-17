# Architecture

## Design principle

Adapters know agent-specific formats; nothing downstream does. The normalization layer is the only place that understands the common schema, which keeps new adapters additive instead of invasive.

## Adapter contract

```ts
interface AgentAdapter {
  readonly agentId: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  onRawEvent(cb: (raw: RawAgentEvent) => void): Disposable;
}
```

Adapters emit raw, agent-native events. Core code is responsible for turning those events into `NormalizedEvent` records.

## Planned built-in adapters

### `claude-code-adapter`

- Registers `PostToolUse` and `Stop` hooks.
- Tails the Claude Code JSONL transcript for the workspace.
- Uses hooks and transcripts as redundant data paths so token usage and text still work when hooks are missing.

### `copilot-adapter`

Two user-selectable modes:

1. **OTel mode** — run a local OTLP HTTP receiver and configure Copilot to export to it with concrete settings such as `github.copilot.chat.otel.enabled`, `github.copilot.chat.otel.otlpEndpoint`, `github.copilot.chat.otel.exporterType`, and the optional `github.copilot.chat.otel.captureContent` toggle for text capture.
2. **Log-scrape mode** — parse Copilot Chat local session logs directly for zero-configuration fallback coverage.

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
