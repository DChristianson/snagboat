# Common schema and transformation matrix

The types below live in [packages/schema/src/types.ts](../packages/schema/src/types.ts), in the `@snagboat/schema` workspace package ([design/architecture-rfc.md](design/architecture-rfc.md)). [Factory Clock](https://github.com/DChristianson/factory-clock) keeps its own copy of it. The same shape is published as JSON Schema in [normalizedEvent.v4.schema.json](../packages/schema/src/normalizedEvent.v4.schema.json); a compile-time check keeps its field list equal to the type's, and `normalizedEventSchema.unit.test.ts` validates real events against it.

**Versions.** Version 4 adds `toolInput`, `refs` and `textTruncated` (below); version 3 added the `outcome` kind and the `outcome` field, `todos` and `taskOp`; version 2 added `workspace`. Each version only adds, so every version 1, 2 and 3 event is a valid version 4 event, a reader takes all four, a version 3 reader reads version 4 events by ignoring the fields it doesn't know, and older logs need no conversion. A reader that switches on `kind` should ignore kinds it doesn't know. Versions 1 to 3 stay published as [normalizedEvent.v1.schema.json](../packages/schema/src/normalizedEvent.v1.schema.json) (`normalizedEventSchemaV1`), [normalizedEvent.v2.schema.json](../packages/schema/src/normalizedEvent.v2.schema.json) (`normalizedEventSchemaV2`) and [normalizedEvent.v3.schema.json](../packages/schema/src/normalizedEvent.v3.schema.json) (`normalizedEventSchemaV3`). Versions 3 and 4 are unreleased ([design/export.md](design/export.md)): they may still change before they ship. The package imports nothing outside itself and no Node builtins (`schemaBoundary.unit.test.ts`).

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
    | 'turn_start' | 'turn_stop' | 'user_prompt' | 'compaction' | 'session_name'
    | 'outcome';           // v3
  target?: string;
  status: 'success' | 'failure' | 'unknown';
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  textExcerpt?: string;  // agent reply, up to capture.replyChars (500), redacted
  promptText?: string;   // user_prompt: your prompt, up to capture.promptChars (2,000), redacted
  sessionName?: string;  // session_name: the session's name
  turnId?: string;   // the prompt (turn) this event belongs to
  agentId?: string;  // set for subagent work
  toolName?: string;     // tool calls: the tool's name as reported
  toolCategory?: 'file-read' | 'file-edit' | 'search' | 'script' | 'tests-builds'
    | 'version-control' | 'shell' | 'web' | 'mcp' | 'subagent' | 'other';
  todos?: {             // v3, tool calls to the agent's todo tool (TodoWrite)
    pending: number; inProgress: number; completed: number;
    items?: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>;  // capture on only
  };
  taskOp?: {            // v3, tool calls to the agent's task tools (TaskCreate, TaskUpdate, TaskList)
    op: 'create' | 'update' | 'list';
    id?: string;                                   // create, update
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted';  // update
    subject?: string;                              // create, update; capture on only
    tasks?: Array<{ id: string; status: 'pending' | 'in_progress' | 'completed'; subject?: string }>;  // list; subject capture on only
  };
  compaction?: { trigger: 'auto' | 'manual' | 'unknown'; preTokens?: number; postTokens?: number };
  channel?: 'inline';    // model calls from editor features, not agent turns
  contextLimit?: number; // the model's prompt budget for this call, when reported
  endsTurn?: true;       // this event ends its turn (see below)
  workspace?: string;    // v2: the workspace it was recorded in (see below)
  toolInput?: {          // v4, tool calls: the parts of the input worth drawing (not written yet)
    command?: string; path?: string; pattern?: string; url?: string; description?: string;
  };
  refs?: {               // v4, tool calls: what the call observably acted on (not written yet)
    commit?: string;       // a full or short SHA, as the command showed it
    branch?: string;
    planItems?: string[];  // bead ids
  };
  textTruncated?: true;  // v4: promptText or textExcerpt was cut at the store's cap (not written yet)
  outcome?: {            // v3, outcome events: what was measured (see below)
    type: 'tests_green' | 'finding_response'
      | 'commit_kept' | 'commit_reverted' | 'code_survival' | 'milestone' | 'approval' | 'notified';
    refs?: string[];       // the events it's about
    failures?: number;     // tests_green: failed runs before it passed
    afterMs?: number;      // tests_green: first failure to green
    heuristicId?: string;  // finding_response
    response?: 'useful' | 'muted' | 'acknowledged' | 'passed';  // finding_response
    commit?: string;       // git outcomes: the commit
    files?: number;        // git outcomes: the session's files it touched
    linesWritten?: number; // code_survival: lines it added to them
    linesSurviving?: number; // code_survival: still there
    days?: number;         // code_survival: 7 or 30
    advisor?: string;      // notified: whose notify limit it fell under
    decision?: 'asked' | 'denied';  // approval
  };
  confidence?: number;
  raw: {
    adapter: string;
    ref: string;
    event?: unknown;
  };
}
```

`confidence` is intentionally optional. Current Claude Code and Copilot integrations do not expose a trustworthy probability signal, but reserving the field now avoids a future schema migration. Built-in agent IDs stay explicit while third-party adapters should use a namespaced `custom:*` identifier. `raw.event` is optional and exists only for inspection or debugging when keeping part of the source payload is worth the extra storage.

`workspace` (version 2) names the workspace an event was recorded in: its folder path, its `.code-workspace` file path, or `(no folder)` for a window with no folder open (a remote window's is its URI, such as `vscode-remote://…`). It's set on every event in the per-user store (`~/.snagboat/data`), which holds every workspace's events. It's absent in the stores earlier versions kept in each VS Code window's own storage, which hold only that window's; `snagboat migrate` sets it on the events it copies from them.

