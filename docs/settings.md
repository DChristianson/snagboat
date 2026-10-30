# Settings

Every setting Snagboat contributes, by area. All are in the `snagboat` section of VS Code's settings; the heuristics' defaults come from replaying real sessions (see [heuristics.md](heuristics.md#calibration)), and **Snagboat: Discover Heuristics** compares them with your own history.

## Captured text and retention

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.captureContent` | `true` | Store your prompts (up to 2,000 characters), agent reply excerpts (up to 500), and session names, with common secret formats redacted first. Never tool output or file contents. Prompts and replies are kept for `textDays`, names for as long as the session's events. **Snagboat: Remove Captured Text** deletes what's stored. Copilot editor features' replies also need `github.copilot.chat.otel.captureContent`. |
| `snagboat.retention.rawDays` | `90` | Days of raw events to keep, counting today. Older days are rolled up into daily totals and their raw events deleted. |
| `snagboat.retention.textDays` | `30` | Days captured prompts and reply excerpts are kept, counting today, capped at `rawDays`. Older events keep everything else, without the text. The default matches how long Claude Code keeps its own transcripts. |
| `snagboat.retention.aggregateDays` | `-1` | Days of daily totals to keep; `-1` keeps them forever, `0` keeps none (raw days past `rawDays` are then deleted without being rolled up). |

See [PRIVACY.md](../PRIVACY.md) for what each source records and where everything is stored.

## Sources

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.claudeCode.configureHooks` | `true` | Add Snagboat's `PostToolUse` and `Stop` hooks to each workspace folder's `.claude/settings.json` (set per folder). Off leaves the file alone: token usage still comes from transcripts, but tool calls and turn ends from hooks stop. **Snagboat: Remove Claude Code Hooks from Project...** removes existing entries and turns this off. |
| `snagboat.copilot.otlpPort` | `4318` | Local port for Copilot's OpenTelemetry export; point `github.copilot.chat.otel.otlpEndpoint` at `http://127.0.0.1:<port>`. Only one window can listen on it. |
| `snagboat.copilot.captureStructure` | `false` | Development aid: record the structure of Copilot's telemetry (span names, links, timings, attribute names, and numbers such as token counts; every text value replaced by its length) to global storage, for mapping its spans. Summarize with `npm run summarize:copilot`. |

## Budgets

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.tokenBudget.session` | unset | `token-budget` warns when one session's tokens cross this total. |
| `snagboat.tokenBudget.day` | unset | `token-budget` warns when this workspace's tokens for the day cross this total. |

## Heuristic thresholds

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.heuristics.runawayTurn.maxModelCalls` | `100` | Model calls in one turn (main agent and subagents) before `runaway-turn` fires. |
| `snagboat.heuristics.runawayTurn.maxToolCalls` | `100` | Tool calls in one turn before `runaway-turn` fires. |
| `snagboat.heuristics.runawayTurn.earlyWarning` | `0.8` | With notifications on, warn early once a turn reaches this share of either threshold. `0` turns early warnings off. |
| `snagboat.heuristics.contextPressure.percent` | `90` | Share of the model's context limit at which `context-pressure` reports (info). An automatic compaction always warns. |
| `snagboat.heuristics.contextPressure.earlyWarning` | `0.8` | With notifications on, warn early once a turn's context reaches this share of the percentage. `0` turns early warnings off. |
| `snagboat.heuristics.cacheThrash.minTokens` | `50000` | Cache tokens a call must write (and more than it reads) to count as a rewrite. |
| `snagboat.heuristics.cacheThrash.minCalls` | `2` | Rewrites in one turn before `cache-thrash` fires. |
| `snagboat.heuristics.backtracking.minFailures` | `3` | Failures on one target within a turn before `backtracking` fires. |
| `snagboat.heuristics.backtracking.minEdits` | `10` | Edits to one file within a turn before `backtracking` fires. |
| `snagboat.heuristics.toolChurn.window` | `5` (minutes) | Window `tool-churn` looks back over. |
| `snagboat.heuristics.toolChurn.minCalls` | `8` | Targeted tool calls in one session within the window before `tool-churn` can fire. |
| `snagboat.heuristics.toolChurn.minShare` | `0.9` | Share of those calls the two most-hit targets must take. |
| `snagboat.heuristics.stalled.minutes` | `15` | Quiet minutes in an unfinished turn before `stalled` fires. A finished turn going quiet never fires. |
| `snagboat.heuristics.stalled.maxMinutes` | `180` | Quiet minutes after which the turn counts as abandoned and `stalled` stops. |
| `snagboat.heuristics.verbalHedge.window` | `10` (minutes) | Window `verbal-hedge` looks back over. Only active with `captureContent` on. |
| `snagboat.heuristics.verbalHedge.minTurns` | `2` | Hedging replies in one session within the window before `verbal-hedge` fires. |

## Rules and discovery

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.rules` | `[]` | Heuristic rules to run alongside the built-ins, as JSON (see [Rules](heuristics.md#rules)). For trying the format out; a rule here replaces a saved rule with the same id. Invalid rules are ignored and listed in the Snagboat output. |
| `snagboat.toolCategories` | `[]` | Sub-categories of "Shell command", as JSON (see [Shell sub-categories](heuristics.md#shell-sub-categories)). New tool calls get them; a rule filtering on `shell` still matches them all. |
| `snagboat.discovery.days` | `30` | How many days of this workspace's history **Snagboat: Discover Heuristics** reads, so suggestions follow your current habits. |

Accepted rules and categories live in `rules.json` in Snagboat's global storage, not in settings; **Snagboat: Export Rules...** and **Import Rules...** move them as a file.

## Advisor

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.advisor.providers` | one local provider: Ollama at `http://localhost:11434/v1` | Models the advisor can use: OpenAI-compatible chat completion endpoints, each with an `id`, `label`, `baseUrl`, and `model` (empty: pick from the server's models on first use). A loopback `baseUrl` makes a provider local; any other is hosted, must use https, needs an API key (**Snagboat: Set Advisor API Key...**), and is audited. `send` sets what it may receive: `prompts` and `sessionNames` (default: local yes, hosted no), `replies` (default: no), and `paths` (`relative` or `hashed`). See [the advisor](../PRIVACY.md#the-advisor). |
| `snagboat.advisor.explainProvider` | `"local"` | The provider Explain uses. |
| `snagboat.advisor.proposeProvider` | `"local"` | The provider the Suggestions tab asks to propose heuristics. |
| `snagboat.advisor.reviewProvider` | `"local"` | The provider asked to add its judgment to a review (**Ask the Advisor**, after **Snagboat: Write Review**). |
| `snagboat.advisor.nudgeProvider` | `"local"` | The provider asked for a one-line suggestion when a nudge fires (`snagboat.nudges.advisor`). |
| `snagboat.advisor.auditPayloads` | `false` | Also keep the full payload of each request to a hosted provider in the audit log, for `rawDays`. Off, the log keeps when, which capability, the size, and a hash. |
| `snagboat.advisor.reviewDirectory` | `""` | Where **Snagboat: Write Review** writes its Markdown reports, one per week and workspace. Empty: `~/.snagboat/reviews`. |
| `snagboat.advisor.weeklyReview` | `false` | Write this workspace's review once a week, the first time a window is open that week, without a model. You're told when it's written and can then ask the advisor to add to it. |

## Notifications

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.nudges.notify` | `"off"` | `warnings` notifies when a warning appears (and for early warnings); `all` for every finding. At most one per turn, never modal; muted heuristics never notify. See [Nudges](heuristics.md#nudges). |
| `snagboat.nudges.quiet` | `[]` | Heuristic or rule ids that never notify, while still showing in the status bar. |
| `snagboat.nudges.advisor` | `false` | When a nudge fires, also ask `nudgeProvider` for one line on what to do, shown under the finding in the status bar tooltip as model output. It never prompts while you work: until you've picked a model and approved that provider's payload through Explain, it doesn't ask. |
