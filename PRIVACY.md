# Privacy

Snagboat keeps everything it observes on the developer's machine, and there is no telemetry of the extension itself. The one exception is the optional advisor: if you add a hosted provider and approve its payload, a redacted digest of the session you ask about is sent to it (see [The advisor](#the-advisor)).

## What is captured

**Which projects.** The VS Code extension records the projects you open in VS Code. The core service (`snagboat serve`, a preview, which VS Code starts when `snagboat.storage.perUserStore` is on) goes further: while it runs, it reads Claude Code's transcripts (`~/.claude/projects`) and Copilot CLI's session logs (`~/.copilot/session-state`) for **every project on this machine**, including ones you've never opened in VS Code, and records them in `~/.snagboat/data`, with your prompts' text unless capture is off for that project. To limit it: `"collect": false` for a project (in `~/.snagboat/config.json` or its `.snagboat.json`), or `"collect.unopened": false` in `config.json`'s defaults to record only projects VS Code knows ([settings](docs/settings.md#outside-vs-code-snagboatconfigjson-and-snagboatjson)), or `snagboat serve --no-collect`.

**Git history.** The core service also reads the git history of the projects it records, read-only (`git log`, `git show`, `git blame`, with git's optional locks off so it never gets in your way), to learn what became of commits made during a session: whether each was kept or reverted after 7 days, how many of the lines it added are still there after 7 and 30 days, and whether it came after the session's tests last passed. It reads only repositories of projects with recorded sessions, about commits that touch files a session's agent edited, and stores only commit ids, counts and times, never code or commit messages. `snagboat.outcomes.git` (or `"outcomes.git": false` in `config.json` or a project's `.snagboat.json`) turns it off.

Each observed action becomes one normalized event (see [docs/schema.md](docs/schema.md)). Most fields are structural (kind, status, timestamps, session id, model, token counts), but some carry details of what the agent did:

| Source | Field | What it holds |
| --- | --- | --- |
| Claude Code hooks and transcripts | `target` | The tool's `file_path`, or the **full shell command string** for Bash calls (from the hooks, or, in projects without them, from the transcript's tool calls). Commands can contain secrets such as tokens in headers, credentials in connection strings, or exported environment variables. |
| Claude Code hooks | `raw.ref` | The hook and tool name (`hook:PostToolUse:<tool>`, `hook:PostToolUseFailure:<tool>`, `hook:PermissionRequest:<tool>`, `hook:PermissionDenied:<tool>`) |
| Claude Code permission hooks | `approval` outcome events | That Claude Code asked you to approve a tool call (`PermissionRequest`), or that auto mode denied one (`PermissionDenied`): the tool's name, when, and the session and turn. Not the command or file it was for, not your answer, and not the denial's reason. |
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

Advisors are models you configure (`snagboat.advisors`, or the short form `snagboat.advisor.providers`), each offering some of five abilities, and each ability names the advisor it uses (`snagboat.advisor.defaults`) unless you pick another. What is sent depends on the ability:

- **Summarize a session** (**Explain**, in the Sessions tab, on a notification, or **Snagboat: Explain Session...**) sends one **session digest** per request.
- **Propose heuristics** (**Ask the advisor**, in the Suggestions tab) sends discovery's candidates: each candidate's pattern, threshold, and your percentiles, plus digests of up to two of the turns that reached it, under the same rules as below, and the names of your shell command families (`curl`, `npm install`) with their counts, never their arguments. It also sends how each heuristic and rule did over the window (ids, episode counts, how many you acknowledged or muted) and the built-in thresholds against your history.
- **Summarize the week** and **propose nudges** (**Ask the Advisor**, after **Snagboat: Write Review**) send the review's own data, split between them: counts by model, day, and tool category, session ids, and which heuristics fired for the summary; heuristic and rule ids with their episode and response counts, and the status bar snapshots with findings shown only by heuristic id, for the nudge review. A scheduled weekly review never sends anything.
- **Propose tactics** (**Tactics** on a session, **Snagboat: Propose Tactics for Session...**) sends that session's digest; in the review, the digests of the two costliest sessions (20 turns each) under the ability's rules, plus `snagboat.advisor.modelTiers` when set.
- **Session headlines** (`snagboat.advisor.headlines`, off by default) send each ended session's digest to the `summarize-session` advisor once, quietly, after it has been idle past the `stalled` window, but only to an advisor whose current payload you've already approved; it never asks while you work.
- **Propose nudges** is also the one-line suggestion under a finding: with `snagboat.nudges.advisor` on, a finding's notification sends that turn's digest, but only to an advisor whose current payload you've already approved; it never asks while you work.

