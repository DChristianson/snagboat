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
  reportHealth(key: string, message: string | undefined): void;
}

interface AgentAdapter {
  readonly agentId: AgentId;
  init(ctx: AdapterContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Snagboat initializes an adapter once with an `AdapterContext`, then starts and stops collection separately. Adapters publish `NormalizedEvent` records directly through the context event stream, optionally embedding the source agent payload in `event.raw.event` for inspection or debugging. Checkpoints are adapter-owned state blobs so polling adapters can resume from the last processed file, line, or byte offset instead of rescanning from the beginning. `reportHealth(key, message)` lets an adapter surface (or clear, by passing `undefined`) a named concern — e.g. "no workspace folder open" or "receiver failed to bind its port" — so genuine problems are visible in the status bar's health section instead of only in the Debug Console; `key` scopes independent concerns within the same adapter (e.g. `claude-code` can report both a `transcripts` and a `hooks` issue at once without one clobbering the other).

## Planned built-in adapters

### `claude-code-adapter`

- Registers `PostToolUse` and `Stop` hooks, routed per window: the hook entry in each project's `.claude/settings.json` runs a stable POSIX script (`~/.snagboat/bin/snagboat-hook`, sh + curl, ~12ms). Each VS Code window listens on its own OS-assigned port and writes `~/.snagboat/routes/<folder>` (port, random token, pid) for each workspace folder; the script walks up from `CLAUDE_PROJECT_DIR` to the nearest route whose pid is alive and posts with that token. Receivers reject requests without the token, and refuse hooks whose project (sent by the script as `X-Snagboat-Project-Dir`, i.e. `CLAUDE_PROJECT_DIR`) is outside their folders, which guards against route-name collisions (`/w/x-y` and `/w/x/y` share a route name). The payload's `cwd` is not used for routing or checks: it follows Claude into other directories and worktrees mid-session. Modeled on Claude Code's own IDE discovery files (`~/.claude/ide/<port>.lock`).
- Tails the Claude Code JSONL transcript for the workspace, emitting one `turn_stop` per API message: each response is written as one line per content block, all repeating the message's `usage`, so lines are merged by `message.id`. Recent message ids per file are kept in the adapter checkpoint, so a message split across reads or a restart is still counted once. `npm run verify:transcripts` replays this project's real transcripts to check the totals. File watching uses Node's `fs.watch` on the transcripts folder (filtering for `.jsonl`) plus a rescan every 60 seconds, which catches any event `fs.watch` misses and restarts the watch if the folder was removed; duplicate events are harmless since reads resume from the saved offset and take only complete lines. A watch can't be placed on a folder that doesn't exist yet, so when a project has no Claude Code session yet the tailer checks for the folder every 15 minutes and then reads each transcript from the top. Read and watcher errors are reported as health issues per transcript file.
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

- Raw storage format: append-only daily JSONL files under the extension storage URI, one per UTC day, with each event filed under the day it happened (its `ts`), not the day it was written, so catching up on an old transcript files history under the right days.
- Each day lives in exactly one place: its raw file while inside `rawDays`, its daily aggregate once rolled up. `EventSink` routes each incoming event accordingly: to the day's raw file if it has one or is inside the raw window; otherwise merged into the day's aggregate (batched, on the same queue as retention runs); and not stored at all if older than aggregate retention, in which case it's also left out of the all-time totals. Retention releases a day before rolling it up, so an event arriving mid-rollup goes to the aggregate rather than a raw file about to be deleted.
- Default behavior: local-only, no sync, no telemetry.
- Queryability: readable directly via `jq`, DuckDB, or notebooks.
- Optional export: `snagboat.exportLog` should offer SQLite and CSV export.
- Optional SQLite side index: rebuilt from JSONL if missing or corrupt so JSONL remains the source of truth.
- Retention (implemented): raw days past `snagboat.retention.rawDays` are rolled up into per-day `DailyAggregate` JSON files under `aggregates/` (written atomically before the raw file is deleted), and those are pruned past `snagboat.retention.aggregateDays`. `Aggregate` rehydrates from daily aggregates plus surviving raw days, preferring raw when both exist for a day, so the status bar's all-time totals survive rollup. `EventStore` is unaffected: its window is far shorter than any retention period.

## Event query interface: `EventStore`

Implemented as part of v1's heuristics engine. `EventStore` is the single well-defined query interface heuristics are allowed to use for event data — direct access to `EventLog` or `Aggregate` is not permitted, an explicit design requirement so heuristics can't quietly grow ad hoc coupling to storage internals.

```ts
interface EventQuery {
  since?: string; until?: string;
  kinds?: NormalizedEventKind[]; agents?: AgentId[];
  sessionId?: string; target?: string; limit?: number;
}
interface TokenTotals { input: number; output: number; cacheRead: number; cacheCreation: number; }

interface ReadonlyEventStore {          // the interface heuristics actually see
  query(filter?: EventQuery): NormalizedEvent[];
  lastN(n: number): NormalizedEvent[];
  latestTs(): string | undefined;
  cumulativeTokens(scope: { sessionId?: string; day?: string }): TokenTotals;
}
```

Design notes:

- Holds a bounded in-memory window of recent events (sized generously at startup from configured heuristic windows) plus separate incremental per-session and per-day token accumulators. Query-time never falls back to disk — the window is seeded once via `rehydrateFrom(eventLog)` and maintained incrementally via `ingest(event)`, so a query never re-parses the on-disk log. If a heuristic's window setting is later widened past what's retained, `query()` results silently truncate; this is a known limitation, not a solved one.
- `cumulativeTokens` is not a scan over the window — it's a separate accumulator, so `token-budget` stays correct for sessions/days that have scrolled out of the raw-event window.
- Coexists with `Aggregate` rather than merging into it: `Aggregate` answers "all-time per-agent totals for the status bar" (a different question, already shipped and tested); consolidating the two is a candidate for whenever retention/rollup work touches `Aggregate` anyway.

## Heuristics engine

`HeuristicsEngine` (see [heuristics.md](heuristics.md) for the `Heuristic`/`Finding` contract) runs on two triggers: pushed on every event (filtered cheaply by each heuristic's `appliesTo`, since a heuristic whose relevant kinds didn't change can't have a new verdict), and on a timer regardless of events (30s poll interval, a code constant not a setting) — required because some heuristics, like `stalled`, depend on the *absence* of events and can't be purely event-triggered. `FindingsRegistry` tracks the current set of findings per heuristic, mirroring `HealthRegistry`'s proven shape (replace-per-key, notify only on real change) — surfaced via the status bar's icon/text (worst active finding) and the tooltip/breakdown's `Findings:` section (all active findings). Findings themselves are in-memory only (recomputed from events), but the user's treatment of them isn't: a heuristic can be **acknowledged**, which hides its findings from the status bar until it next reports nothing (so a fresh occurrence resurfaces), or **muted**, which hides it from the status bar, tooltip, and breakdown indefinitely. Mutes persist per workspace in `workspaceState`; acknowledgements last only for the current episode and window. Both are set from the detail view.

## UI

### Status bar

A single item combines:

- today's token, agent-event, and local-edit totals across all agents (`TodayAggregate`). "Today" is the machine's **local** day, resetting at local midnight, even though daily log files and the `token-budget` day are keyed by UTC date. With `snagboat.retention.rawDays` at `1`, events from earlier in the local day can fall in a rolled-up UTC file and drop out of today's figure.
- a hover breakdown led by a `Today:` section, followed by all-time totals by agent (including a per-source cache-token breakdown) and an all-time grand total
- the worst active finding that is neither acknowledged nor muted (severity, then most recent)

Clicking the item opens the detail view; the plain-text breakdown remains available as `Snagboat: Show Token/Event Breakdown`.

### Detail webview

Implemented as `Snagboat: Open Detail View` (also the status bar's click action): a single webview panel (`DetailPanel`) fed a whole `DetailState` snapshot (`buildDetailState`, vscode-free and unit-tested), pushed on every model change, debounced to 500ms and only while the panel is visible. The page itself (`media/detail.js`/`.css`) is plain DOM with a strict nonce CSP and writes event data only via `textContent`. It includes:

- today's totals as tiles
- findings with acknowledge, mute/unmute, and "show events", which narrows the timeline to the finding's `eventRefs`
- a stacked per-day token chart by agent (7/30/90 days, keyed by UTC day to match retention rollups, with hover/focus tooltips and a table view), fed by `DailyHistory`, which spans all retained history (raw days plus daily aggregates). Series colors are fixed per agent (Claude Code, Copilot, then all other agents folded into one), validated for color-vision deficiency against VS Code's default light and dark surfaces.
- a filterable timeline (agent, kind, status, target/session text) of the newest 1,000 events from `EventStore`'s 24-hour window
- jump-to-file on any target that resolves to an existing file, absolute or relative to a workspace folder; the extension re-resolves the target itself rather than trusting the webview

The global, cross-workspace token budget treemap is still deferred: it needs shared storage across workspaces.

## Longer-horizon rollups

The design also reserves room for session/day/PR rollups that evaluate laziness, impatience, and hubris over longer windows than the short heuristics engine uses. If those rollups need more context than the current schema exposes, a future schema revision could add explicit annotations for concepts such as explanation-oriented turns or verification runs without overloading the current `kind` values.
