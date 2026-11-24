# Settings

Every setting Snagboat contributes, by area. All are in the `snagboat` section of VS Code's settings, which VS Code copies to `~/.snagboat/config.json` for the core service ([below](#outside-vs-code-snagboatconfigjson-and-snagboatjson)). Snagboat keeps its data in `~/.snagboat/data`, written by the core ([how](usage.md#the-per-user-store-and-the-core)); the heuristics' defaults come from replaying real sessions (see [heuristics.md](heuristics.md#calibration)), and **Snagboat: Discover Heuristics** compares them with your own history.

## Captured text and retention

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.captureContent` | `true` | Store your prompts (up to `capture.promptChars`), agent reply excerpts (up to `capture.replyChars`), tool calls' commands, search patterns, URLs and descriptions (`toolInput`), and session names, with common secret formats redacted first; and, in the store's records, commit message bodies and plan items' text (description, design, notes, acceptance). Never tool output or file contents. Prompts, replies, tool inputs, commit bodies and plan text are kept for `textDays`, names for as long as the session's events. **Snagboat: Remove Captured Text** deletes what's stored. Copilot editor features' replies also need `github.copilot.chat.otel.captureContent`. |
| `snagboat.capture.promptChars` | `2000` | The most of a prompt's text that's stored, in characters, up to 100,000 (set per folder). 98% of real prompts fit the default whole; a longer one is cut, with a note of how much was cut, and its event is marked `textTruncated`. Secrets are redacted from the whole prompt before it's cut. A new value applies to prompts captured from then on; text already stored stays as it was. |
| `snagboat.capture.replyChars` | `500` | The most of an agent reply's text that's stored, in characters, up to 100,000 (set per folder). A longer reply is cut, with an ellipsis, and marked `textTruncated`. Redacted before it's cut, and applied from then on, as for prompts. |
| `snagboat.retention.rawDays` | `90` | Days of raw events to keep, counting today. Older days are rolled up into daily totals and their raw events deleted. |
| `snagboat.retention.textDays` | `30` | Days captured prompts and reply excerpts are kept, counting today, capped at `rawDays`. Older events keep everything else, without the text. The default matches how long Claude Code keeps its own transcripts. |
| `snagboat.retention.aggregateDays` | `-1` | Days of daily totals to keep; `-1` keeps them forever, `0` keeps none (raw days past `rawDays` are then deleted without being rolled up). |

See [PRIVACY.md](../PRIVACY.md) for what each source records and where everything is stored.

## Sources

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.claudeCode.configureHooks` | `true` | Add Snagboat's `PostToolUse`, `PostToolUseFailure`, `Stop`, `PermissionRequest` and `PermissionDenied` hooks to each workspace folder's `.claude/settings.json` (set per folder). Off leaves the file alone: token usage still comes from transcripts, but tool calls, turn ends and permission prompts from hooks stop. **Snagboat: Remove Claude Code Hooks from Project...** removes existing entries and turns this off. |
| `snagboat.copilot.otlpPort` | `4318` | Local port for Copilot's OpenTelemetry export; point `github.copilot.chat.otel.otlpEndpoint` at `http://127.0.0.1:<port>`. Only one window can listen on it. |
| `snagboat.outcomes.git` | `true` | The core reads this project's git history, read-only, to record what became of commits made in a session (kept or reverted at 7 days, lines surviving at 7 and 30 days, milestones). It also records the repository's commits (authors, messages, files changed), branches and checkouts in the store's `git.jsonl`; never code, no network. A project's `.snagboat.json` may turn it off, not on. See [PRIVACY.md](../PRIVACY.md#what-is-captured). |
| `snagboat.copilot.captureStructure` | `false` | Development aid: record the structure of Copilot's telemetry (span names, links, timings, attribute names, and numbers such as token counts; every text value replaced by its length) to `~/.snagboat/data/copilot-structure/`, for mapping its spans. Summarize with `npm run summarize:copilot`. |

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

Accepted rules and categories live in `~/.snagboat/rules.json`, not in settings; **Snagboat: Export Rules...** and **Import Rules...** move them as a file.

## Advisor

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.advisors` | `[]` | Installed advisors (below): each a model with the abilities it offers and what it may receive for each. |
| `snagboat.advisor.providers` | one local provider: Ollama at `http://localhost:11434/v1` with `llama3.1:latest` and a 32,768-token context window | The short form of an advisor: a model offering every ability with one set of sending rules. OpenAI-compatible chat completion endpoints, each with an `id`, `label`, `baseUrl`, and `model` (empty: pick from the server's models on first use). `contextWindow` (tokens) asks for a context window: Ollama's OpenAI-compatible endpoint can't set one, so for Ollama (port 11434) Snagboat then asks through Ollama's own chat endpoint with that `num_ctx`; other servers ignore it. `snagboat.advisors` entries take it too. A loopback `baseUrl` makes it local; any other is hosted, must use https, needs an API key (**Snagboat: Set Advisor API Key...**), and is audited. `send` sets what it may receive: `prompts` and `sessionNames` (default: local yes, hosted no), `replies` (default: no), and `paths` (`relative` or `hashed`). See [the advisor](../PRIVACY.md#the-advisor). |
| `snagboat.advisor.defaults` | `{}` | The advisor each ability uses unless you pick another, by id: `summarize-session` (Explain), `set-up-advisor` (setting up an advisor by conversation on the advisor UI's **+** page; it has its own approval, separate from the advisor's other abilities). Unset abilities use `local`. The older `explainProvider` setting still works when this is unset. The third ability, `report-on-goal` (a goal advisor's performance report), has no default: each goal advisor names its model in its `persona.md`. |
| `snagboat.advisor.headlines` | `false` | Give each session a one-line headline from the `summarize-session` advisor (what you were trying to do and how it went), under its name in the session list and in the open session's summary line, as model output. Asked quietly, one session at a time, once a session has been idle past the `stalled` window, for the last 7 days' sessions; never while you work, and only after you've approved that advisor's payload through Explain. |
| `snagboat.advisor.auditPayloads` | `false` | Also keep the full payload of each request to a hosted provider in the audit log, for `rawDays`. Off, the log keeps when, which capability, the size, and a hash. |

The weekly review's settings (`advisor.weeklyReview`, `advisor.reviewDirectory`), `advisor.modelTiers`, `nudges.advisor`, and the `reviewProvider`, `proposeProvider` and `nudgeProvider` settings were removed with the weekly review and Ask the advisor; performance reports took their place ([usage](usage.md#performance-reports)). Snagboat ignores them if they're still set.

### Installed advisors

An entry in `snagboat.advisors` is a model advisor: `id`, `label`, `baseUrl`, `model`, and `send` as for a provider, plus `abilities`, which names what it offers. Leave `abilities` out to offer everything; otherwise each ability is `true`, `false`, or an object with its own `send` rules over the advisor's. The abilities are `summarize-session` (Explain), `report-on-goal` (a goal advisor's performance report) and `set-up-advisor`. `propose-heuristics`, the ability `report-on-goal` replaced, is still read as `report-on-goal`, with its `send` rules, when `report-on-goal` isn't named, so an advisor you approved for it stays approved; `summarize-week`, `propose-nudges` and `propose-tactics` are ignored. Several advisors can offer one ability: `snagboat.advisor.defaults` picks the one Explain uses, and **Snagboat: Explain Session with Advisor...** asks another; a goal advisor's `model` picks the one that writes its reports. Every answer names the advisor and its model. A hosted advisor's first request shows the exact payload and asks; changing its address or any ability's `send` rules asks again.

**Prompts.** Each advisor can have its own goal and voice (a `persona.md` can also carry front matter making it one of the goal advisors; see [usage](usage.md#advisors-and-their-goals)), for every ability it offers: `persona` (text in the setting) or `personaFile` (a path; `~` allowed), or the file `~/.snagboat/advisors/<id>/persona.md` when it exists. Each ability can have its own instruction: `"prompt": "<path>"` in the ability's object, or `~/.snagboat/advisors/<id>/<ability>.md`. The performance report is the exception for now: its instruction is fixed, and its voice is the goal advisor's own `persona.md`. Snagboat always appends its own data-handling rules and the answer's shape after your text, so an advisor's own text can't change what is sent or how answers are read. **Snagboat: Write Default Advisor Prompts...** writes an advisor's defaults to its folder, each under a comment that is dropped when read, to edit from; an empty file means the default. Two local advisors on the same model with different goals and voices, for example:

```jsonc
"snagboat.advisors": [
  {
    "id": "spend", "label": "Token spend", "baseUrl": "http://localhost:11434/v1", "model": "qwen3.5",
    "persona": "You are Snagboat's advisor, and you care about one thing: what each turn cost and whether a cheaper model or a shorter prompt would have done. Be blunt and specific; name turns and token counts."
  },
  {
    "id": "risk", "label": "Context risk", "baseUrl": "http://localhost:11434/v1", "model": "qwen3.5",
    "personaFile": "~/.snagboat/advisors/risk/persona.md",   // a gentler voice, watching context size and compactions
    "abilities": { "summarize-session": { "prompt": "~/prompts/explain-risk.md" }, "report-on-goal": true }
  },
  {
    "id": "hosted", "label": "OpenAI", "baseUrl": "https://api.openai.com/v1", "model": "gpt-5",
    "abilities": {
      "summarize-session": { "send": { "prompts": true } }, // prompts when explaining a session, which hosted advisors don't get by default
      "set-up-advisor": false                               // the advisor UI asks only local models anyway
    }
  }
],
"snagboat.advisor.defaults": { "summarize-session": "hosted", "set-up-advisor": "spend" }
```

`npm run eval:advisor -- --advisor spend,risk` asks both over the same sessions, with their own prompts, and writes the answers side by side.

## Notifications

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.nudges.notify` | `"off"` | `warnings` notifies when a warning appears (and for early warnings); `all` for every finding. At most one per turn, never modal; muted heuristics never notify. See [Nudges](heuristics.md#nudges). |
| `snagboat.nudges.quiet` | `[]` | Heuristic or rule ids that never notify, while still showing in the status bar. |

## Outside VS Code: `~/.snagboat/config.json` and `.snagboat.json`

The core service and the `snagboat` CLI read Snagboat's settings from files, so they apply without VS Code running. The keys are the settings above without `snagboat.` (`captureContent`, `retention.textDays`, `heuristics.stalled.minutes`). `snagboat config` shows the settings that apply to the current folder and where each comes from.

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

VS Code copies only settings someone set, and only Snagboat's own. `storage.*` stays in VS Code, and so do the advisor settings only VS Code uses (`advisor.headlines`, `advisor.auditPayloads`). Which advisors exist (`advisors`, `advisor.providers`) and which one each ability uses (`advisor.defaults`, and the older `advisor.explainProvider`) are copied, so the advisor UI can ask the local ones; the core reads those from your defaults only, never a project's or a `.snagboat.json`, and API keys are never settings. A key VS Code doesn't have, such as `collect`, is left as you wrote it. When something else changes a setting in `config.json` (the advisor UI applying a threshold, or you), VS Code takes it into its own settings.

These keys exist only here, for the core service, which records every Claude Code and Copilot CLI project on the machine while it runs:

| Key | Default | Where | Purpose |
| --- | --- | --- | --- |
| `collect` | `true` | defaults, a project entry, or `.snagboat.json` | `false` stops Snagboat recording that project (its Claude Code transcripts and hooks, and its Copilot CLI sessions). |
| `plans` | `docs` | a project entry, or `.snagboat.json` | Where the project's plans are, when it has no beads: a path, or a list of paths, relative to the project folder (folders or files, as git pathspecs). The plan job infers plan items from the markdown git tracks there at HEAD. A README, CONTRIBUTING or CHANGELOG is read only when named as a file. Ignored for a project with `.beads`: beads win. See [data-sources.md](data-sources.md). |
| `export.public` | `false` | defaults or a project entry; a `.snagboat.json` may only set it `false` | `true` says the project's repository is public, so [`snagboat export`](cli.md#export) keeps its commit SHAs (so the export joins its real history) and pseudonymizes people with this machine's key (`~/.snagboat/export.key`). Off, the default, every SHA is re-keyed with the repository's own key (`~/.snagboat/export-keys/<hash of its first commit>.key`). A clone's `.snagboat.json` can't turn it on: only you can say a repository is public. |
| `export.deny` | `[]` | defaults, a project entry, or `.snagboat.json` | Words and phrases `snagboat export` replaces with `[denied-N]` wherever they appear (a client's name, a codename), as whole words, ignoring case. A `.snagboat.json`'s list adds to yours; it can't remove one. |
| `collect.unopened` | `true` | `config.json` `"defaults"` only | `false` records only projects inside a workspace Snagboat knows: one with a folder in `~/.snagboat/data`, one in `"projects"` here, or one a VS Code window registered. |

### Dev containers: `containers.allow`

A top-level key of `~/.snagboat/config.json`, beside `defaults` and `projects`: the host folders whose dev container's Claude Code transcripts the core reads. A dev container keeps its own `~/.claude`, so its sessions never reach `~/.claude/projects` on your machine. Instead the container bind-mounts its `~/.claude/projects` to `<folder>/.snagboat/claude-projects/`, and the core reads that folder as it reads your own, only for folders listed here. Nothing Snagboat runs in the container. `snagboat containers allow [folder]` and `snagboat containers deny [folder]` edit the list ([command line](cli.md#dev-containers)); the core picks up a change on its next ingest tick (every 30 seconds), without a restart.

```json
{
  "version": 1,
  "defaults": {},
  "projects": {},
  "containers": { "allow": ["/Users/me/src/snagboat"] }
}
```

It's read only from your `config.json`: never from a project's `.snagboat.json` or VS Code's settings, which an agent in the container can write. VS Code doesn't copy it and leaves it as it is. Entries must be absolute folder paths; others are ignored, and `snagboat config` says so.

The container should mount the project at the same path as on your machine, so its transcripts' `cwd` is already a path here. A transcript whose `cwd` is the allowed folder or inside it is filed like any project on this machine, with that project's `collect` and `captureContent` settings. Any other `cwd` (such as `/workspaces/<name>` from sessions before the same-path mount) is filed under the allowed folder itself, so a container's sessions never land in a workspace outside it.

`claude-projects` is written by agents in the container, possibly with their permissions off, so the core treats it as untrusted: it refuses symlinks anywhere from the allowed folder down to each project folder, session and `subagents` folder, and transcript, opens each transcript without following links and only if it's a regular file, skips lines over 8 MB, and reads only Claude Code's transcript layout (a project's `memory/` and anything else is ignored). It logs counts and paths, never contents. Its read positions are kept apart from those for `~/.claude/projects`, so nothing is read twice.

**`.snagboat.json` is shared with everyone who clones the project**, so it can set only team settings: heuristic thresholds, token budgets, `rules`, `toolCategories`, discovery, nudges and `plans`. Privacy settings it can only make more private: turn `captureContent`, `copilot.captureStructure` or `claudeCode.configureHooks` off, shorten retention, lower `capture.promptChars` or `capture.replyChars`, set `"collect": false` or `"export.public": false`, or add words to `export.deny`. Anything else in it is ignored, and `snagboat config` says why.

```json
{ "settings": { "heuristics.toolChurn.minCalls": 12, "captureContent": false } }
```