By default every ability uses a local model (Ollama on `localhost`), and nothing leaves the machine. An advisor is treated as local only if its address is a loopback address (`localhost`, `127.0.0.1`, `::1`), whatever its name. Any other advisor is hosted: it must use https, needs your API key, and is audited. Sending rules (`send`) are set per advisor, and can be set per ability, so a hosted advisor can get prompts when it explains a session and none when it reviews the week. Widening what an ability may receive changes what you approve, so you see the payload again. An advisor's own prompts (its goal and voice, and per-ability instructions) change what it's asked, never what data is sent: Snagboat appends its data-handling rules after them, and the approval document shows the whole system prompt.

Digests are built from the stored events for one request and contain:

- **Always:** session and turn ids, times, counts of turns, model calls, and tool calls; token counts and context peaks; tool categories, failures, compactions; findings, with summaries redacted the same way as targets.
- **Shell commands:** only their category and command name (`tests-builds: npm`). Never arguments, environment variables, or the rest of the line.
- **File paths:** relative to the workspace, or, when outside it or when `send.paths` is `hashed`, a short hash that keeps the extension (`file-3dbaa72f.md`).
- **Prompt text:** for local advisors by default; for hosted ones only with `send.prompts`, per ability. Capped at 1,000 characters per turn, after the redaction applied at capture. The week's summary sends the first prompt of each of the five costliest sessions under the same rule; the Markdown review file never contains it.
- **Each turn's model** (the main agent's model with the most calls), with the other counts.
- **Session names:** local by default; hosted only with `send.sessionNames`.
- **Reply excerpts:** never, unless a provider has `send.replies`.

The request carries a fixed instruction and the data, and offers the model no tools. What a model sends back is only ever shown as model output; a proposed rule or category is checked like one you'd write and saved only if you accept it. Before a provider's first request, and whenever its address or sending rules change, Snagboat shows the exact payload and asks. **Snagboat: Preview Advisor Digest...** shows a digest any time.

## Where data is stored

All under the extension's per-workspace storage folder unless noted. With `snagboat.storage.perUserStore` on (a preview, off by default), the same files live in one per-user store instead: a workspace's `events/`, `aggregates/`, `checkpoints/` and `finding-responses.jsonl` in `~/.snagboat/data/workspaces/<workspace>/` (with a `workspace.json` naming the folder), `rules.json` in `~/.snagboat/`, and `context-limits.json`, `advisor-audit.jsonl` and `copilot-structure/` in `~/.snagboat/data/`. Each event there also records its workspace's folder path. Turning the setting on, or running `snagboat migrate`, **copies** the existing data there and leaves the original where it was; `~/.snagboat/data/migrated/` records what was copied. Each copy is subject to the same retention, applied by the core service (or by the window, when it writes the folder itself because the core couldn't start). To remove the per-user store, turn the setting off and delete `~/.snagboat/data` (and `~/.snagboat/rules.json`).

