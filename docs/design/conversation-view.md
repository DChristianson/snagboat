# Design: conversation-aware view

Status: **accepted**; phase 1 (data) and phase 2 (views) built. Mockups use synthetic data. Decisions from the first review are recorded under [Decisions](#decisions).

## Summary

Snagboat counts tokens and events but doesn't know about *conversations*: which prompt a model call served, how full the context window was, when the context was compacted, or what subagents did. The current heuristics require more tuning. This design adds conversation structure to the event model (prompts, turns, compactions, subagents, context size), two views of a session (a context timeline and a turn tree), and turn-based heuristics calibrated against real transcripts.

## Problems this addresses

1. **Findings are rare and not very meaningful.** With default settings:
   - `token-budget` is off until a budget is set;
   - `tool-churn` currently needs 8+ calls in 5 minutes on at most 2 distinct targets *across all sessions*, which ordinary work never meets;
   - `backtracking` is suppressed by any successful call in between, and nearly every agent edit "succeeds";
   - `stalled` can't tell a stuck agent from a user who stepped away.

   None of these thresholds has been calibrated against real sessions.
2. **Token totals have no context.** A day's total says nothing about which request was expensive, whether caching broke, or how close a session came to the context limit.
3. **Subagent tokens are missing.** Claude Code writes subagent work to `<session>/subagents/*.jsonl`, which Snagboat doesn't read.

## Goals

- Attribute every model call and tool call to the **turn** (user prompt) that caused it, and to the **agent** (main or a subagent) that made it.
- Record **context size per call** and **compactions**.
- Read **subagent transcripts**.
- Two views of a session: a context timeline and a turn tree (a third, cost per prompt, is deferred).
- Replace or recalibrate heuristics using turns, and tune thresholds by **replaying real transcripts**.

## Non-goals

- Storing prompt text. Prompts become markers with a time and an id, never content. That's consistent with [PRIVACY.md](../../PRIVACY.md), where content capture is limited to agent replies.
- Full Copilot parity in the first phase (see [Copilot](#copilot)).
- Cost in dollars. That needs per-model pricing, which is a separate decision.
- The cost-per-prompt view, for now.

## What the data provides

Checked against four real Claude Code transcripts (two projects, Claude Code 2.1.274–2.1.301), looking at structure only:

| Need | Where it comes from | Verified |
| --- | --- | --- |
| A user prompt | A `user` line whose content is text, not a `tool_result`, with no `toolUseResult` and not `isMeta`. Each carries a `promptId`. | 66–92 prompts per session, all with a `promptId` |
| Which turn a model call belongs to | Assistant lines don't carry `promptId`; walk `parentUuid` back to the nearest prompt line | Chain present on every line |
| Context size of a call | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the (deduplicated) message | Peaks of 554K–946K: 1M-context models |
| Compaction | A `system` line with subtype `compact_boundary`, an `isCompactSummary` line, and context dropping by more than half | Seen once (racer) |
| Turn end | `system` lines with subtype `stop_hook_summary`, and the `Stop` hook | Present |
| Subagent | Separate transcript at `<session>/subagents/*.jsonl`, lines with `agentId`, `isSidechain`, and `promptId` | 4 files in this project |
| API errors | `system` lines with subtype `api_error` | 1–11 per session |

## Data model changes

`NormalizedEvent` gains optional fields and two kinds:

```ts
kind: ... | 'user_prompt' | 'compaction';
turnId?: string;    // the promptId of the turn this event belongs to
agentId?: string;   // set for subagent work; absent for the main agent
```

- **`user_prompt`**: one per prompt line. It carries `turnId`, `ts` and `sessionId`, with no `textExcerpt` and no `target`.
- **`compaction`**: one per `compact_boundary`, carrying its `trigger` (`auto` or `manual`) and the context size before and after (`compactMetadata.preTokens` / `postTokens`; a real auto-compaction in this project fired at 987,250 tokens).
- **`turn_stop` events (model calls)** gain `turnId` and `agentId`. Context size needs no new field: it's derivable from `tokens` now that usage is counted once per message.
- **`tool_call` events** gain `turnId`; see [Tool attribution](#tool-attribution).

**Turn attribution:** the transcript adapter keeps, per file, a bounded map from line `uuid` to `turnId` (a few thousand entries). A prompt line starts a new `turnId`, and every other line inherits its parent's. Subagent lines carry `promptId` directly. The map lives in memory. After a restart, lines whose parent isn't in the map fall back to the most recent prompt in that file, which is correct except in the rare case of a turn split across a restart.

**Subagents:** the tailer also watches `<session>/subagents/` folders, discovered on its existing 60-second rescan, using the same per-message deduplication. This alone fixes the missing tokens, independent of the charts.

**Retention:** these are ordinary events in the same daily logs, under the same `rawDays` policy. Daily aggregates gain prompt and compaction counts.

**Models and context limits:** every model call already records its model as reported by the source (`claude-opus-5-5`, `claude-sonnet-5`, …, from the transcript's `message.model`; `gen_ai.request.model` / `gen_ai.response.model` for Copilot). Claude Code also writes a few `<synthetic>` model lines carrying no tokens; those are ignored.

Two marks are kept per model, in a table in the extension's global storage (shared across workspaces), and both update live as calls arrive:

- **Largest seen**: the biggest context any call to that model has sent. Always known once the model has been used. On this machine so far: Opus 5.5 at 964K, Sonnet 5 at 967K.
- **Limit**: set only when a limit is actually **encountered**: an **automatic** compaction (its `preTokens`) or an API error saying the context is too long (the error's shape needs checking in phase 1). Manual compactions don't count, since you chose when they happened. If encountered more than once, the lowest value wins, since that's where the model actually ran out. An earlier auto-compaction on Opus 5.5 here sets its limit at 987K.

The timeline draws each mark that's known as its own labeled horizontal line ("largest seen", "limit"), so a session's peak can be read against both. No line is drawn for a mark that isn't known yet.

**Older sessions:** the views load a session's events by reading its days' raw files when the session is opened, beyond the 24-hour in-memory window. Raw events are kept for `rawDays`. A per-session summary can come later if this proves slow.

## Views

Both mockups show the same synthetic two-hour session: 10 prompts, one runaway turn, a burst of cache invalidation, one compaction and two subagents. Colors follow the detail view's validated palette (blue for cache read, orange for cache creation, aqua for fresh input) and mean the same thing in every chart. Findings use the status color, always with an icon and a label.

### 1. Context timeline

![Context timeline mockup](images/context-timeline.svg)

**Shows:** every model call in one session as a step whose height is the context it sent, split into cache read, cache creation and fresh input, against time. Prompts are vertical rules. A compaction shows as a sharp drop, and findings are pinned where they happened. Below, on the same time axis but **its own scale**, a strip shows the output tokens of each call. Output is roughly 1/300th of the context, so sharing the context axis would flatten it to nothing, and two y-axes on one chart would invite misreading. Subagents get their own lane, since they run in a separate context.

**Answers:** how fast the context grew, when caching broke (orange spikes), how close the session came to the limit, and where you intervened.

**Interactions:**
- hover a step for its breakdown, model, time and prompt;
- click a prompt rule to see that turn in the timeline below the chart;
- pick a session from a dropdown that defaults to the most recent.

Decided: time on the x-axis; output tokens shown in their own strip.

### Deferred: cost per prompt

One column per prompt with everything spent until the next prompt. Dropped for now; the turn tree's prompt row shows the same proportions. The generator keeps its mockup code for later.

### 2. Turn tree

![Turn tree mockup](images/turn-tree.svg)

**Shows:** an icicle chart: session → prompts → who did the work (main agent or subagent) → what the work was (tools), with width proportional to tokens.

**Answers:** "where did the tokens go?" at any level, with zoom by click.

The tool row is approximate, marked ≈, by the attribution rule below.

## Navigation

Everything stays in the one Snagboat panel (the detail page), which gains a session level. There's no switching between the two views: a session shows **the turn tree on top and the context timeline in a panel below it**, linked to each other.

![Session view wireframe](images/session-view.svg)

**Tabs:** **Overview** (today's detail page, unchanged) and **Sessions**.

**Sessions tab:**
- **Session list:** one row per session, with start time, agent, model(s), prompt count, tokens, duration and finding count; a live session is marked ●. It's filtered by day (Today by default; any retained day from a picker, loaded from the daily files), plus agent and text filters.
- **Choosing a session** opens the session view under the list:
  - a **breadcrumb** (`Sessions › 7f3a › P5 › main agent`) that follows zooming in the tree and steps back out;
  - the **turn tree**. Clicking a block zooms the tree to it, and the timeline highlights the matching time span;
  - the **context timeline panel**. In normal size it shows just the context chart. Clicking a prompt rule selects that prompt in the tree.
- **Expanding the timeline** (⤢ Expand) makes it the focus:
  - the session list collapses to a one-line session picker;
  - the tree shrinks to its prompt row, which still works for selecting a prompt;
  - the timeline takes the remaining height and shows its full detail: the output strip, subagent lanes and finding labels.
  - Dragging across the expanded timeline zooms it to a time range. ⤡ Collapse restores the normal layout.

**Ways in:**

| From | Goes to |
| --- | --- |
| A finding on the Overview ("Show in session") | Its session, with the finding's prompt selected and the timeline scrolled to it |
| A row in the Overview's event timeline (its session id) | That session, at the event's time |
| A day's bar in the daily token chart | The Sessions list for that day |
| Command palette: **Snagboat: Open Session…** | A quick pick of recent sessions, opening straight into the session view |

The status bar click still opens the Overview. A live session is the first row of the Sessions list.

**State:** the tab, selected session, zoom level and whether the timeline is expanded are restored when the panel reopens, as filters are today. Selections use an in-page address (`session/7f3a?prompt=5`), so the back action and the "Open Session…" command land in the same place.

**Not in this design:** one panel per session, for comparing sessions side by side. Easy to add later.

## Tool attribution

Two approximations, labeled as approximate wherever they're shown. Neither produces findings.

### Tool classification

Each tool call is labeled with a **high-level category** saying what kind of thing was run. The label comes from the tool's name and, for shell commands, the command line. Categories:

| Category | Examples of what lands there |
| --- | --- |
| File read | `Read`; Copilot `read_file` |
| File edit | `Edit`, `Write`, `NotebookEdit`; Copilot `apply_patch`, `create_file` |
| Search | `Grep`, `Glob`; Copilot `file_search`, `grep_search` |
| Script | A shell command running a local script file: `python tools/fix.py`, `node scripts/x.js`, `./run.sh`, `bash deploy.sh` |
| Tests and builds | `npm test`, `npm run build`, `pytest`, `cargo test`, `make`, `go test` |
| Version control | `git …`, `gh …` |
| Shell command | Any other shell command (`ls`, `curl`, `sed`, …) |
| Web | `WebFetch`, `WebSearch`; Copilot `fetch_webpage` |
| MCP tool | `mcp__<server>__<tool>`, labeled with the server name (e.g. "MCP: github") |
| Subagent | `Task` / `Agent` launching a subagent |
| Other | Anything unrecognized, labeled with its tool name |

The rules are simple pattern matches on the first word or two of the command, kept in one table so they're easy to extend. They'll get some calls wrong (a `make` target that's really a deploy, a script run through `npm run`), which is acceptable for a high-level picture. The category is computed in the adapter and stored on `tool_call` events as `toolCategory`. Storing it adds no new sensitive data, since the command it's derived from is already stored as the event's `target`. The turn tree's tool row and the timeline's tooltips show categories rather than raw tool names.

### Linking tool calls to turns

The transcript records each tool call as a `tool_use` block inside a model call, so its turn comes from the same `parentUuid` chain. Hook events still supply the target and success or failure. They're matched to the transcript's tool call by `tool_use_id` if the hook payload carries it (to be checked in phase 1), and otherwise by tool name and order within the session.

### Crediting tokens to tools (turn tree row 4)

A call's **output** tokens are split evenly across the tools it requested. The **growth in context** between that call and the next, which is mostly the tools' results, is split across the same tools, weighted by result size when known. The rest of a call's context (cache reads of what was already there) goes to "context carried forward" rather than to any tool. This misattributes when one call mixes a cheap and an expensive tool, which is acceptable for a "where did it go" overview.

## Heuristics

**New, turn-based:**

| Heuristic | Fires when (initial thresholds, to calibrate) | Severity |
| --- | --- | --- |
| `runaway-turn` | One prompt drives more than N model calls or M tool calls without you prompting again | warn |
| `context-pressure` | A call's context exceeds X% of the model's limit, or a compaction happens | info, warn on compaction |
| `cache-thrash` | Within one turn, several calls each create more than Y tokens of cache, meaning the prompt cache keeps being invalidated | warn |

**Changes to existing ones:**
- **`stalled`:** fire only while a turn is open (a prompt with no stop yet). That means "the agent is stuck", not "you're away".
- **`backtracking`:** count failures and repeated edits to the same file within a turn. A successful tool call no longer clears the finding.
- **`tool-churn`:** evaluate per session, and use the share of calls on few targets rather than an absolute two-target cap.

**Baseline (phase 1 replay, before any changes):** four real sessions totalling about six days and 268 prompts. `stalled` fired 93 times, at every break, including overnight. `tool-churn` fired 3 times, `backtracking` once, and `token-budget` never (no budgets set). `verbal-hedge` fired 0 times, with reply text available: only 5 of 818 replies contained any hedge phrase (one of them a reply *listing* the phrases), and never two within 10 minutes.

**Calibration:** a `npm run replay:heuristics` dev script, like `verify:transcripts`, that replays local transcripts through every heuristic and reports, per session, what fired and when. It prints counts and times only, never content. Thresholds are then set so findings are rare but real on your own history.

## Copilot

Copilot data collection is **in phase 1**, and the capture step changed the plan. A structure-only capture of real Copilot traffic (`snagboat.copilot.captureStructure`, summarized by `npm run summarize:copilot`) showed:

- **Agent mode emits no OpenTelemetry.** In current VS Code, Agent mode runs in VS Code's built-in agent host through the Copilot CLI (`provider: "copilotcli"` in the agent host log). Nothing reached the receiver over IPv4 or IPv6 while agent turns with tool calls ran.
- **The Copilot CLI writes a per-session event log** at `~/.copilot/session-state/<session>/events.jsonl`, structured much like Claude Code's transcripts: `user.message` (with `interactionId`), `session.usage_record` per model call (model, input/output/cache read/cache write/reasoning tokens, and `maxPromptTokens`, the context limit), `tool.execution_start`/`complete` (tool name, arguments, success, exit code), turn start/end events, and an `id`/`parentId` chain. `session.start` records the session's `cwd`. On four real sessions, every event attributes to a prompt, and `inputTokens` always includes the cache tokens.
- **Copilot's OpenTelemetry covers editor features only:** each `chat <model>` span is one model call for inline and next-edit suggestions or helper calls (chat titles, intent), with per-call usage and `copilot_chat.request.max_prompt_tokens`. Snagboat had been turning the token-usage *metric* into Copilot "turns", which counted inline suggestions as agent turns.

So Copilot uses two sources:

1. **Agent mode:** the Copilot CLI session logs, tailed like Claude Code transcripts and filtered to sessions whose `cwd` is inside the window's workspace. They provide the same `user_prompt`, model-call (with `contextLimit`), and `tool_call` events, with `turnId` from `interactionId`.
2. **Editor features:** OTel `chat` spans as model calls with `channel: 'inline'`, counted as tokens but not as turns. Metrics are no longer mapped, since the spans carry the same counts.

Open: reply excerpts for Copilot (for `verbal-hedge`) aren't mapped yet; `assistant.message` carries the reply and can be joined to its usage record by `apiCallId`.

## Phases

1. **Data:**
   - `user_prompt` and `compaction` events;
   - `turnId` and `agentId` attribution, tool classification, and linking tool calls to turns;
   - subagent tailing;
   - the observed context-limit table;
   - Copilot: the structure capture, then agent sessions from the Copilot CLI session logs and editor-feature calls from OTel spans;
   - schema and privacy doc updates;
   - the heuristic replay script.

   Useful on its own: it fixes the missing subagent tokens and lets heuristics be calibrated.
2. **Views:** the Sessions tab with the session list, the turn tree above the expandable context timeline, the links from the Overview, and on-demand loading of older sessions (see [Navigation](#navigation)).
3. **Heuristics:** the new turn-based heuristics and the changes above, with thresholds from replay.

## Implementation notes (phase 2)

Where the build differs from, or adds to, the design above:

- **Turns, not prompt messages, are the unit.** A message sent while the agent is still working shares the running turn's `promptId` (6 of 66 prompts in one real session). The tree has one node per turn, prompt markers in the same turn share its number, and the session list's "prompts" counts turns.
- **Tool-category crediting is simpler than designed.** Each turn's (or subagent's) tokens are split across tool categories in proportion to how many calls of each category it made, instead of crediting output and context growth per call. The per-call rule needs a link from each tool call to the model call that requested it, which not every source provides. Values stay marked ≈.
- **The timeline zooms to a turn by default.** Real sessions span days with idle nights, so the full time range is mostly empty. The timeline shows the selected turn (or the latest), "Show whole session" zooms out, and expanded mode adds drag-to-zoom. Steps are capped at 3 minutes, so idle gaps read as gaps.
- **Only the main agent's context is plotted.** Subagents run in separate contexts, so they appear as lanes (expanded) rather than stacked onto the main context.
- **Unlinked calls get their own bucket.** Model calls with no turn, or whose turn's prompt isn't in the loaded events, go in a first "Unlinked" node, so the tree's total still matches the session's. Mostly these are events logged before turns were recorded; see the backfill task in the [roadmap](../roadmap.md#planned-tasks).
- **Tree colors separate turns by lightness and give categories meaning.** Only about 6–12 hues stay distinguishable (Healey 1996; Ware, *Information Visualization*), and a session can have 90 turns, so turns don't get hues. Instead neighboring turns alternate two shades of blue, and each turn's agent and category blocks inherit its shade. Category blocks take one of five colors, grouping related categories (read with search, shell with version control); web, MCP, subagent, other, and replies only are neutral. Five is the most that passed the palette check (colorblind and normal-vision separation, in both themes) when any two could sit side by side. Categories are drawn in that fixed color order, not by size, so the check holds and a category sits in the same place in every turn. Blocks are tinted with a solid top stripe, keeping labels in the normal text color. Unlinked is gray and dashed.

## Implementation notes (phase 3)

- **Turn ends are recorded.** "Open turn" needs a turn end, which phase 1 didn't keep. Events now carry `endsTurn`, set by a main-agent `end_turn` model call, the Stop hook, an interruption, or a Copilot reply with no tool requests. 784 of 794 real turns end this way.
- **Interruptions aren't prompts.** Claude Code writes "[Request interrupted by user]" as a user line, which phase 1 counted as a prompt (27 times in real history). It now ends the turn instead.
- **Scoped to the current turn.** `runaway-turn`, `context-pressure`, `cache-thrash`, and `backtracking` judge each session's latest turn, so they clear on your next prompt. `stalled` needs an open turn; `tool-churn` stays a rolling window, per session.
- **Thresholds from replay.** Defaults and before/after episode counts are in [heuristics.md](../heuristics.md#calibration). `cache-thrash` and the failure half of `backtracking` never fired on real history; they're kept because the failure modes are real.
- **Past findings in the session view.** Live findings only cover the last 24 hours, so opening a session replays its events through the heuristics (see [heuristics.md](../heuristics.md#past-findings)). The turn tree's badges and the timeline show both past and active findings: active ones filled, earlier ones outlined with a dashed bracket. A findings list under the timeline gives each one's start, severity, state, turn, and summary, and "Show" selects its turn.
- **`stalled` is capped.** Past `maxMinutes` (default 180) a quiet open turn counts as abandoned: an agent closed mid-turn never records an end.

## Decisions

From the first review:

| Question | Decision |
| --- | --- |
| Which views | Context timeline and turn tree. Cost per prompt deferred. |
| How they're arranged | Both at once: the turn tree on top, the timeline in an expandable panel below. No toggle. |
| Timeline x-axis | Time |
| Output tokens on the timeline | Shown, in their own strip on the same time axis |
| Context limits | Two live marks per model: "largest seen" (always) and "limit" (only once an auto-compaction or context-too-long error is encountered), each drawn as its own line |
| Sessions older than 24 hours | Read from the daily files on demand; optimize later |
| Tool attribution | A classification heuristic labeling each tool call with a high-level category (script, shell command, tests and builds, file edit, MCP tool, …), plus approximate token crediting for the turn tree (see [Tool attribution](#tool-attribution)) |
| Copilot | Collected in phase 1, starting with a structure-only capture of real traffic |

## Open questions

None outstanding from review.

## Later

- **Split "Shell command" further** (package installs, network, file system, …) once real data shows which commands are common. The category list is otherwise agreed.
