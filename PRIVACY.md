# Privacy

Snagboat keeps everything it observes on the developer's machine. Nothing is sent off-machine, and there is no telemetry of the extension itself.

## What is captured

Each observed action becomes one normalized event (see [docs/schema.md](docs/schema.md)). Most fields are structural (kind, status, timestamps, session id, model, token counts), but some carry details of what the agent did:

| Source | Field | What it holds |
| --- | --- | --- |
| Claude Code hooks | `target` | The tool's `file_path`, or the **full shell command string** for Bash calls. Commands can contain secrets such as tokens in headers, credentials in connection strings, or exported environment variables. |
| Claude Code hooks | `raw.ref` | The tool name (`hook:PostToolUse:<tool>`) |
| Claude Code transcript | `raw.ref` | The transcript file path and byte offset the event came from |
| Claude Code transcript | `user_prompt` events | **When** you sent each prompt, and its id. Never the prompt's text. |
| Claude Code transcript | `compaction` events | When the context was compacted, whether automatically or by you, and the context size before and after |
| Claude Code hooks, Copilot OTel | `toolName`, `toolCategory` | The tool's name and a high-level category (e.g. "Tests and builds"). The category is derived from the command already stored in `target`, so it adds no new information. |
| Claude Code transcript and hooks | `turnId`, `agentId` | Which prompt each model call and tool call belongs to, and which subagent (by Claude Code's id) did the work |
| Copilot OTel | `target` | The tool or hook name only, not its arguments |
| Edit tracker | `target`, `raw.ref` | The saved file's path and URI, not its contents |
| Claude Code transcript, only with `snagboat.captureContent` | `textExcerpt` | The reply's `text` blocks, truncated to 500 characters. Never thinking blocks or tool inputs. |
| Copilot OTel, only with `snagboat.captureContent` **and** Copilot's `github.copilot.chat.otel.captureContent` | `textExcerpt` | The assistant `text` parts of `gen_ai.output.messages`, truncated to 500 characters. Never reasoning parts, prompts, tool arguments, or tool results. |

Never captured: file contents, edit diffs, tool output, search patterns, and the text of your prompts.

Snagboat reads subagent transcripts (`<session>/subagents/*.jsonl` under Claude Code's project folder) the same way as main session transcripts.

### Captured text

`snagboat.captureContent` is off by default. When on, it adds the agent's own reply text to each turn event as `textExcerpt`, for the verbal-hedge heuristic. That text is stored **in the same event logs as everything else**, not in a separate store, until the shape of captured data is better understood. Turning the setting off stops new capture; excerpts already logged stay until their day ages out under `rawDays` or the log is cleared. Token tracking and the behavioral heuristics never require it.

Note that Copilot's own `github.copilot.chat.otel.captureContent` makes Copilot send full prompts, replies, and tool results to Snagboat's local receiver. Snagboat keeps only the truncated reply text and discards the rest without logging it.

## Where data is stored

All under the extension's per-workspace storage folder unless noted:

| Store | Contents | Retention |
| --- | --- | --- |
| `events/<date>.jsonl` | Every normalized event, including `target` and, when capture is on, `textExcerpt` | `snagboat.retention.rawDays` (default 90 days, counting today) |
| `aggregates/<date>.json` | Per-day, per-agent token and event counts. No targets or text. | `snagboat.retention.aggregateDays` (default `-1`, kept indefinitely; `0` keeps none) |
| `checkpoints/<adapter>.json` | Read offsets into Claude Code transcript files (including subagent transcripts), the last few API message ids seen in each, and each file's most recent prompt id, keyed by transcript path | Until cleared manually; not covered by `Clear Event Log` |
| VS Code workspace state | The list of muted heuristics | Until unmuted |
| VS Code webview state | The detail view's filters, including the timeline search text | Managed by VS Code |
| VS Code extension host log | Diagnostic messages: file paths, port errors, and, for hook or OTLP requests Snagboat couldn't parse or map, only their size and hook/tool names, never payload contents | Managed by VS Code |
| VS Code global storage: `copilot-structure/<date>.jsonl` | Only with `snagboat.copilot.captureStructure` on (off by default): the shape of Copilot's telemetry, meaning span names, ids, parent links, timings, attribute names, and numeric or true/false values such as token counts. Every text value is replaced by its length, so no prompts, replies, tool arguments, paths, or model names. | Until deleted by hand |
| VS Code global storage: `context-limits.json` | Per model name: the largest context seen, and the context at which an automatic compaction happened, with when. Shared by all workspaces. No content. | Until Snagboat is uninstalled |
| `~/.snagboat/routes/<folder>` | One file per open workspace folder: the local port, a random auth token, and the VS Code process id, so hooks reach the right window. Owner-only (`0600`). | Removed when the window closes; leftovers from crashed windows are removed on the next activation |
| `~/.snagboat/bin/snagboat-hook` | The hook forwarder script that Claude Code runs | Rewritten on every activation |
| `<project>/.claude/settings.json` | Outside Snagboat's storage: the `PostToolUse`/`Stop` hook entries Snagboat adds so Claude Code runs `snagboat-hook` | Until removed by hand |

Snagboat also reads data it doesn't own: Claude Code transcripts (`~/.claude/projects/…`) and Copilot's OTel export. It never modifies or deletes them.

## Retention

On activation, hourly, and whenever the retention settings change, raw daily files older than `rawDays` are rolled up into `aggregates/<date>.json` and deleted, and aggregates older than `aggregateDays` are removed. Today there is **one retention clock for every field** in an event: a shell command or a text excerpt lives exactly as long as the event it belongs to. Events are filed under the day they happened, so history caught up from an old transcript is retained by its own date; anything older than `rawDays` goes straight into that day's aggregate, and anything older than `aggregateDays` isn't stored.

**Planned: per-field retention.** Establish separate retention for the more sensitive fields (command-string targets, `textExcerpt`, possibly file paths), likely by scrubbing those fields from older events in place rather than splitting them into another store. This replaces the earlier `snagboat.retention.textDays` design and should be decided once real captured data shows which fields need it.

## User controls

- `Snagboat: Clear Event Log` (`snagboat.clearLog`) deletes all raw logs and daily aggregates after a confirmation prompt. Adapter checkpoints are kept so already-seen transcript history is not re-imported.
- `snagboat.captureContent` is opt-in, and its setting description states that captured text is kept as long as raw events (`rawDays`). The detail view shows whether capture is on.

## Design guardrails

- Logs stay local. Any future sharing or sync feature must be a separate, clearly labeled opt-in.
- Adapters prefer pointers back to source data (`raw.ref`) over copying payloads into events.
- Heuristics and UI must work without `textExcerpt`.
- Token tracking must not require content capture.
