# Settings

Every setting Snagboat contributes, by area. All are in the `snagboat` section of VS Code's settings; the heuristics' defaults come from replaying real sessions (see [heuristics.md](heuristics.md#calibration)), and **Snagboat: Discover Heuristics** compares them with your own history.

## Captured text and retention

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.captureContent` | `true` | Store your prompts (up to 2,000 characters), agent reply excerpts (up to 500), and session names, with common secret formats redacted first. Never tool output or file contents. Prompts and replies are kept for `textDays`, names for as long as the session's events. **Snagboat: Remove Captured Text** deletes what's stored. Copilot editor features' replies also need `github.copilot.chat.otel.captureContent`. |
| `snagboat.retention.rawDays` | `90` | Days of raw events to keep, counting today. Older days are rolled up into daily totals and their raw events deleted. |
| `snagboat.retention.textDays` | `30` | Days captured prompts and reply excerpts are kept, counting today, capped at `rawDays`. Older events keep everything else, without the text. The default matches how long Claude Code keeps its own transcripts. |
| `snagboat.retention.aggregateDays` | `-1` | Days of daily totals to keep; `-1` keeps them forever, `0` keeps none (raw days past `rawDays` are then deleted without being rolled up). |
| `snagboat.storage.perUserStore` | `false` | Preview (RFC step 3c-1): keep data in one per-user store, `~/.snagboat/data`, one folder per workspace, instead of VS Code's storage for each window. Turning it on copies this window's data there and leaves the original in place, so turning it off goes back to it as it was. With it on, the window starts the core service (`snagboat serve`), which collects and writes, and shows its own workspace from it (3c-3c); if the core can't start, the window writes its own folder as before. The core records Claude Code sessions in every project on the machine: see `collect.unopened` below to limit it. Set it in User settings; it is not offered under Workspace. Applies to all windows, when each reloads. See `snagboat migrate` in the CLI. |

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
| `snagboat.advisors` | `[]` | Installed advisors (below): each a model with the abilities it offers and what it may receive for each. |
| `snagboat.advisor.providers` | one local provider: Ollama at `http://localhost:11434/v1` | The short form of an advisor: a model offering every ability with one set of sending rules. OpenAI-compatible chat completion endpoints, each with an `id`, `label`, `baseUrl`, and `model` (empty: pick from the server's models on first use). A loopback `baseUrl` makes it local; any other is hosted, must use https, needs an API key (**Snagboat: Set Advisor API Key...**), and is audited. `send` sets what it may receive: `prompts` and `sessionNames` (default: local yes, hosted no), `replies` (default: no), and `paths` (`relative` or `hashed`). See [the advisor](../PRIVACY.md#the-advisor). |
| `snagboat.advisor.defaults` | `{}` | The advisor each ability uses unless you pick another, by id: `summarize-session` (Explain), `summarize-week` and `propose-nudges` (the review; `propose-nudges` is also the one-line suggestion under a finding), `propose-heuristics` (Ask the advisor), `propose-tactics` (**Tactics** on a session, and the review). Unset abilities use `local`. The older `explainProvider`, `reviewProvider`, `proposeProvider`, and `nudgeProvider` settings still work when this is unset. |
| `snagboat.advisor.headlines` | `false` | Give each session a one-line headline from the `summarize-session` advisor (what you were trying to do and how it went), under its name in the session list and in the open session's summary line, as model output. Asked quietly, one session at a time, once a session has been idle past the `stalled` window, for the last 7 days' sessions; never while you work, and only after you've approved that advisor's payload through Explain. |
| `snagboat.advisor.modelTiers` | `{}` | Your own tiers for models, by a fragment of the model name (`{ "opus": "high", "sonnet": "mid", "haiku": "low" }`), sent with **Tactics** so the advisor judges fit by your ranking rather than by name. |
| `snagboat.advisor.auditPayloads` | `false` | Also keep the full payload of each request to a hosted provider in the audit log, for `rawDays`. Off, the log keeps when, which capability, the size, and a hash. |
| `snagboat.advisor.reviewDirectory` | `""` | Where **Snagboat: Write Review** writes its Markdown reports, one per week and workspace. Empty: `~/.snagboat/reviews`. |
| `snagboat.advisor.weeklyReview` | `false` | Write this workspace's review once a week, the first time a window is open that week, without a model. You're told when it's written and can then ask the advisor to add to it. |

### Installed advisors

An entry in `snagboat.advisors` is a model advisor: `id`, `label`, `baseUrl`, `model`, and `send` as for a provider, plus `abilities`, which names what it offers. Leave `abilities` out to offer everything; otherwise each ability is `true`, `false`, or an object with its own `send` rules over the advisor's. Several advisors can offer one ability: `snagboat.advisor.defaults` picks the one used, and the others are a click away (**Ask another advisor** in the Suggestions tab, **Ask Another Advisor** on the review notification, and **Snagboat: Explain Session with Advisor...**). Every answer names the advisor and its model. A hosted advisor's first request shows the exact payload and asks; changing its address or any ability's `send` rules asks again.

**Prompts.** Each advisor can have its own persona and strategy, for every ability it offers: `persona` (text in the setting) or `personaFile` (a path; `~` allowed), or the file `~/.snagboat/advisors/<id>/persona.md` when it exists. Each ability can have its own instruction: `"prompt": "<path>"` in the ability's object, or `~/.snagboat/advisors/<id>/<ability>.md`. Snagboat always appends its own data-handling rules and the answer's shape after your text, so a persona can't change what is sent or how answers are read. **Snagboat: Write Default Advisor Prompts...** writes an advisor's defaults to its folder, each under a comment that is dropped when read, to edit from; an empty file means the default. Two local advisors on the same model with different personas, for example:

```jsonc
"snagboat.advisors": [
  {
    "id": "spend", "label": "Token spend", "baseUrl": "http://localhost:11434/v1", "model": "qwen3.5",
    "persona": "You are Snagboat's advisor, and you care about one thing: what each turn cost and whether a cheaper model or a shorter prompt would have done. Be blunt and specific; name turns and token counts."
  },
  {
    "id": "risk", "label": "Context risk", "baseUrl": "http://localhost:11434/v1", "model": "qwen3.5",
    "personaFile": "~/.snagboat/advisors/risk/persona.md",   // a gentler voice, watching context size and compactions
    "abilities": { "summarize-session": { "prompt": "~/prompts/explain-risk.md" }, "propose-heuristics": true }
  },
  {
    "id": "hosted", "label": "OpenAI", "baseUrl": "https://api.openai.com/v1", "model": "gpt-5",
    "abilities": {
      "summarize-week": true,                              // counts only, as hosted advisors get by default
      "summarize-session": { "send": { "prompts": true } }, // but prompts when explaining a session
      "propose-nudges": false                               // never asked for the live line
    }
  }
],
"snagboat.advisor.defaults": { "summarize-session": "spend", "summarize-week": "hosted" }
```

`npm run eval:advisor -- --advisor spend,risk` asks both over the same sessions, with their own prompts, and writes the answers side by side.

## Notifications

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.nudges.notify` | `"off"` | `warnings` notifies when a warning appears (and for early warnings); `all` for every finding. At most one per turn, never modal; muted heuristics never notify. See [Nudges](heuristics.md#nudges). |
| `snagboat.nudges.quiet` | `[]` | Heuristic or rule ids that never notify, while still showing in the status bar. |
| `snagboat.nudges.advisor` | `false` | When a nudge fires, also ask the `propose-nudges` advisor for one line on what to do, shown under the finding in the status bar tooltip as model output. It never prompts while you work: until you've picked a model and approved that advisor's payload through Explain, it doesn't ask. |

## Outside VS Code: `~/.snagboat/config.json` and `.snagboat.json`

With `snagboat.storage.perUserStore` on, the core service and the `snagboat` CLI read Snagboat's settings from files, so they apply without VS Code running. The keys are the settings above without `snagboat.` (`captureContent`, `retention.textDays`, `heuristics.stalled.minutes`). `snagboat config` shows the settings that apply to the current folder and where each comes from.

Layers, lowest first:

| Layer | Where | Who writes it |
| --- | --- | --- |
| Built-in defaults | the tables above | |
| Your defaults | `~/.snagboat/config.json`, `"defaults"` | VS Code copies your User settings here, or you edit it |
| One project's | `~/.snagboat/config.json`, `"projects"` keyed by folder; the nearest folder containing the project applies | VS Code copies each window's workspace and folder settings here, or you edit it |
| The project's own | `.snagboat.json` in the project, found from the project folder up to the repository root | Whoever commits it |

```json
{
  "version": 1,
  "defaults": { "captureContent": true, "heuristics.stalled.minutes": 20 },
  "projects": { "/Users/me/src/client-work": { "captureContent": false, "collect": false } }
}
```

VS Code copies only settings someone set, and only Snagboat's own; `storage.*` and the advisor's settings stay in VS Code. A key it doesn't have, such as `collect`, is left as you wrote it.

Two keys exist only here, for the core service, which records every Claude Code project on the machine while it runs:

| Key | Default | Where | Purpose |
| --- | --- | --- | --- |
| `collect` | `true` | defaults, a project entry, or `.snagboat.json` | `false` stops Snagboat recording that project (its transcripts and hooks). |
| `collect.unopened` | `true` | `config.json` `"defaults"` only | `false` records only projects inside a workspace Snagboat knows: one with a folder in `~/.snagboat/data`, one in `"projects"` here, or one a VS Code window registered. |

**`.snagboat.json` is shared with everyone who clones the project**, so it can set only team settings: heuristic thresholds, token budgets, `rules`, `toolCategories`, discovery and nudges. Privacy settings it can only make more private: turn `captureContent`, `copilot.captureStructure` or `claudeCode.configureHooks` off, shorten retention, or set `"collect": false`. Anything else in it is ignored, and `snagboat config` says why.

```json
{ "settings": { "heuristics.toolChurn.minCalls": 12, "captureContent": false } }
```