`outcome` events (version 3) measure how work went. Snagboat works most of them out from other events (`raw.adapter` is `snagboat-outcomes`); `approval` comes straight from Claude Code's permission hooks (`raw.adapter` is `claude-code`). Each is filed in the session it's about:

- `tests_green`: a tool call in the tests-builds category succeeded after one or more failed in the same session. `refs` names the first failure and the passing run; its id is derived from the passing run's, so reading the same events again adds nothing. Whoever writes the workspace's events works it out: the core, or a window writing its own folder.
- `notified`: Snagboat showed you a notification for `heuristicId` (a finding or an early warning), with `advisor` when it falls under an advisor's `notify` rules; filed in its session. Lookout's notifications per hour count these.
- `approval`: Claude Code asked you to approve a tool call (`PermissionRequest` hook, `decision: 'asked'`), or auto mode denied one (`PermissionDenied`, `decision: 'denied'`). Only `toolName` is kept, never the tool's input or the denial's reason; a denial's `refs` names its tool call (`tool:<tool_use_id>`) and its id is derived from it. Claude Code sends no hook when you deny a prompt yourself, so a prompt's answer isn't recorded: Bosun's approvals per session is prompts less auto mode's denials.
- `finding_response`: a finding's episode ended, and `response` says how you met it, strongest first: marked **Useful**, muted, acknowledged, or let it pass. `refs` are the finding's events; filed in the session of the latest one still in the window's recent events.

- Git outcomes, worked out by the core from the project's history (read-only; `outcomes.git`). A session's commit is one made between its first event and 30 minutes after its last that touches a file its agent edited:
  - `milestone`, at the commit's time: the session's last test or build run before it passed.
  - `commit_kept` or `commit_reverted`, 7 days after it: whether a commit saying "This reverts commit <id>" came within those 7 days.
  - `code_survival`, 7 and 30 days after it: of the lines it added to the session's files, `linesSurviving` are still there at HEAD (`git blame`).

  Each has a fixed id and time, so running again adds nothing. Every commit counts, on any branch: work merged by squash counts as its branch commits and again as the squash commit (decided: count both). Multi-root workspaces aren't read yet.

`toolInput`, `refs` and `textTruncated` (version 4) are for the [export](design/export.md) and for heuristics that use git and plan state. `target` stays as it was beside them.