| Store | Contents | Retention |
| --- | --- | --- |
| `events/<date>.jsonl` | Every normalized event, including `target` and, when capture is on, `promptText`, `textExcerpt`, and `sessionName`; and outcome events Snagboat works out (a test run going green; how you met a finding: heuristic id, your response; a notification shown: heuristic id, and the advisor whose limit it fell under; with the core, what became of a session's commits: commit id, file and line counts; and the ids of the events involved; no content) | `snagboat.retention.rawDays` (default 90 days, counting today); `promptText` and `textExcerpt` only `snagboat.retention.textDays` (default 30) |
| `aggregates/<date>.json` | Per-day, per-agent token and event counts. No targets or text. | `snagboat.retention.aggregateDays` (default `-1`, kept indefinitely; `0` keeps none) |
| `checkpoints/<adapter>.json` | Read offsets into Claude Code transcript files (including subagent transcripts), the last few API message ids seen in each, and each file's most recent prompt id, keyed by transcript path (Copilot's: offsets and last turn per session log) | Until the transcript or session log is deleted (its entry is dropped at the next activation), or cleared manually; not covered by `Clear Event Log` |
| `snagboat-workspace.json` | In VS Code's storage folder only (not the per-user store): the path of this workspace's folder, or of its `.code-workspace` file, so the `snagboat` CLI knows whose store it is (VS Code's server doesn't record it). | Rewritten when a window opens the workspace; until Snagboat is uninstalled |
| VS Code workspace state | The list of muted heuristics, and when Snagboat started recording your responses to findings | Until unmuted, or Snagboat is uninstalled |
| `finding-responses.jsonl` | One line per finding episode: heuristic id, worst severity, when it started and ended, and when you marked it useful, acknowledged or muted it. No summaries or targets. Read by **Snagboat: Write Review**. | `snagboat.retention.rawDays`, pruned at activation; removed by `Clear Event Log` |
| `~/.snagboat/reviews/<week>-<workspace>.md` (or `snagboat.advisor.reviewDirectory`) | Reviews you write with **Snagboat: Write Review**: token and call counts by model, day, and tool category; session ids; heuristic and rule ids, titles, and episode counts; your response counts; status bar snapshots with findings shown only by heuristic id. No prompts, replies, paths, commands, or session names. | Until you delete them; Snagboat never reads them back or sends them anywhere |
| VS Code global state | The ids of suggestions you dismissed in the Suggestions tab, shared by all workspaces. No content. | Until you show dismissed suggestions again |
| VS Code webview state | The detail view's filters, including the timeline search text | Managed by VS Code |
| VS Code extension host log | Diagnostic messages: file paths, port errors, and, for hook or OTLP requests Snagboat couldn't parse or map, only their size and hook/tool names, never payload contents | Managed by VS Code |
| VS Code global storage: `copilot-structure/<date>.jsonl` | Only with `snagboat.copilot.captureStructure` on (off by default): the shape of Copilot's telemetry, meaning span names, ids, parent links, timings, attribute names, and numeric or true/false values such as token counts. Every text value is replaced by its length, so no prompts, replies, tool arguments, paths, or model names. | Until deleted by hand |
| VS Code global storage: `context-limits.json` | Per model name: the largest context seen, and the context at which an automatic compaction happened, with when. Shared by all workspaces; with the per-user store on, the core service updates it too. No content. | Until Snagboat is uninstalled |
| VS Code global storage: `advisor-audit.jsonl` | One line per request to a hosted advisor provider: when, provider, address, model, capability, outcome, request size, and its SHA-256. The full request only with `snagboat.advisor.auditPayloads` on (off by default). | `snagboat.retention.rawDays`, pruned at activation |
| VS Code secret storage | Hosted advisor providers' API keys | Until removed with **Snagboat: Set Advisor API Key...** (leave it empty) |
| VS Code global state | Which advisor providers you've approved, keyed by a hash of their address and sending rules. No content. | Until Snagboat is uninstalled |
| VS Code global storage: `rules.json` | Saved heuristic rules and shell sub-categories: their definitions, which can include command prefixes you or discovery chose, plus who proposed each, when, the name of the workspace it was discovered in, and its replay score. Shared by all workspaces. No events or captured text. | Until removed, or Snagboat is uninstalled |
| `~/.snagboat/routes/<folder>` | One file per open workspace folder: the local port, a random auth token, and the VS Code process id, so hooks reach the right window. Owner-only (`0600`). | Removed when the window closes; leftovers from crashed windows are removed on the next activation |
| `~/.snagboat/advisors/<id>/` | Your advisors' `persona.md` (front matter: goal, measures, notification limits; below it, the voice) and per-ability instructions, as you write them, or as **Snagboat: Write Default Advisor Prompts** writes them. Read by the extension, the CLI and the core; only the voice is ever sent to a model. | Until you delete them |
| `~/.snagboat/config.json` | With `snagboat.storage.perUserStore` on: Snagboat's settings as you set them in VS Code (User settings, and each workspace's), keyed by project folder path, for the core service and the CLI. Includes `rules` and `toolCategories` (which can name command prefixes). Not the advisor's settings or keys. Owner-only. | Until you delete it; VS Code rewrites the entries it copied when settings change |
| `<project>/.snagboat.json` | Not written by Snagboat: a file a project may commit with team settings. It can only make privacy settings more private ([settings](docs/settings.md#outside-vs-code-snagboatconfigjson-and-snagboatjson)). | |
| `~/.snagboat/core.json`, `~/.snagboat/core.lock` | Only while the core service (`snagboat serve`, a preview) runs: its local port, process id, version, and a random token that reads every workspace's data in the per-user store. Owner-only (`0600`). | Removed when the core stops; a leftover from a crash is replaced by the next core |
| `~/.snagboat/core.route` | Only while the core service runs: its port, process id, and a token that can only send it Claude Code hooks, for the hook script. Owner-only. | Removed when the core stops |
| `~/.snagboat/data/spool/hooks/<time>-<pid>.hook` | Only once the core service has run (it creates this folder): Claude Code hook payloads that reached neither a VS Code window nor a running core. Each is the **raw payload Claude Code sends**, which includes the tool's input and output (commands, file paths and contents), with the project folder. Owner-only. | Read and deleted when the core next starts (or within 30 seconds if it's running); recorded for the project's workspace unless its settings say not to (`collect`), else discarded. Delete the folder to stop spooling |
| `~/.snagboat/data/core/checkpoints/` | Only with the core service collecting: how far it has read each Claude Code project's transcripts, the last few message ids in each, and each file's latest prompt id, keyed by transcript path; and how far it has read each Copilot CLI session log, with its latest turn id. No content. | Until deleted by hand; an entry for a deleted transcript is dropped when that project is read again |
| `~/.snagboat/.hook-in.<pid>` | A copy of one hook payload while the hook script delivers it, so it can try the window and then the core. Owner-only. | Removed when the script finishes; one left by a killed script is removed by the core |
| `~/.snagboat/data/spool/events/` | Only with the core service: events for a workspace whose VS Code window is writing the per-user store itself (waiting until that window closes) or holding it while a command rewrites it, and events a window sent while the core wasn't running. The same fields as the event log. Owner-only. | Moved into the workspace's event log, and deleted, once the window has closed or let go (within 30 seconds, or when the core next starts) |
| `~/.snagboat/data/workspaces/<workspace>/writer.json` | With `snagboat.storage.perUserStore` on: the process id of a VS Code window writing that workspace's folder itself (the core couldn't start), or holding it while backfill, relabelling, removing captured text or clearing the log rewrites it, so the core service leaves it alone | Removed when the window closes, or when the command finishes |
| `~/.snagboat/bin/snagboat-hook` | The hook forwarder script that Claude Code runs | Rewritten on every activation |
| `<project>/.claude/settings.json` | Outside Snagboat's storage: the `PostToolUse`/`PostToolUseFailure`/`Stop`/`PermissionRequest`/`PermissionDenied` hook entries Snagboat adds so Claude Code runs `snagboat-hook` (the two permission entries with `"async": true`: Claude Code runs them in the background and ignores their output, so they can't approve or deny anything) | Until removed with `Snagboat: Remove Claude Code Hooks from Project...` or by hand |

