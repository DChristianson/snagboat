# Heuristics

## Contract

```ts
interface HeuristicContext {
  readonly now: string;               // injected, not Date.now(), for deterministic tests
  readonly store: ReadonlyEventStore; // the only way a heuristic may access event data
  readonly settings: Record<string, unknown>;
  readonly contextLimit?: (model: string | undefined) => number | undefined; // lowest limit seen, across workspaces
}

interface Heuristic {
  readonly id: string;
  readonly appliesTo: NormalizedEvent['kind'][]; // push-trigger prefilter; the timer tick always runs everything
  evaluate(ctx: HeuristicContext): Finding[];
}

interface Finding {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
  suggestedAction?: string;
  detectedAt: string; // when this finding was produced; breaks ties when picking the "worst" active finding
}
```

**Deviation from the original design, implemented in v1's first increment**: `evaluate` originally took a single precomputed `window: NormalizedEvent[]`. That doesn't hold up in practice — `stalled` needs only "time since the last event" (an array is the wrong shape and wasted work to build), and `token-budget` needs cumulative token sums, not raw events at all. There is no single window size that serves both of those honestly alongside `backtracking`/`tool-churn`, so `evaluate` now receives a `HeuristicContext` instead, giving each heuristic exactly the query it needs via `store` (a `ReadonlyEventStore`, see [architecture.md](architecture.md) for `EventStore`'s design — the single well-defined query interface heuristics are allowed to use; direct access to `EventLog` or `Aggregate` is not permitted).

Heuristics operate only on normalized events, reached exclusively through `ctx.store`. They never reach back into adapter-specific raw payloads.

## Turns

Most heuristics judge the **current turn** of each session: everything since its latest prompt, from `currentTurns()` in [src/core/turns.ts](../src/core/turns.ts). A turn is **open** until an event with `endsTurn` arrives after its last prompt message. That event is one of:

- a main-agent model call that finished without requesting a tool (`stop_reason: end_turn` in Claude Code transcripts);
- Claude Code's Stop hook;
- an interruption ("[Request interrupted by user]");
- a Copilot reply with no tool requests.

A session whose latest prompt has fallen out of the event store's 24-hour window has no current turn. A new prompt starts a new turn, so findings scoped to the turn clear on your next prompt.

## Built-ins

Defaults come from replaying 20 real sessions (794 turns) with `npm run replay:heuristics -- --all-projects`; see [Calibration](#calibration).

### `runaway-turn`

One prompt has driven at least `snagboat.heuristics.runawayTurn.maxModelCalls` model calls (main agent and subagents, default `100`) or `.maxToolCalls` tool calls (default `100`) without another prompt. Warn. Fires while the turn is current, finished or not. On real history, the 99th percentile was about 80 of each per turn.

### `context-pressure`

For the current turn:

- **warn** when an automatic compaction happened during it (earlier context was summarized away). A manual `/compact` doesn't count.
- **info** otherwise, when the main agent's latest call sent at least `snagboat.heuristics.contextPressure.percent` (default `90`) of the model's limit. The limit is the call's own reported limit (Copilot), else the lowest seen for the model: an auto-compaction's size, kept in [ContextLimits](../src/core/contextLimits.ts). With no limit known yet, only compactions fire.

On real history, 1 in 10 turns peaked above 80% of the limit; 1 in 25 above 90%.

### `cache-thrash`

Within the current turn, at least `snagboat.heuristics.cacheThrash.minCalls` (default `2`) main-agent calls each wrote `.minTokens` (default `50000`) or more to the prompt cache, and more than they read from it: something early in the prompt keeps changing, so each call pays full price. Not counted: the turn's first call, a call after a pause of 5 minutes or more (the cache expired), and the first call after a compaction. Warn. Never fired on real history, which is the intent: it marks a real problem.

### `backtracking`

Within the current turn, the same target failed `snagboat.heuristics.backtracking.minFailures` times (default `3`), or the same file was edited `.minEdits` times (default `10`). Successes in between don't clear it: fix-break-fix loops are the point. Warn. On real history, no turn failed 3 times on one target, and 99% of turns edited one file at most 8 times.

### `tool-churn`

Per session, within the last `snagboat.heuristics.toolChurn.window` minutes (default `5`): at least `.minCalls` targeted tool calls (default `8`), with the two most-hit targets taking at least `.minShare` of them (default `0.9`). Calls without a target (todo lists, pattern searches) are left out. Warn. On real history, two targets took 90% or more of a busy window about 1% of the time.

### `stalled`

An open turn with no agent activity in its session for `snagboat.heuristics.stalled.minutes` (default `15`): the agent is waiting on a long-running tool, a permission prompt, or is stuck. A finished turn going quiet is you being away and never fires. Past `.maxMinutes` (default `180`) the turn is treated as abandoned, since an agent closed mid-turn never records a turn end. Warn. Triggered on every event kind, so new activity clears it promptly through the push path, and on the timer, since it detects an absence.

### `verbal-hedge`

Looks for hedge or self-correction phrases ("I think", "should work", "let me try", "actually,", "my mistake", "that didn't work", …) in the `textExcerpt` of `turn_stop` events. It fires per session when at least `snagboat.heuristics.verbalHedge.minTurns` (default `2`) replies hedge within `.window` minutes (default `10`). It is `info` on its own and escalates to `warn` only when the same session shows a behavioral signal in the window: a target touched 3 or more times, or a failed tool call. Hedging alone never escalates. It is silent when `snagboat.captureContent` is off (it's on by default), since no other path populates `textExcerpt`. Phrases favor multi-word or punctuated forms ("actually," rather than "actually") to avoid matching ordinary prose.

### `token-budget`

Compares cumulative token counts against `snagboat.tokenBudget.session` (per active session) and `snagboat.tokenBudget.day` (per workspace, i.e. project-wide for the current day). Both settings predate this engine and intentionally aren't namespaced under `snagboat.heuristics.*`. A global, cross-workspace rollup and a treemap are deferred: every workspace's storage is isolated today, so "global" needs new shared storage.

## Calibration

`npm run replay:heuristics` replays local Claude Code transcripts through every heuristic, with the extension's 30-second tick, and prints per-session episode counts and times (never content). Add `-- --all-projects` to replay every project, or `-- --settings '<json>'` to try thresholds.

Episodes over the same 20 sessions, before and after the turn-based rules:

| Heuristic | Before | After |
| --- | --- | --- |
| `stalled` | 280 | 52 |
| `context-pressure` | — | 15 |
| `tool-churn` | 14 | 11 |
| `runaway-turn` | — | 4 |
| `backtracking` | 3 | 3 |
| `cache-thrash` | — | 0 |
| `verbal-hedge` | 0 | 0 |
| `token-budget` (no budget set) | 0 | 0 |

`stalled` previously fired at every break, overnight included. Of the 52 left, 45 were a requested tool whose result took 15 minutes or more (a long-running command or a permission prompt), and 7 were turns that never recorded an end before the next prompt.

## Past findings

Live findings only cover the event store's last 24 hours. To show what fired earlier, opening a session in the Sessions tab replays its stored events through every heuristic with [FindingReplay](../src/heuristics/replay.ts), using your current settings and the context limits seen so far. Opening a session is the only time the replay runs over the whole session; after that it takes each new event as it arrives.

The replay works the same way as the live engine:

- It evaluates on each event and ticks every 30 seconds between events.
- Deep into a quiet gap it ticks every 5 minutes, and it stops ticking 4 hours in.
- On ticks it skips heuristics marked `onlyChangesWithEvents`, whose verdict can't change without a new event.
- It records each stretch a heuristic kept reporting as one episode, and a heuristic reporting again within 2 minutes of clearing continues the same episode.

Past findings are only as complete as the stored events. History read back from transcripts, from before a window ran Snagboat, has prompts, model calls, and compactions but no tool calls, because Claude Code's tool calls arrive through hooks. `tool-churn`, `backtracking`, and the tool-call half of `runaway-turn` can't fire there until **Snagboat: Backfill Sessions from Transcripts...** rebuilds tool calls from the transcripts. After a backfill, a stored session's past findings match a replay of its transcripts. Sessions logged before turn ends were recorded are skipped by `stalled`, since every turn would look unfinished.

A replayed episode still reporting at the end that shares events with a live finding of the same heuristic is shown once, as active. Muted heuristics are left out. The largest real session (2,209 events over 11 days) replays in about 0.2 seconds. `npm run replay:heuristics` uses the same code.

## Rules

Besides the built-ins, Snagboat runs **rules**: heuristics written as JSON instead of code. [ruleHeuristic.ts](../src/heuristics/ruleHeuristic.ts) turns each rule into an ordinary heuristic, so a rule's findings show in the status bar and the Sessions tab, replay as past findings, and can be acknowledged and muted like a built-in's. Rules are data. They count events and compare the counts with thresholds; they can't run code, read files, or send anything.

Rules come from two places, and a rule in settings replaces a saved rule with the same id:

- **Saved rules** in `rules.json` in VS Code's global storage, shared by every workspace. Each saved rule records who proposed it, when, and its replay score. Nothing adds saved rules yet: discovery (phase 2 of the [advisor design](design/trusted-advisor.md#phases)) will.
- **`snagboat.rules`** in settings, for writing rules by hand.

A rule that doesn't validate is ignored. Each problem is listed in the Snagboat output (and again by **Snagboat: Show Token/Event Breakdown**), and the status bar shows a health warning until it's fixed.

```json
{
  "id": "user:read-loop",
  "title": "Re-reading the same files",
  "scope": "turn",
  "filter": { "kind": "tool_call", "toolCategory": ["file-read"] },
  "measure": { "type": "maxPerTarget" },
  "when": { "gte": 6 },
  "severity": "info",
  "summary": "{target} read {value} times in this turn",
  "suggestedAction": "The agent may be losing track of the file's contents; consider pointing it at the relevant lines."
}
```

- **`id`**: a source, a colon, then a name in lowercase letters, digits, and dashes (`user:read-loop`). The colon keeps rule ids apart from the built-ins'.
- **`scope`**: which events of each session are measured. `turn` is the session's latest turn, and clears on the next prompt. `session` is the session's events in the event store, which holds the last 24 hours. `window` is the last `windowMinutes` minutes.
- **`filter`**: which events count, on top of each measure's own `filter`. Rules see conversation events only (`user_prompt`, `turn_stop`, `tool_call`, `compaction`), as the built-ins do. Fields:
  - `kind`
  - `agent`
  - `toolCategory`: `shell` also matches its [sub-categories](#shell-sub-categories).
  - `toolName`: exact, or with `*` (`mcp__github__*`).
  - `status`
  - `subagent`: `true` for subagents' events only, `false` for the main agent's.
  - `hasTarget`
  - `hasTokens`: model calls that carry token counts.

  Every list field also takes a single string.
- **`measure`**: one measure, named `value`. **`measures`** names several instead (`{ "calls": {...}, "tools": {...} }`). The types:

  | Type | Value |
  | --- | --- |
  | `count` | Matching events |
  | `distinctTargets` | Different targets among them |
  | `maxPerTarget` | Events on the busiest target; names that target |
  | `topShare` | Share (0 to 1) of targeted events on the top `n` targets (default 1); names the top one |
  | `sumTokens` | Tokens of every kind, added up |
  | `contextPercent` | The latest model call's context as a percentage of the model's limit (the call's reported limit, else the lowest seen) |
  | `failureRate` | Share (0 to 1) of events with a known outcome that failed |
  | `idleMinutes` | Minutes since the latest matching event |
  | `consecutive` | Longest run of matching events among events of the filtered kinds, so model calls between failed tool calls don't break a run of failures |

  A measure with nothing to measure (no targets, no known limit) has no value, and any threshold on it is false.
- **`when`**: thresholds (`gte`, `gt`, `lte`, `lt`) on a measure, combined with `all` and `any`. With one measure, `measure` can be left out.
- **`summary`** and **`suggestedAction`**: text with placeholders. `{name}` is a measure's value (shares and percentages as percentages, tokens shortened), `{name.target}` the target it names, `{target}` the first target any measure names, and `{windowMinutes}` the window.

A rule is re-run on timer ticks only when its verdict can change with time alone: a `window` scope, or an `idleMinutes` measure.

As a check that the format can say what the built-ins do, [rules.unit.test.ts](../src/test/unit/rules.unit.test.ts) writes `runaway-turn`, `tool-churn`, and `backtracking` as rules and checks that each fires at the same times as its built-in. `backtracking` as a rule reports one finding per turn, naming the worst target, where the built-in reports one per target.

### Shell sub-categories

"Shell command" covers every shell call that isn't a script, a test or build, or version control. Sub-categories split it further, and a rule can target one:

```json
{ "id": "user:shell/package-install", "parent": "shell", "label": "Package installs", "match": ["npm install", "pip install", "brew install"] }
```

Each `match` entry is one or two words, compared with the first words of the command's first meaningful segment, the same part the built-in classification reads. The longest match wins. Only commands that would otherwise be plain "Shell command" are refined, so an entry starting with `git` or `npm test` is rejected as one that could never apply. A filter on `shell` still matches every sub-category, so nothing written against the built-in categories changes.

Sub-categories are saved alongside rules, or written by hand in `snagboat.toolCategories`. New tool calls get them as they arrive. Calls already logged keep the category they had.

## Discovery

**Snagboat: Discover Heuristics** opens the detail view's **Suggestions** tab, which looks for what's unusual in your own history and suggests heuristics from it. It needs no model, and nothing is added until you accept. It reads the current workspace's stored events for the last `snagboat.discovery.days` days (default 30). Each workspace's log is separate, so a rule found here reflects this project's habits, and a rule accepted from it will record which workspace it came from. `npm run discover` runs the same code over this project's Claude Code transcripts.

[discover.ts](../src/discovery/discover.ts) works in four steps:

1. **Measure every past turn.** Each feature is a turn-scoped rule measure from [probes.ts](../src/discovery/probes.ts): model calls, tool calls, tokens, failures and edits on one target, failures in a row, failure rate (turns with 5 or more decided calls), and per tool category, calls and calls on one target.
2. **Find your tail.** The threshold is the value reached by your top 1% of turns, but always by at least 3 real turns, rounded down to a whole count, a 5% step, or two significant digits of tokens. It needs 50 turns with their prompts.
3. **Propose a rule** where that tail is an outlier. The threshold has to be at least twice your median and above a floor per feature, the turns reaching it have to span 2 or more sessions, and it can't be common through ties (more than 3% of turns). For a feature a built-in already measures, discovery compares the built-in's current threshold with your tail instead.
4. **Score it by replay.** Each candidate is replayed with [FindingReplay](../src/heuristics/replay.ts), session by session, alongside the running heuristics. The report gives its episodes, its sessions, and how many episodes of each existing heuristic it overlaps.

Shell sub-category candidates come from [shellCategories.ts](../src/discovery/shellCategories.ts). Each plain "Shell command" call belongs to a command family: the first word of the command, or the first two for commands like `npm` and `docker` whose second word says what they do. A family that takes at least 10% of shell calls, with 5 or more calls in 2 or more sessions, becomes a candidate.

In the Suggestions tab:

- **Candidate rules** show the threshold, how many of your turns reach it, your percentiles, the replay score, and up to five sessions where it would have fired (opening one shows the candidate's past findings). Changing the threshold re-scores it. **Accept** saves the rule as shown, recording that discovery proposed it, when, in which workspace, and its replay score. **Dismiss** hides it in every workspace until you choose to show dismissed suggestions again.
- **Built-in thresholds** compare each built-in setting with your history. **Apply** writes discovery's suggested value to your user settings.
- **Shell sub-categories** can be accepted or dismissed the same way. An accepted category labels new tool calls; calls already logged keep their category.
- **Your rules** lists saved rules and categories with where they came from, with **Remove**, and the ones written in settings.

**Snagboat: Export Rules...** writes saved rules and categories, with their provenance, to a JSON file. **Snagboat: Import Rules...** reads one back (or a plain list of rules, as in `snagboat.rules`), replays each rule over this workspace's history, and lets you pick which to add. An imported rule replaces a saved rule with the same id.

`npm run discover` prints the same findings as text, naming heuristic ids and command families only, never targets, paths, prompts, or session names.

## Acknowledging and muting

Heuristics don't need to do anything to support either: both are applied by `FindingsRegistry` on top of whatever a heuristic reports, keyed by heuristic id. See [architecture.md](architecture.md#heuristics-engine).

## Plugin model

Third-party heuristics should register via `snagboat.heuristics` and document:

- which `NormalizedEvent.kind` values they inspect
- which findings they emit
- any settings they introduce
- whether they require optional data such as `textExcerpt`

## Session-level rollups

The design reserves separate, slower rollups for evaluating longer-running virtues and failure modes over a session, day, or PR. Those rollups should remain distinct from short-window heuristics so the status bar can stay responsive.
