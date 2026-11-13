# Using Snagboat

Where Snagboat shows what it sees, and every command. Settings are in [settings.md](settings.md); what each heuristic looks for is in [heuristics.md](heuristics.md). Asking a model is in [advisor-models.md](advisor-models.md), and the `snagboat` command in [cli.md](cli.md).

## Status bar

One item: today's tokens, agent events, and local edits (resetting at local midnight), plus the most important active finding as a glyph. Hover for a breakdown by agent, all-time totals, active findings, the advisor's line under a finding when `snagboat.nudges.advisor` is on, and any health problems with Snagboat itself (shown as ⚠). Click it to open the detail view.

## Detail view

Open it from the status bar, or with **Snagboat: Open Detail View**. It has three tabs.

### Overview

- today's totals;
- active findings, each of which you can mark **useful** (it helped; also hides it like acknowledging), **acknowledge** (hidden from the status bar until that problem clears) or **mute** (hidden for this workspace until unmuted), or use to filter the timeline to the events behind it;
- a per-day token chart by agent over 7, 30, or 90 days, with a table view;
- a filterable timeline of the last 24 hours, where file targets open the file, prompts and reply excerpts can be expanded, and sessions show their names.

### Sessions

Lists each day's agent sessions by name. Opening one shows a **turn tree** above a **context timeline**, and a list of the session's findings.