Snagboat also reads data it doesn't own: Claude Code transcripts (`~/.claude/projects/…`), Copilot CLI session logs and their `workspace.yaml` (`~/.copilot/session-state/…`), and Copilot's OTel export. It never modifies or deletes them.

## Retention

On activation, hourly, and whenever the retention settings change:

- raw daily files older than `rawDays` are rolled up into `aggregates/<date>.json` and deleted;
- aggregates older than `aggregateDays` are removed;
- raw days older than `textDays` (capped at `rawDays`) have their prompt text and reply excerpts removed in place: the events stay, without the text.

Events are filed under the day they happened, so history caught up from an old transcript is retained by its own date: anything older than `rawDays` goes straight into that day's aggregate, anything older than `aggregateDays` isn't stored, and text older than `textDays` is never written.

The core service applies the same retention, every 6 hours and when it starts, to the workspaces it records that no VS Code window has open, using each workspace's own settings (`~/.snagboat/config.json`, `.snagboat.json`). A workspace whose window writes it itself (when the core couldn't start) is the window's to prune.

**Still one clock:** other fields, including command-string `target`s and file paths, live as long as their event (`rawDays`). Whether those need a shorter retention of their own is still open.

## User controls

- `Snagboat: Clear Event Log` (`snagboat.clearLog`) deletes all raw logs and daily aggregates after a confirmation prompt. Adapter checkpoints are kept so already-seen transcript history is not re-imported.
- `Snagboat: Remove Captured Text` (`snagboat.removeCapturedText`) removes every stored prompt and reply excerpt after a confirmation prompt, keeping the events, and can turn capture off too.
- `Snagboat: Remove Claude Code Hooks from Project...` (`snagboat.removeClaudeHooks`) removes Snagboat's hook entries from a folder's `.claude/settings.json` and turns off `snagboat.claudeCode.configureHooks` for it, so they aren't added back.
- `snagboat.captureContent` (on by default) turns all text capture on or off; `snagboat.retention.textDays` sets how long prompts and replies are kept. The detail view shows whether capture is on and for how long text is kept.

