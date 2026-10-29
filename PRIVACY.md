# Privacy

Snagboat keeps everything it observes on the developer's machine, and there is no telemetry of the extension itself. The one exception is the optional advisor: if you add a hosted provider and approve its payload, a redacted digest of the session you ask about is sent to it (see [The advisor](#the-advisor)).

## What is captured

Each observed action becomes one normalized event (see [docs/schema.md](docs/schema.md)). Most fields are structural (kind, status, timestamps, session id, model, token counts), but some carry details of what the agent did:

| Source | Field | What it holds |
| --- | --- | --- |
| Claude Code hooks | `target` | The tool's `file_path`, or the **full shell command string** for Bash calls. Commands can contain secrets such as tokens in headers, credentials in connection strings, or exported environment variables. |
| Claude Code hooks | `raw.ref` | The tool name (`hook:PostToolUse:<tool>`) |
| Claude Code transcript | `raw.ref` | The transcript file path and byte offset the event came from |
| Claude Code transcript | `user_prompt` events | When you sent each prompt, and its id. Its text is in `promptText` (below) when text capture is on. |
| Claude Code transcript | `compaction` events | When the context was compacted, whether automatically or by you, and the context size before and after |
| Claude Code hooks, Copilot OTel | `toolName`, `toolCategory` | The tool's name and a high-level category (e.g. "Tests and builds"). The category is derived from the command already stored in `target`, so it adds no new information. |
| Claude Code transcript and hooks | `turnId`, `agentId` | Which prompt each model call and tool call belongs to, and which subagent (by Claude Code's id) did the work |
| Copilot OTel | `target` | The tool or hook name only, not its arguments |
| Copilot CLI session logs (Agent mode) | `target` | Like Claude Code: the tool's file path, or the **full shell command string** for shell tools |
| Copilot CLI session logs (Agent mode) | `user_prompt`, model calls | When you sent each prompt, and each model call's model, token counts, and the model's prompt budget |
| Edit tracker | `target`, `raw.ref` | The saved file's path and URI, not its contents |
| Claude Code transcript, with text capture on (the default) | `promptText` | **Your prompt's text**, up to 2,000 characters, secrets redacted. Only what you typed: context Claude Code or the IDE adds (open files, selections, task notifications, command output) is left out; a slash command is kept as `/name args`. |
| Copilot CLI session logs, with text capture on (the default) | `promptText` | **Your prompt's text** (`user.message` content), up to 2,000 characters, secrets redacted |
| Claude Code transcript, with text capture on (the default) | `sessionName` | Claude Code's generated session title (`ai-title` lines), secrets redacted |
| Copilot CLI session logs, with text capture on (the default) | `sessionName` | The session's name from the `workspace.yaml` beside its log: a generated title, or one you set |
| Claude Code transcript, with text capture on (the default) | `textExcerpt` | The reply's `text` blocks, truncated to 500 characters, secrets redacted. Never thinking blocks or tool inputs. |
| Copilot CLI session logs, with text capture on (the default) | `textExcerpt` | The reply's text (`assistant.message` content), truncated to 500 characters, secrets redacted. Never reasoning text, tool arguments, or tool results. |
| Copilot OTel, with text capture on **and** Copilot's `github.copilot.chat.otel.captureContent` | `textExcerpt` | The assistant `text` parts of `gen_ai.output.messages`, truncated to 500 characters, secrets redacted. Never reasoning parts, prompts, tool arguments, or tool results. |

Never captured: file contents, edit diffs, tool output, search patterns, and context injected into prompts (open files, selections).

Snagboat reads subagent transcripts (`<session>/subagents/*.jsonl` under Claude Code's project folder) the same way as main session transcripts, and the Copilot CLI's session logs (`~/.copilot/session-state/*/events.jsonl`) for sessions started inside the open workspace. It never modifies either.

### Captured text

**`snagboat.captureContent` is on by default.** It stores three kinds of text: your prompts (`promptText`), reply excerpts (`textExcerpt`), and session names (`sessionName`). Prompts and replies give the Sessions tab and the verbal-hedge heuristic something to show; names make sessions recognizable. Earlier versions stored no prompt text and had this setting off by default; installs that never changed it start capturing text from this version on.

Text is protected three ways instead of by an opt-in:

- **Redaction.** Before anything is stored, common secret formats are replaced with a `[redacted …]` marker: private key blocks, AWS keys, GitHub, Anthropic, OpenAI, Stripe, Slack, and Google tokens, JWTs, bearer tokens, passwords in URLs, and `password=`/`token=`/`api_key=`-style values that look like secrets. It's a backstop for the common cases, not a guarantee: a secret in an unrecognized format is stored as is.
- **Shorter retention.** Prompts and reply excerpts are kept for `snagboat.retention.textDays` (default 30 days, the same as Claude Code keeps its own transcripts), then removed from their events, which stay for `rawDays`. Session names stay with their session's events.
- **Removal.** `Snagboat: Remove Captured Text` removes every stored prompt and reply excerpt now, and can turn capture off at the same time.

The text is stored **in the same event logs as everything else**, not in a separate store. Turning the setting off stops new capture of all three; text already stored stays until text retention removes it or you run Remove Captured Text. Token tracking and the behavioral heuristics never require it.

The same text is already on disk in the agents' own logs: Claude Code keeps full prompts in its transcripts, and Copilot in its session logs. Snagboat's copy adds a second location (VS Code's workspace storage, and whatever backs it up) for up to `textDays`.

Note that Copilot's own `github.copilot.chat.otel.captureContent` makes Copilot send full prompts, replies, and tool results to Snagboat's local receiver. Snagboat keeps only the truncated reply text and discards the rest without logging it.

## The advisor

**Explain** sends one **session digest** per request to the provider set in `snagboat.advisor.explainProvider`. **Ask the advisor**, in the Suggestions tab, sends discovery's candidates to the provider set in `snagboat.advisor.proposeProvider`. That's each candidate's pattern, threshold, and your percentiles, plus digests of up to two of the turns that reached it, under the same rules as below, and the names of your shell command families (`curl`, `npm install`) with their counts, never their arguments. **Ask the Advisor**, after **Snagboat: Write Review**, sends the review's own data to the provider set in `snagboat.advisor.reviewProvider`: counts by model, day, and tool category; session ids; heuristic and rule ids and titles with their episode and response counts; and the status bar snapshots, with findings shown only by heuristic id. A scheduled weekly review never sends anything. By default that's a local model (Ollama on `localhost`), and nothing leaves the machine. A provider is treated as local only if its address is a loopback address (`localhost`, `127.0.0.1`, `::1`), whatever its name. Any other provider is hosted: it must use https, needs your API key, and is audited.

Digests are built from the stored events for one request and contain:

- **Always:** session and turn ids, times, counts of turns, model calls, and tool calls; token counts and context peaks; tool categories, failures, compactions; findings, with summaries redacted the same way as targets.
- **Shell commands:** only their category and command name (`tests-builds: npm`). Never arguments, environment variables, or the rest of the line.
- **File paths:** relative to the workspace, or, when outside it or when `send.paths` is `hashed`, a short hash that keeps the extension (`file-3dbaa72f.md`).
- **Prompt text:** for local providers by default; for hosted ones only with `send.prompts`. Capped at 1,000 characters per turn, after the redaction applied at capture.
- **Session names:** local by default; hosted only with `send.sessionNames`.
- **Reply excerpts:** never, unless a provider has `send.replies`.

The request carries a fixed instruction and the data, and offers the model no tools. What a model sends back is only ever shown as model output; a proposed rule or category is checked like one you'd write and saved only if you accept it. Before a provider's first request, and whenever its address or sending rules change, Snagboat shows the exact payload and asks. **Snagboat: Preview Advisor Digest...** shows a digest any time.

## Where data is stored

All under the extension's per-workspace storage folder unless noted:

| Store | Contents | Retention |
| --- | --- | --- |
| `events/<date>.jsonl` | Every normalized event, including `target` and, when capture is on, `promptText`, `textExcerpt`, and `sessionName` | `snagboat.retention.rawDays` (default 90 days, counting today); `promptText` and `textExcerpt` only `snagboat.retention.textDays` (default 30) |
| `aggregates/<date>.json` | Per-day, per-agent token and event counts. No targets or text. | `snagboat.retention.aggregateDays` (default `-1`, kept indefinitely; `0` keeps none) |
| `checkpoints/<adapter>.json` | Read offsets into Claude Code transcript files (including subagent transcripts), the last few API message ids seen in each, and each file's most recent prompt id, keyed by transcript path (Copilot's: offsets and last turn per session log) | Until the transcript or session log is deleted (its entry is dropped at the next activation), or cleared manually; not covered by `Clear Event Log` |
| VS Code workspace state | The list of muted heuristics, and when Snagboat started recording your responses to findings | Until unmuted, or Snagboat is uninstalled |
| `finding-responses.jsonl` | One line per finding episode: heuristic id, worst severity, when it started and ended, and when you acknowledged or muted it. No summaries or targets. Read by **Snagboat: Write Review**. | `snagboat.retention.rawDays`, pruned at activation; removed by `Clear Event Log` |
| `~/.snagboat/reviews/<week>-<workspace>.md` (or `snagboat.advisor.reviewDirectory`) | Reviews you write with **Snagboat: Write Review**: token and call counts by model, day, and tool category; session ids; heuristic and rule ids, titles, and episode counts; your response counts; status bar snapshots with findings shown only by heuristic id. No prompts, replies, paths, commands, or session names. | Until you delete them; Snagboat never reads them back or sends them anywhere |
| VS Code global state | The ids of suggestions you dismissed in the Suggestions tab, shared by all workspaces. No content. | Until you show dismissed suggestions again |
| VS Code webview state | The detail view's filters, including the timeline search text | Managed by VS Code |
| VS Code extension host log | Diagnostic messages: file paths, port errors, and, for hook or OTLP requests Snagboat couldn't parse or map, only their size and hook/tool names, never payload contents | Managed by VS Code |
| VS Code global storage: `copilot-structure/<date>.jsonl` | Only with `snagboat.copilot.captureStructure` on (off by default): the shape of Copilot's telemetry, meaning span names, ids, parent links, timings, attribute names, and numeric or true/false values such as token counts. Every text value is replaced by its length, so no prompts, replies, tool arguments, paths, or model names. | Until deleted by hand |
| VS Code global storage: `context-limits.json` | Per model name: the largest context seen, and the context at which an automatic compaction happened, with when. Shared by all workspaces. No content. | Until Snagboat is uninstalled |
| VS Code global storage: `advisor-audit.jsonl` | One line per request to a hosted advisor provider: when, provider, address, model, capability, outcome, request size, and its SHA-256. The full request only with `snagboat.advisor.auditPayloads` on (off by default). | `snagboat.retention.rawDays`, pruned at activation |
| VS Code secret storage | Hosted advisor providers' API keys | Until removed with **Snagboat: Set Advisor API Key...** (leave it empty) |
| VS Code global state | Which advisor providers you've approved, keyed by a hash of their address and sending rules. No content. | Until Snagboat is uninstalled |
| VS Code global storage: `rules.json` | Saved heuristic rules and shell sub-categories: their definitions, which can include command prefixes you or discovery chose, plus who proposed each, when, the name of the workspace it was discovered in, and its replay score. Shared by all workspaces. No events or captured text. | Until removed, or Snagboat is uninstalled |
| `~/.snagboat/routes/<folder>` | One file per open workspace folder: the local port, a random auth token, and the VS Code process id, so hooks reach the right window. Owner-only (`0600`). | Removed when the window closes; leftovers from crashed windows are removed on the next activation |
| `~/.snagboat/bin/snagboat-hook` | The hook forwarder script that Claude Code runs | Rewritten on every activation |
| `<project>/.claude/settings.json` | Outside Snagboat's storage: the `PostToolUse`/`Stop` hook entries Snagboat adds so Claude Code runs `snagboat-hook` | Until removed with `Snagboat: Remove Claude Code Hooks from Project...` or by hand |

Snagboat also reads data it doesn't own: Claude Code transcripts (`~/.claude/projects/…`), Copilot CLI session logs and their `workspace.yaml` (`~/.copilot/session-state/…`), and Copilot's OTel export. It never modifies or deletes them.

## Retention

On activation, hourly, and whenever the retention settings change:

- raw daily files older than `rawDays` are rolled up into `aggregates/<date>.json` and deleted;
- aggregates older than `aggregateDays` are removed;
- raw days older than `textDays` (capped at `rawDays`) have their prompt text and reply excerpts removed in place: the events stay, without the text.

Events are filed under the day they happened, so history caught up from an old transcript is retained by its own date: anything older than `rawDays` goes straight into that day's aggregate, anything older than `aggregateDays` isn't stored, and text older than `textDays` is never written.

**Still one clock:** other fields, including command-string `target`s and file paths, live as long as their event (`rawDays`). Whether those need a shorter retention of their own is still open.

## User controls

- `Snagboat: Clear Event Log` (`snagboat.clearLog`) deletes all raw logs and daily aggregates after a confirmation prompt. Adapter checkpoints are kept so already-seen transcript history is not re-imported.
- `Snagboat: Remove Captured Text` (`snagboat.removeCapturedText`) removes every stored prompt and reply excerpt after a confirmation prompt, keeping the events, and can turn capture off too.
- `Snagboat: Remove Claude Code Hooks from Project...` (`snagboat.removeClaudeHooks`) removes Snagboat's hook entries from a folder's `.claude/settings.json` and turns off `snagboat.claudeCode.configureHooks` for it, so they aren't added back.
- `snagboat.captureContent` (on by default) turns all text capture on or off; `snagboat.retention.textDays` sets how long prompts and replies are kept. The detail view shows whether capture is on and for how long text is kept.

## Design guardrails

- Logs stay local. Any future sharing or sync feature must be a separate, clearly labeled opt-in.
- The advisor sees only digests built for one request, under its provider's sending rules, after you've seen the payload. Local is the default; hosted providers are opt-in, use https, and are audited. A model gets no tools and no standing access to the log.
- Adapters prefer pointers back to source data (`raw.ref`) over copying payloads into events.
- Heuristics and UI must work without captured text (`promptText`, `textExcerpt`, `sessionName`).
- Token tracking must not require content capture.