The turn tree shows where the session's tokens went: by prompt, then main agent or subagent, then an approximate split by tool category. Click to zoom. Calls that can't be tied to a prompt, such as ones logged by older Snagboat versions, are grouped as **Unlinked** until a [backfill](#commands).

The context timeline shows how much context each model call sent, split into cache read, cache creation, and fresh input, with your prompts, compactions, findings, and each model's largest-seen and limit lines. Expand it for output tokens, subagent lanes, and drag-to-zoom.

Findings include earlier ones, found by replaying the session through the heuristics when you open it, as well as active ones. Select a prompt (in the tree or on the timeline) to read what you asked. **Explain session**, **Explain turn** on a selected prompt, and **Explain** on a finding ask the [advisor](advisor-models.md); **Tactics** asks it whether the models used fit each turn and whether a different way of prompting would have cost less. With `snagboat.advisor.headlines` on, each ended session gets a one-line headline from the advisor under its name in the list.

Findings ("Show in session"), session ids in the Overview timeline, and the daily chart's bars all link into a session, as does **Snagboat: Open Session...**.

### Factory Clock, in your browser

Snagboat used to have an Explore tab, a carousel of 32 experimental views. It was removed on 2026-11-12. The views live on as [Factory Clock](https://dchristianson.github.io/factory-clock/), a web page in [its own repository](https://github.com/DChristianson/factory-clock). It runs over example sessions, or over your own daily files (`events/YYYY-MM-DD.jsonl`; **Snagboat: Reveal Event Log Folder** opens the folder they're in), read in your browser and sent nowhere. The old address, `dchristianson.github.io/snagboat/`, redirects there. See [PRIVACY.md](../PRIVACY.md#factory-clock). Snagboat keeps its own copy of the two drawings its Sessions tab uses, the turn tree and the context timeline.

### Suggestions

Opened by **Snagboat: Discover Heuristics**. It reads this workspace's last 30 days (`snagboat.discovery.days`) and suggests heuristics from what's unusual for you:

- **candidate rules** at your own turns' tails, each with its threshold, how many of your turns reach it, your percentiles, a replay score, and up to five sessions where it would have fired;
- how the **built-ins' thresholds** compare with your history, with **Apply** to take the suggested value;
- **command families** that could split "Shell command" into sub-categories;
- **your rules**: saved rules and categories, where they came from, and the ones written in settings.

Accept, adjust a threshold (the replay updates as you type), or dismiss each one; nothing is added until you accept. **Ask the advisor** has a model name the candidates, propose rules of its own, and group your shell commands, all scored the same way. Details: [heuristics.md](heuristics.md#discovery).

## Notifications

Off by default. With `snagboat.nudges.notify` set to `warnings` or `all`, a finding notifies when it appears, with buttons to show it in its session, explain it, mark it useful, acknowledge it, or mute it. There's at most one per turn, never a modal dialog, and `runaway-turn` and `context-pressure` warn early, at 80% of their thresholds. Details: [heuristics.md](heuristics.md#nudges).

## Reviews

**Snagboat: Write Review** writes a Markdown review of this workspace's last 7 days to `~/.snagboat/reviews/` (`snagboat.advisor.reviewDirectory`), without a model. It covers:

- what the agents' work cost, by model, day, and tool category;
- which heuristics fired, and how you responded;
- rules to retire or add;
- how findings were shown in the status bar, with suggested changes to Snagboat.

It names heuristics, rules, models, and session ids, never prompts, paths, or commands. Afterwards, **Ask the Advisor** has a model add three sections to the file, labelled as model output: a summary of the week, how findings were shown with suggested changes, and tactics to try from the two costliest sessions. **Ask Another Advisor** appears when several advisors offer those. `snagboat.advisor.weeklyReview` (off by default) writes the review once a week by itself.

## The advisor UI (preview)

With the per-user store on, the core service serves a page in your browser: run `snagboat open` in a project, or **Snagboat: Open Advisor UI** in VS Code. Pick any workspace the core records at the top.

Each advisor has a card: its goal in plain words (its `persona.md`'s `status`), how many notifications it has used this hour, and a brief: a one-line summary of where its goal stands, what it's watching most closely, and what it has to surface. That's its live finding (marked notified, or held back when it's over its hourly limit), with **Useful**, **Acknowledge** and **Mute**; or a measure going the wrong way with no finding yet; or nothing new. Navigator's card also shows what's ahead. When the workspace uses Beads (marked **beads**): what's in progress, the next ready issue, what's blocked and on what, and how many closed this week (read with `bd --readonly`). Otherwise (marked **plan**), the todo list the agent keeps in its session (Claude Code's `TodoWrite`, or its task tools), from the workspace's most recent session that has one, a live one first: what's in progress, the next item and how many are done, or only the counts ("3 of 7 done, 1 in progress") when text capture was off. With neither, the line is left out. **Measures and detail** opens an advisor's own page: each measure for the last 7, 14 or 30 days against the period before, with a line for each day, the first one charted by week over 8 weeks, the rules it speaks for, and its voice. Findings from heuristics no advisor speaks for are listed below the cards.

Your responses are kept by the core, so the page works without VS Code: a finding you acknowledge in the browser is acknowledged in VS Code too, and the other way round, and muting a heuristic (here or in VS Code) lasts until you unmute it here or there. The core evaluates every workspace with recent activity, whether or not VS Code has it open. The **+** after the cards adds an advisor: name it, give it a status line and a goal id, pick its measures, the heuristics and rules it speaks for, how many notifications an hour it may give, and its color and icon, starting blank or from a copy of a built-in. It's written as `~/.snagboat/advisors/<id>/persona.md`, which you edit to change it later; the page never overwrites an advisor that exists.

**Sessions** lists the workspace's sessions, latest activity first, with what came of each: tests going green, milestones, commits kept or reverted, how much of their code survives, how you met their findings, and approvals. Opening one shows its turns as a tree and its context over time, drawn as VS Code's Sessions tab draws them, its outcomes, and its findings (the ones reporting now with **Useful**, **Acknowledge** and **Mute**, and past ones found by replaying the session through the workspace's own rules and thresholds). **Suggestions** is VS Code's Suggestions tab in the page: discovery over the workspace's history (it runs the first time you open it, and again with **Discover again**), candidate rules with their thresholds and where they would have fired, built-in thresholds against your history, shell sub-categories, and your saved rules. **Accept** saves a rule to your rules, shared by every workspace; **Apply** writes a threshold to your user settings (a VS Code window with the per-user store on takes it into its settings); dismissals are shared with VS Code. **Ask the advisor** has a model name the candidates and propose rules and thresholds, as in VS Code, but from the browser it asks only models on this machine (Ollama, or another local advisor in your user settings); hosted advisors stay in VS Code. Before an advisor's first request, the page shows exactly what will be sent and waits for **Send**; you aren't asked again until its address or sending rules change, here or in VS Code.

The page lives at `http://127.0.0.1:<port>/ui/` and only ever talks to the core. Each link opens it once, within 2 minutes: the link carries a one-time code, which the page swaps for a read-only key kept in that browser tab, and the code can't be used again. The key reads every workspace and changes nothing; it ends after 12 hours unused or when the core stops. Open the page again with a new link after that. In a remote VS Code window (dev container, SSH, Codespaces), **Snagboat: Open Advisor UI** opens it through VS Code's forwarded port.

## Advisors and their goals

An advisor is one measurement goal plus the rules, and the voice, that serve it. Four are built in:

| Advisor | Goal | Measures |
| --- | --- | --- |
| Purser | Token cost down | Tokens per milestone; tokens per commit kept; cache hit rate |
| Navigator | Clock time not wasted | Milestones per session; active minutes per milestone; minutes from a failing test to green; stalled minutes |
| Bosun | Unsafe tool use limited | Risky commands, in all and per session; approvals per session (Claude Code's permission prompts less auto mode's denials; approximate, since a prompt you deny yourself still counts) |
| Lookout | You not overly distracted | Notifications per active hour; findings dismissed; findings marked useful |

They need no model. `snagboat advisors` prints each one's measures for the last 7 days against the 7 before (`--days`, `--json`, `--all`, `--store vscode` for VS Code's stores), the weekly review has an **Advisors** section, and the core answers `GET /advisors`. The measures come from the event log and its outcomes (tests going green, how you met findings, and, with the per-user store on, commits kept, lines surviving and milestones), so a measure with nothing to go on yet says so.

Each advisor is a `persona.md` in `~/.snagboat/advisors/<id>/`: front matter for the goal (`status` is the goal in plain words, shown on its card), the text below it for the voice. The front matter is a small part of YAML: `key: value` lines, `[a, b]` and `- item` lists, one level of indented keys, `{ k: v }` maps and `#` comments. A file with front matter replaces the built-in advisor of that `id`, or adds one:

```markdown
---
id: purser
goal: token-cost-down
status: Keeping token cost down
measures: [tokens_per_milestone, tokens_per_accepted_change, cache_hit_rate]
reads: [events, findings, outcomes]
may_change: [rules]          # proposes rule changes; never edits code
notify:
  rules: [token-budget, cache-thrash]
  max_per_hour: 2
cue: { icon: coin, color: amber, mood: frugal }
---
You watch what this project spends on tokens ...
```

Measure ids: `tokens_per_milestone`, `tokens_per_accepted_change`, `cache_hit_rate`, `milestones_per_session`, `minutes_per_milestone`, `minutes_to_green`, `stall_minutes`, `risky_commands`, `risky_commands_per_session`, `approvals_per_session`, `notifications_per_hour`, `dismiss_rate`, `useful_share`. Bosun's risky commands are a built-in list of patterns (recursive force deletes, force pushes, hard resets, piping a download into a shell, `sudo`, `chmod 777`, dropping tables, publishing packages, writing to disks); `risky_commands: ['\bterraform\s+destroy\b']` in its front matter adds your own regular expressions (single quotes keep backslashes as written; in double quotes, write `\\` for one). They match the whole command line, so a pattern inside a longer command's text counts too: the measure is approximate. A model advisor (`snagboat.advisors`) with the same `id` uses the text below the front matter as its voice; the front matter is never sent. `notify` limits what you're told: of the heuristics and rules an advisor lists in `notify.rules`, at most `max_per_hour` notifications an hour (over a rolling hour, early warnings included); a finding over the limit doesn't notify, though it still shows in the status bar and detail view. Each notification shown is recorded (an outcome: which heuristic, and which advisor's limit it fell under), which is what Lookout counts.

## The per-user store and the core (preview)

By default each window collects its own workspace's sessions and keeps them in VS Code's storage for that workspace. With `snagboat.storage.perUserStore` on (in User settings, then reload), data lives in `~/.snagboat/data`, one folder per workspace, and VS Code starts Snagboat's core service in the background:

- The core records Claude Code and Copilot CLI sessions in **every project on this machine**, open in VS Code or not, and applies retention. `"collect": false` for a project, `"collect.unopened": false`, or `snagboat serve --no-collect` limits it ([settings](settings.md#outside-vs-code-snagboatconfigjson-and-snagboatjson)).
- Each window shows its own workspace, from the core, and sends it what only the window sees: your edits, and Copilot's OpenTelemetry export. Two windows on one workspace show the same data.
- Backfill, **Relabel Shell Calls**, **Remove Captured Text** and **Clear Event Log** pause the core's writes to the workspace while they run.
- The core works out each workspace's findings, with that workspace's rules and thresholds, so every window on it shows the same ones; notifications and the advisor work as before. `snagboat findings` prints them from a terminal.
- If the core can't start, the window says so and writes its own folder in `~/.snagboat/data` instead. `snagboat core stop` stops it; open windows then wait until something starts it again.

Turning the setting off goes back to VS Code's storage as it was: turning it on copies data and never moves or deletes it. See [Command line](cli.md) for `snagboat core` and `snagboat migrate`, and [PRIVACY.md](../PRIVACY.md) for where everything is stored.

## The Claude Code plugin (preview)

The plugin in [plugins/snagboat](../plugins/snagboat/README.md) brings Snagboat into Claude Code without VS Code. Its hooks record your sessions as VS Code's per-project hooks do, and step aside in a project whose `.claude/settings.json` (or your user settings) already has VS Code's Snagboat hook. Its MCP server starts the core when a session starts and gives the agent four read-only tools for the workspace it works in: `snagboat_findings`, `snagboat_sessions`, `snagboat_session` and `snagboat_advisors`. Its slash commands use them: `/snagboat:findings`, `/snagboat:advisors [days]`, `/snagboat:sessions [days]`, `/snagboat:session <id>`, and `/snagboat:open` for the advisor UI. `/snagboat:statusline` adds Snagboat to Claude Code's status line (findings showing, today's tokens, cache rate and milestones) after showing you the change to `~/.claude/settings.json` and asking. A plugin can't set the status line itself.

It needs Node.js 24 or later on your PATH (or in `SNAGBOAT_NODE`): Claude Code doesn't ship Node. The hooks need only `sh` and `curl`. Each release attaches it as `snagboat-claude-plugin-<version>.zip`: start Claude Code with `claude --plugin-dir <that zip>`. From a clone: `npm run build:plugin`, then `claude --plugin-dir plugins/snagboat`.

## Copilot setup

Agent mode needs no setup: Snagboat reads its session logs, picking the sessions started inside each window's workspace.

To also count the tokens used by Copilot's inline and next-edit suggestions, turn on Copilot's OpenTelemetry export in your VS Code settings. OpenTelemetry is an open standard for telemetry, and OTLP is its protocol. Here Copilot sends it to a receiver Snagboat runs on your machine.

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4318"
}
```

The port must match `snagboat.copilot.otlpPort` (default `4318`). Only one VS Code window can listen on it. Copilot in every window exports to the same port, so the first window to claim it records all inline-suggestion usage, and the others show a "failed to listen on port" health warning. In current VS Code, Agent mode runs in VS Code's built-in agent host through the Copilot CLI, which doesn't send this telemetry, so it only covers editor features.

## Commands

| Command | What it does |
| --- | --- |
| **Snagboat: Open Detail View** | Opens the detail view (also the status bar's click action). |
| **Snagboat: Open Session...** | Picks a session by name and opens it in the Sessions tab. |
| **Snagboat: Show Token/Event Breakdown** | Prints the status bar's breakdown to an output channel. |
| **Snagboat: Discover Heuristics** | Opens the Suggestions tab (above). |
| **Snagboat: Export Rules...** / **Import Rules...** | Carry your saved rules and shell categories to a JSON file and back. Import replays each rule over this workspace's history and lets you pick what to add. |
| **Snagboat: Relabel Shell Calls** | Re-applies the shell sub-categories in use to this workspace's past shell calls, after counting them and asking. |
| **Snagboat: Explain Session...** | Asks the advisor about a session you pick. |
| **Snagboat: Explain Session with Advisor...** | The same, with an advisor you pick, when several can explain. |
| **Snagboat: Propose Tactics for Session...** | Asks the advisor whether model use or prompt tactics could be refined in a session you pick. |
| **Snagboat: Preview Advisor Digest...** | Shows a session's digest exactly as an advisor would get it for an ability. |
| **Snagboat: Set Advisor API Key...** | Stores a hosted advisor's key in VS Code's secret storage (leave it empty to remove). |
| **Snagboat: Write Default Advisor Prompts...** | Writes an advisor's default goal and voice (`persona.md`) and per-ability instructions to `~/.snagboat/advisors/<id>/` to edit from (see [settings.md](settings.md#installed-advisors)). |
| **Snagboat: Write Review** | Writes this workspace's weekly review (above). |
| **Snagboat: Backfill Sessions from Transcripts...** | Re-reads the transcripts behind days logged by older versions and rewrites those days, so their sessions get turns, turn ends, and tool calls, and their past findings are complete. It shows what will change and asks first. |
| **Snagboat: Open Advisor UI** | Opens the advisor UI in your browser (needs the per-user store on). |

**The findings panel.** Snagboat's icon in the activity bar opens a compact panel: the findings now, each with the advisor it falls under and whether that advisor's hourly limit is holding its notifications back, **Useful**, today's tokens, cache rate and milestones, and links to the advisor UI and the detail view. With the per-user store on, the detail view's Sessions tab moves to the advisor UI: its link, **Snagboat: Open Session**, and **Show in session** on a finding or notification open them in your browser. Suggestions stays in the detail view for now.
| **Snagboat: Reveal Event Log Folder** | Shows this workspace's event log folder (the daily `events/<date>.jsonl` files) in your file manager, to load them into the [Factory Clock page](#factory-clock-in-your-browser). Says so instead if nothing has been logged yet. |
| **Snagboat: Remove Captured Text** | Deletes stored prompts and reply excerpts, keeping the events, and can turn capture off. |
| **Snagboat: Remove Claude Code Hooks from Project...** | Removes Snagboat's entries from a folder's `.claude/settings.json`, leaving your own hooks alone, and stops adding them there. |
| **Snagboat: Clear Event Log** | Deletes this workspace's logged events after confirming. Adapter checkpoints are kept, so already-seen history isn't re-imported. |