## The advisor UI

With the per-user store on, the core serves the advisor UI at `http://127.0.0.1:<port>/ui/`, on this machine only. It answers only requests addressed to `127.0.0.1` or `localhost` (so a web page that renames itself to look local can't reach it), and the page is sent with a policy that lets it load only its own files and talk only to the core. `snagboat open` or **Snagboat: Open Advisor UI** gives the browser a one-time code in the link's fragment, which browsers never send to a server; the page swaps it once for a read-only key, kept in that tab's session storage and ending when the core stops. That key can read every workspace's sessions, findings and advisors' measures, and can't write events, change settings, mint keys or stop the core. The page loads no fonts, scripts or images from anywhere else.

## The web demo

The detail view's Explore tab also runs as a page on GitHub Pages (<https://dchristianson.github.io/snagboat/>), over example sessions by default. It can load the daily files Snagboat writes (`events/<date>.jsonl`; **Snagboat: Reveal Event Log Folder** opens the folder) when you choose them: they are read in your browser and sent nowhere. The page's content security policy forbids network requests (`connect-src 'none'`), and it has no analytics, no service worker, and no third-party script. It stores nothing beyond the explorer's small view state (picked session ids, the current visualizer, its filters) in the browser's local storage; loaded events live in the page's memory until the tab closes. GitHub sees the request for the page, as for any site, but none of the data.

## Design guardrails

- Logs stay local. Any future sharing or sync feature must be a separate, clearly labeled opt-in.
- The advisor sees only digests built for one request, under its provider's sending rules, after you've seen the payload. Local is the default; hosted providers are opt-in, use https, and are audited. A model gets no tools and no standing access to the log.
- Adapters prefer pointers back to source data (`raw.ref`) over copying payloads into events.
- Heuristics and UI must work without captured text (`promptText`, `textExcerpt`, `sessionName`).
- Token tracking must not require content capture.
