# Common schema and transformation matrix

## `NormalizedEvent`

```ts
type BuiltInAgentId = 'claude-code' | 'copilot' | 'generic-fs';
type AgentId = BuiltInAgentId | `custom:${string}`;

interface NormalizedEvent {
  eventId: string;
  sessionId: string;
  agent: AgentId;
  ts: string;
  kind: 'tool_call' | 'tool_result' | 'edit' | 'test_run'
    | 'turn_start' | 'turn_stop';
  target?: string;
  status: 'success' | 'failure' | 'unknown';
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  textExcerpt?: string;
  confidence?: number;
  raw: {
    adapter: string;
    ref: string;
    event?: unknown;
  };
}
```

`confidence` is intentionally optional. Current Claude Code and Copilot integrations do not expose a trustworthy probability signal, but reserving the field now avoids a future schema migration. Built-in agent IDs stay explicit while third-party adapters should use a namespaced `custom:*` identifier. `raw.event` is optional and exists only for inspection or debugging when keeping part of the source payload is worth the extra storage.

`model` is optional and populated per event where the source reliably reports it, since coverage varies by adapter: the Claude Code transcript carries `message.model` directly alongside `message.usage` on every assistant turn, so the `claude-code` adapter should populate it whenever it emits token-bearing `turn_stop` events. Copilot OTel spans/metrics are expected to carry the model via the OpenTelemetry GenAI semantic conventions (`gen_ai.request.model` / `gen_ai.response.model`), so the `copilot` adapter's OTel path should populate it once that is verified against a live capture. Copilot's log-scrape path should leave `model` unset rather than guessing: its local session log's model field is consistently empty regardless of which model actually served the request. Per-event `model` is intended to support future per-model cost-weighting in longer-horizon rollups, distinct from the flat token totals used today.

## Transformation matrix

Every adapter should document how each raw signal maps into the shared schema.

| Raw signal | Source | `kind` | `target` | `status` | `tokens` | `textExcerpt` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PostToolUse` hook payload | Claude Code | `tool_call` | `tool_input.file_path` or `.command` | Derived from `tool_response.error` | — | — | Hooks provide structure but not usage. |
| `Stop` hook payload | Claude Code | `turn_stop` | — | `unknown` | — | — | Marks turn boundaries for windowed heuristics. |
| Transcript message with usage block | Claude Code JSONL | `turn_stop` | — | `unknown` | Direct map from `input_tokens`, `output_tokens`, and cache fields | Full text when not redacted | Primary token-accounting source. |
| Transcript message text | Claude Code JSONL | Decorates the owning `turn_stop` event | — | `unknown` | — | `text` content blocks only, truncated to 500 characters, when `snagboat.captureContent` is on | Heuristics mine this captured text later; adapters do not need to invent a separate hedge event. |
| `gen_ai.output.messages` on `invoke_agent` | Copilot OTel | Decorates the span's `turn_stop` event | — | — | — | Assistant `text` parts only, truncated to 500 characters, when both `snagboat.captureContent` and Copilot's `captureContent` are on | JSON string per the OpenTelemetry GenAI output-messages schema: `[{role, parts: [{type, content}], finish_reason}]`. |
| `execute_tool` span | Copilot OTel | `tool_call` | Span attributes for tool name or args | Span status code | — | — | Higher-fidelity tool activity path. |
| `execute_hook` span | Copilot OTel | `tool_call` | `hook_type` attribute | `hook_result_kind` mapping | — | — | Annotation-oriented signal. |
| `gen_ai.client.token.usage` metric | Copilot OTel | Attached to nearest `turn_stop` | — | — | Input/output totals joined by time window and session id | — | Metric stream rather than span data. |
| Session log line | Copilot log-scrape | `tool_call` or `turn_stop` | Best effort from log fields | Best effort | Estimated only | Present when the log stores it | Lower-fidelity fallback path. |
| `onDidSaveTextDocument` | Generic FS | `edit` | File path | `unknown` | — | — | Provides churn and backtracking input even without agent data. |
| Terminal exit code | Generic FS | `test_run` | Command string | `success` when exit code is 0, else `failure` | — | — | Shell-integration driven. |
| `git diff` polling | Generic FS | Supplementary `edit` context | File path | — | — | — | Separates real content changes from no-op saves. |

This matrix is the adapter conformance spec. New adapters should not be accepted without an equivalent mapping table for every raw signal they introduce.

## Retention-aligned fields

The schema is designed so sensitive content remains optional:

- structural fields (`kind`, `status`, `target`, `tokens`) support most heuristics and reporting
- `textExcerpt` is opt-in and, like every field, stored in the daily event log and retained for `snagboat.retention.rawDays`; per-field retention is planned (see [PRIVACY.md](../PRIVACY.md#retention))
- `target` is structural for file paths but can carry sensitive content for shell commands, so it is a candidate for per-field retention too
- `raw.ref` points back to source material without copying entire payloads into the normalized record
- `raw.event` is optional debug data and should be omitted unless an adapter has a clear inspection need

## `raw.ref` contract

`raw.ref` should be treated as an adapter-defined opaque identifier with two constraints:

- it must stay stable for as long as the referenced raw log entry is retained
- when the source is file-backed, it should prefer a file path or URI plus a line or byte offset so humans and tools can resolve it directly

Examples include `transcripts/session.jsonl#L128`, `file:///.../copilot.log#offset=4096`, or another adapter-specific reference that can be mapped back to a single raw record.