- `toolInput` holds the parts of a tool call's input worth drawing, from the Claude Code hooks and transcripts and the Copilot CLI's session log (Copilot's OpenTelemetry carries no arguments): `path` (`file_path`, `notebook_path`, `path` or `filePath`) always, as `target` keeps it; with `snagboat.captureContent` on, `command` (shell tools only), `pattern` (`pattern`, or a search's `query`), `url`, and `description` (shell and subagent tools only). Each is redacted and capped at 2,000 characters. Never the tool's output, and none for `TodoWrite` and the task tools, whose `todos` and `taskOp` say what matters. Text retention and Remove Captured Text remove all but `path`.
- `refs` is set on a shell tool call that *observably* acted on a commit, a branch or plan items; relations Snagboat infers are links (below), never refs. It's read from the command line, parsed conservatively (chains split at `&&`, `||`, `;`, `|` and newlines; quotes resolved; heredoc bodies, `$(...)` and comments never read as commands), and, where the adapter has it (Claude Code's hooks and transcripts; not the Copilot CLI, whose output shape isn't verified), the tool's output, which is never stored:
  - `git commit`: `commit`, only from the summary line git prints (`[main 1a2b3c4] subject`). The command doesn't show the SHA, so without that line there's none.
  - `git checkout -b|-B|--orphan <branch>`, `git switch [-c|-C] <branch>`, `git worktree add -b|-B <branch>`: `branch`, or the one git printed (`Switched to branch 'x'`, `Preparing worktree (new branch 'x')`). A bare `git checkout x` counts only by that output, since it may be restoring a file.
  - `gh pr merge <branch>`: `branch` (a PR number or URL names none, nor does no argument), or the branch gh printed it deleted; `--match-head-commit <sha>`: `commit`.
  - `bd show|update|close|reopen|claim|comment|comments|dep|label|defer <id>...`: `planItems`, the arguments shaped like an id (`snagboat-93b.10.2`), skipping option values; `bd create`: the id it printed (`Created issue: x`, or `--json`'s first `"id"`).

  What the command shows counts only when the call didn't fail; what the output shows counts either way (a chain can commit, then fail to push). A chain's last branch wins. Refs are ids, recorded whether or not text capture is on.
- `textTruncated` says the stored `promptText` or `textExcerpt` was cut at its cap (`snagboat.capture.promptChars`, default 2,000, or `replyChars`, default 500). Secrets are redacted over the whole text before it's cut.

Outcome events don't count as agent activity: they're left out of totals, the daily chart, session lists and heuristics.

`model` is optional and populated per event where the source reliably reports it, since coverage varies by adapter: the Claude Code transcript carries `message.model` directly alongside `message.usage` on every assistant turn, so the `claude-code` adapter should populate it whenever it emits token-bearing `turn_stop` events. Copilot OTel spans/metrics are expected to carry the model via the OpenTelemetry GenAI semantic conventions (`gen_ai.request.model` / `gen_ai.response.model`), so the `copilot` adapter's OTel path should populate it once that is verified against a live capture. Copilot's log-scrape path should leave `model` unset rather than guessing: its local session log's model field is consistently empty regardless of which model actually served the request. Per-event `model` is intended to support future per-model cost-weighting in longer-horizon rollups, distinct from the flat token totals used today.

## Transformation matrix

Every adapter should document how each raw signal maps into the shared schema.

| Raw signal | Source | `kind` | `target` | `status` | `tokens` | `textExcerpt` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PostToolUse` and `PostToolUseFailure` hook payloads | Claude Code | `tool_call` | `tool_input.file_path` or `.command` | `success` from `PostToolUse` (`failure` if `tool_response.error`); `failure` from `PostToolUseFailure` (a failed call, or a Bash command exiting non-zero), `unknown` if `is_interrupt` | — | — | Hooks provide structure but not usage. `toolInput` from `tool_input`; `refs` from the command and `tool_response` (or `error`, for a failure). |
| `tool_use` block, then its `tool_result` | Claude Code JSONL | `tool_call` | `input.file_path` or `.command` | `failure` if the result `is_error`, else `success` | — | — | `toolInput` from `input`; `refs` from the command and the result (`toolUseResult`, or the block's content). Built when the result arrives (backfill builds the same from whole transcripts), with id `tool:<tool_use_id>` like the hooks', so a call both report counts once. How projects without Snagboat's hooks get tool calls; a call whose result comes after a restart is lost. |
| `TodoWrite` tool call (hook's `tool_input.todos`, or the transcript's `tool_use` input) | Claude Code | Decorates the `tool_call` with `todos` | — | — | — | Each item's `content` in `todos.items` when `snagboat.captureContent` is on, up to 50 items of 200 characters, redacted | Counts of `pending`, `in_progress` and `completed` items always; `activeForm` and unknown statuses are dropped. The latest list in a session is Navigator's plan when the workspace has no Beads. |
| `TaskCreate`, `TaskUpdate` and `TaskList` tool calls (hook's `tool_input` and `tool_response`, or the transcript's `tool_use` input and its result line's `toolUseResult`) | Claude Code | Decorates the `tool_call` with `taskOp` | — | — | — | Each task's `subject` when `snagboat.captureContent` is on, 200 characters, redacted (a list's first 50) | The change each call made to the plan: `create` with the new task's id (`tool_response.task.id`; only in the result), `update` with its id (`taskId`, or `id`/`task_id`) and new status or subject (`deleted` removes it), or `list`, every task (up to 200), replacing what came before. Never `description`, `activeForm`, `owner` or `metadata`. Failed calls, `TaskGet`, and calls missing what they need (a create without its id) record none. Unlike `TodoWrite` these change the plan a task at a time, so Navigator replays a session's changes in order; a session that used both takes whichever it used last. |
| `Stop` hook payload | Claude Code | `turn_stop` with `endsTurn` | — | `unknown` | — | — | Marks the end of a turn. |
| `PermissionRequest` and `PermissionDenied` hook payloads | Claude Code | `outcome` (`approval`, `decision` `asked` or `denied`) | — | `unknown` | — | — | Only `tool_name` (as `toolName`), and `tool_use_id` (in `refs`, PermissionDenied only); `tool_input` and `reason` are dropped. Registered with `"async": true`, so Claude Code doesn't wait for them and ignores their output: they never decide or delay a permission prompt. |
| `prompt_id`, `agent_id` on any hook payload | Claude Code | Decorates the hook's event | — | — | — | — | Become `turnId` and `agentId`. Payloads without `prompt_id` (older Claude Code) take the session's current turn from the transcript. |
| Transcript message with usage block | Claude Code JSONL | `turn_stop` | — | `unknown` | Direct map from `input_tokens`, `output_tokens`, and cache fields, **once per `message.id`** | See next row | Primary token-accounting source. Claude Code writes one line per content block (thinking, text, tool_use), each repeating the whole message's `usage`; consecutive lines sharing a `message.id` are merged into one event. |
| Transcript message text | Claude Code JSONL | Decorates the owning `turn_stop` event | — | `unknown` | — | `text` content blocks only, truncated to `snagboat.capture.replyChars` (500 by default; `textTruncated` when cut), when `snagboat.captureContent` is on | Heuristics mine this captured text later; adapters do not need to invent a separate hedge event. |
| Prompt line (`user` line with text, not a tool result, meta, compact summary, or subagent line) | Claude Code JSONL | `user_prompt` | — | `unknown` | — | Prompt text in `promptText` when `snagboat.captureContent` is on: your words only, injected context (`<ide_…>`, task notifications, command output) dropped, a slash command as `/name args`; up to `snagboat.capture.promptChars` (2,000 by default; `textTruncated` when cut), redacted | `turnId` is its `promptId`. |
| `ai-title` line | Claude Code JSONL | `session_name` | — | `unknown` | — | Title in `sessionName`, when capture is on | Claude Code repeats the title throughout a transcript; an event is emitted when it changes, with an id from the session and title, so repeats are dropped. No timestamp of its own: takes the transcript's latest. |
| Interruption line (`user` line whose text starts "[Request interrupted by user") | Claude Code JSONL | `turn_stop` with `endsTurn`, no tokens | — | `unknown` | — | — | Ends the interrupted turn; not a prompt. |
| `stop_reason: end_turn` on a main-agent message | Claude Code JSONL | Decorates the message's `turn_stop` with `endsTurn` | — | — | — | — | The model finished without requesting a tool. A subagent finishing doesn't end the turn. |
| Any transcript line's `parentUuid` | Claude Code JSONL | Decorates model calls | — | — | — | — | Each line inherits its parent's turn, so every model call gets the `turnId` of the prompt that started it. |
| `system` line, subtype `compact_boundary` | Claude Code JSONL | `compaction` | — | `unknown` | — | — | `compactMetadata.trigger`, `preTokens`, `postTokens`; `model` is the session's last model. |
| Subagent transcript (`<session>/subagents/*.jsonl`) | Claude Code JSONL | Same as the main transcript | — | — | Same | Same | Lines carry `agentId` (becomes `agentId`) and the spawning turn's `promptId`. |
| `gen_ai.output.messages` on `invoke_agent` | Copilot OTel | Decorates the span's `turn_stop` event | — | — | — | Assistant `text` parts only, truncated to `snagboat.capture.replyChars` (500 by default), when both `snagboat.captureContent` and Copilot's `captureContent` are on | JSON string per the OpenTelemetry GenAI output-messages schema: `[{role, parts: [{type, content}], finish_reason}]`. |
| `execute_tool` span | Copilot OTel | `tool_call` | Span attributes for tool name or args | Span status code | — | — | Higher-fidelity tool activity path. |
| `execute_hook` span | Copilot OTel | `tool_call` | `hook_type` attribute | `hook_result_kind` mapping | — | — | Annotation-oriented signal. |
| `chat <model>` span outside `invoke_agent` | Copilot OTel | `turn_stop` with `channel: 'inline'` | — | Span status code | `input_tokens` minus `cache_read.input_tokens`; `output_tokens`; cache read | — | Editor features (inline and next-edit suggestions, chat titles). `max_prompt_tokens` becomes `contextLimit`. Metrics are no longer mapped: the spans carry the same counts. |
| `user.message` | Copilot CLI session log | `user_prompt` | — | `unknown` | — | Prompt text in `promptText` when capture is on, up to `snagboat.capture.promptChars` (2,000 by default), redacted | `turnId` is its `interactionId`. |
| `name` in the session's `workspace.yaml` | Copilot CLI session folder | `session_name` | — | `unknown` | — | Name in `sessionName`, when capture is on | Read whenever the session's log grows; `user_named` says you set it. Time from `updated_at`. |
| `session.usage_record` | Copilot CLI session log | `turn_stop` | — | `unknown` | `inputTokens` minus cache read and write; `outputTokens`; `cacheReadTokens`; `cacheWriteTokens` as cache creation | — | One model call. `maxPromptTokens` becomes `contextLimit`; turn from the `parentId` chain. |
| `assistant.message` with empty `toolRequests` | Copilot CLI session log | `turn_stop` with `endsTurn`, no tokens | — | `unknown` | — | — | The reply that finishes the turn. Event id is the message's id plus `:end`. |
| `tool.execution_start` + `tool.execution_complete` | Copilot CLI session log | `tool_call` | `arguments.command` or a path argument | `success` / non-zero `shellExecution.exitCode` | — | — | `toolName` and `toolCategory` as for Claude Code. `toolInput` from `arguments`; `refs` from the command only. |
| `onDidSaveTextDocument` | Generic FS | `edit` | File path | `unknown` | — | — | Provides churn and backtracking input even without agent data. |
| Terminal exit code | Generic FS | `test_run` | Command string | `success` when exit code is 0, else `failure` | — | — | Shell-integration driven. |
| `git diff` polling | Generic FS | Supplementary `edit` context | File path | — | — | — | Separates real content changes from no-op saves. |

This matrix is the adapter conformance spec. New adapters should not be accepted without an equivalent mapping table for every raw signal they introduce.

## Retention-aligned fields

The schema is designed so sensitive content remains optional:

- structural fields (`kind`, `status`, `target`, `tokens`) support most heuristics and reporting
- `promptText`, `textExcerpt`, `todos.items`, task subjects in `taskOp`, and `toolInput`'s command, pattern, URL and description are captured by default (`snagboat.captureContent`), redacted, and kept for `snagboat.retention.textDays` (default 30), after which they're removed from their events; `sessionName` stays with its session (see [PRIVACY.md](../PRIVACY.md#retention))
- `session_name` and `outcome` events don't count as agent activity in totals or heuristics
- `target` is structural for file paths but can carry sensitive content for shell commands, so it is a candidate for a shorter retention too
- `raw.ref` points back to source material without copying entire payloads into the normalized record
- `raw.event` is optional debug data and should be omitted unless an adapter has a clear inspection need

## `raw.ref` contract

`raw.ref` should be treated as an adapter-defined opaque identifier with two constraints:

- it must stay stable for as long as the referenced raw log entry is retained
- when the source is file-backed, it should prefer a file path or URI plus a line or byte offset so humans and tools can resolve it directly

Examples include `transcripts/session.jsonl#L128`, `file:///.../copilot.log#offset=4096`, or another adapter-specific reference that can be mapped back to a single raw record.

## Tool categories

`toolCategory` is a high-level label for what a tool call ran, computed in the adapter by `packages/schema/src/toolCategory.ts` from the tool's name and, for shell tools, the command line: interpreter runs (a script file, or inline code such as `python3 - <<EOF`) are `script`; test runners, build tools, and package-manager `test`/`build`/`lint` scripts are `tests-builds`; `git`/`gh` are `version-control`; other commands are `shell`. Chains are classified by their first meaningful segment (`cd src && npm test` is `tests-builds`). It's pattern matching and will mislabel some calls; see [design/conversation-view.md](design/conversation-view.md#tool-classification). Copilot doesn't export tool arguments, so its terminal tool is always `shell`.

## Goal tracking records

The [goal tracking lifecycle](design/goal-tracking-lifecycle.md) adds four records, typed in [packages/schema/src/advisorRecords.ts](../packages/schema/src/advisorRecords.ts) and published as JSON Schema version 1. As with events, a compile-time check keeps each schema's field list equal to its type's, and `advisorRecordsSchema.unit.test.ts` validates real records against them. Nothing validates against the schemas at run time.

| Record | File | Schema | What it holds |
| --- | --- | --- | --- |
| `PeriodReport` | `~/.snagboat/advisors/<id>/periods/<report id>.json` | [periodReport.v1.schema.json](../packages/schema/src/periodReport.v1.schema.json) (`periodReportSchema`) | One advisor's report for the time since its last one: the measures for all workspaces and for each workspace, compared with the last report's; the team settings and saved rules in force; a one-line summary. Written once and frozen. `revisions` holds what the advisor's model returned: a summary, a verdict for each running experiment, the proposals' ids, and whether you sent it back as accepted or to revise. |
| `ProposalEvent` | `~/.snagboat/advisors/<id>/proposals.jsonl`, one per line, append only | [proposalEvent.v1.schema.json](../packages/schema/src/proposalEvent.v1.schema.json) (`proposalEventSchema`) | `proposed`, with the change (a setting's `before` and `after`, or a saved rule), its scope (`"global"` or `{ "workspace": ... }`), what it does, why, and a prediction on a named measure; then `accepted`, `discarded`, `revised` (with your note), `kept` or `closed`. A revised proposal's replacement names it in `replaces`. `Proposal` is the same, folded into one record per proposal. |
| `Experiment` | `~/.snagboat/experiments/<id>.json` | [experiment.v1.schema.json](../packages/schema/src/experiment.v1.schema.json) (`experimentSchema`) | An accepted proposal: its change and scope, the baseline (the tracked measure's value in the report it was accepted in), the prediction, when the next report judges it (`reviewAt`), its status, how it ended, how many times you kept it going, and the running experiments it overlaps. |
| `SetupEvent` | `~/.snagboat/advisor-drafts/<setup id>/setup.jsonl` while a draft, then `~/.snagboat/advisors/<id>/setup.jsonl`; one per line, append only | [setupEvent.v1.schema.json](../packages/schema/src/setupEvent.v1.schema.json) (`setupEventSchema`) | Setting up an advisor by conversation: `started` (the model you picked), `said` (your turn, and the model you switched to), `answered` (the model's reply, the model that gave it, and maybe a proposed advisor with what the + form asks for, or the problems that kept it out), `revised` (your note), then `accepted` (the advisor it made) or `discarded`. `SetupConversation` is the same, folded into turns. |

`MeasureResult` (one measure, with the value it's compared with) and `AdvisorPeriod` (`daily`, `weekly` or `monthly`) are shared with the advisor code and live in the same file.

## Git, plan, link and finding records

The store's records for the [export design](design/export.md), written by the core's repository job (`git.jsonl`), plan job (`plan.jsonl`), linker (`links.jsonl`) and findings service (`findings.jsonl`), typed in [packages/schema/src/storeRecords.ts](../packages/schema/src/storeRecords.ts) and published as JSON Schema version 1, so the jobs that will write them (and Factory Clock, which will read exports of them) share one shape. A compile-time check keeps each schema's field list equal to its type's, and `storeRecordsSchema.unit.test.ts` validates example records against them.

Each workspace's folder in `~/.snagboat/data` has four files beside `events/`. Each line names its record type in `record`, so one file holds several, and carries `version: 1`:

| File | `record` | Schema | Key |
| --- | --- | --- | --- |
| `git.jsonl` | `commit` | [gitRecord.v1.schema.json](../packages/schema/src/gitRecord.v1.schema.json) (`gitRecordSchema`), `$defs.commit` | `sha`, the full SHA |
| | `branch` | `$defs.branch` | `id`: `<name>@<firstSeenAt>`, so a name deleted and made again is a new branch |
| | `checkout` | `$defs.checkout` | `id`: `checkout-` and 16 hex characters of the SHA-256 of `<worktree>\n<at>\n<commit>` (worktree: `.` for the main one, else its name under `.git/worktrees/`) |
| `plan.jsonl` | `item` | [planRecord.v1.schema.json](../packages/schema/src/planRecord.v1.schema.json) (`planRecordSchema`), `$defs.item` | `id`: the bead's id, or `md-` and 12 hex characters of the SHA-256 of its file and heading path, joined by newlines (a task adds `- ` and its normalized text, after that of any task it's nested under, with ` #2` for a repeat: from the text as it is now, so reordering keeps it and rewording makes a new item) |
| | `transition` | `$defs.transition` | `id`: the bd audit event's id, or `md-t-` and 16 hex characters of the SHA-256 of `<item>\n<at>\n<type>\n<to>` |
| `links.jsonl` | `link` | [linkRecord.v1.schema.json](../packages/schema/src/linkRecord.v1.schema.json) (`linkRecordSchema`) | `id`: `link-` and 16 hex characters of the SHA-256 of `<from.type>:<from.id>\n<to.type>:<to.id>\n<kind>\n<how>` |
| `findings.jsonl` | `finding` | [findingRecord.v1.schema.json](../packages/schema/src/findingRecord.v1.schema.json) (`findingRecordSchema`) | `id`: `finding-` and 16 hex characters of the SHA-256 of `<heuristicId>\n<sessionId>\n<firstTs>` |

The files are append only. A record that changes (a branch merged or deleted, an item's new status, a link that turned observed) is appended again with the same key, and the latest line with a key is the record: `foldStoreRecords` folds a file's lines that way, and `storeRecordKey` gives the key (`commit:<sha>`, `item:snagboat-koh`). An absent value hashes as an empty string; the full SHA-256 is never stored. A job appends nothing when a record hasn't changed, so running it again adds nothing. A link that a later record overturns gets `supersededBy`, naming the link that replaced it (or `"withdrawn"` when the rules withdrew it with nothing in its place); `currentLinks` gives the ones an export writes. A link's `at` (store only, like `supersededBy`) is the time of the latest record in its evidence, which retention reads; a finding's is its `lastTs`.

A commit's `body` and a plan item's `text` are captured text, as `promptText` is: stored only while the project's `captureContent` is on, removed from lines older than `retention.textDays` (by `committedAt`, and by the item's `updated`), and removed from every line by **Snagboat: Remove Captured Text**. Those two are the only rewrites of a file besides `rawDays` retention, each through a temporary file and a rename. A stored copy that lost its text doesn't count as changed, so a job doesn't append it again for that; a record that changes is appended whole.

The linker's rules ([src/core/links.ts](../src/core/links.ts)) and the evidence `rule` each writes:

| Link | Observed | Inferred |
| --- | --- | --- |
| session `made` commit | `tool-call-commit`: a tool call's `refs.commit`. `git-commit-call`: a call ran `git commit` or `gh pr merge` and a commit landed from 2 seconds before to 60 seconds after it (by the committer of the session's other commits, when it has any) | `git-outcomes`: the git outcomes rule, a commit (not a merge) between the session's first event and 30 minutes after its last, touching a file it edited, the most files winning |
| session `worked-on` branch | `checkout`: a checkout in its working tree while it was active. `tool-call-branch`: a call's `refs.branch` | `branch-at-start`: the branch its working tree's last checkout before it started moved to |
| session `touched` plan item | `bd-call`: a call's `refs.planItems` and the item's transition 10 seconds before to 2 minutes after it of the kind its subcommand makes; `how` from the subcommand (`create`: created, `update --claim`: claimed, `close`: closed, others: updated), or from the transition when the command line wasn't recorded. `bd show` is observed `mentioned` | `bd-call` with no matching transition yet (the same link turns observed when it's recorded). `text-mention`: the id in a prompt or reply. `commit-references`: a commit the session made references it. Both `mentioned` |
| transition `made-in` session | `bd-call`: the bd call that made it (as for touched) | The only session with an event within 5 minutes of it and a sign of the item, whose person (the actors and committers of what it observably did) made it: `active-session-touched`, it touched the item (refs: the transition and the touched links); `active-session-bd`, it ran bd within those 5 minutes (refs: the transition and the calls). `active-session` (any session active then) is retired: stored links with it still read, and are withdrawn |
| commit `references` plan item | `commit-message`: its subject or body names the id | `branch-name`: a branch it's on (since the branch was made) is named for the item. `pull-request`: its branch's merge or squash commit names the item |
| branch `merged` into branch | `merge-commit`, `squash-commit` (`BranchRecord.merged.via`) | `reachable`: rebased or fast-forwarded |

Ids in text are found by the project's prefix (`issue-prefix` in `.beads/config.yaml`, else the most common prefix among its beads) and must be plan items the store has. A commit is made in one session, a transition in one session, and a session touches an item once per way: a stored link the rules no longer give, with another link in its place, is appended again with `supersededBy`; one with nothing in its place stays, except an inferred made-in link, which is withdrawn (appended again with `supersededBy: "withdrawn"`, `LINK_WITHDRAWN`) when it came from the retired `active-session` rule or the linker still reads its session's events. What's stored is raw (real paths, git idents, SHAs); the export applies the privacy rules to the same records.

The export adds three records of its own, in [packages/schema/src/exportRecords.ts](../packages/schema/src/exportRecords.ts): `ExportedEvent` ([exportedEvent.v4.schema.json](../packages/schema/src/exportedEvent.v4.schema.json), `exportedEventSchema`), a version 4 event without `workspace` and `raw` and with `redactions`, what the rules replaced in it, by field and rule, without the values; `SessionRecord` ([sessionRecord.v1.schema.json](../packages/schema/src/sessionRecord.v1.schema.json), `sessionRecordSchema`), what `snagboat sessions --json` prints for a session plus its subagents' ids, where it ran, and its branches, commits and plan items; and `ExportManifest` ([exportManifest.v1.schema.json](../packages/schema/src/exportManifest.v1.schema.json), `exportManifestSchema`), the export's `manifest.json`, whose `schemas` names the schema each of the export's files follows. Every export carries copies of the seven schemas in its `schema/` folder, each `$id` made its file name ([src/core/exportPackage.ts](../src/core/exportPackage.ts)). `sessionRecords` ([src/core/sessionRecords.ts](../src/core/sessionRecords.ts)) builds a workspace's session records from its events, `links.jsonl` and `git.jsonl`, as the export and `GET /plans` use them; in the store `where` is the working tree's path, which the export makes `.` or `[worktree-N]`.
