# Using Snagboat

Where Snagboat shows what it sees, and every command. Settings are in [settings.md](settings.md); what each heuristic looks for is in [heuristics.md](heuristics.md).

## Status bar

One item: today's tokens, agent events, and local edits (resetting at local midnight), plus the most important active finding as a glyph. Hover for a breakdown by agent, all-time totals, active findings, the advisor's line under a finding when `snagboat.nudges.advisor` is on, and any health problems with Snagboat itself (shown as ⚠). Click it to open the detail view.

## Detail view

Open it from the status bar, or with **Snagboat: Open Detail View**. It has three tabs.

### Overview

- today's totals;
- active findings, each of which you can **acknowledge** (hidden from the status bar until that problem clears) or **mute** (hidden for this workspace until unmuted), or use to filter the timeline to the events behind it;
- a per-day token chart by agent over 7, 30, or 90 days, with a table view;
- a filterable timeline of the last 24 hours, where file targets open the file, prompts and reply excerpts can be expanded, and sessions show their names.

### Sessions

Lists each day's agent sessions by name. Opening one shows a **turn tree** above a **context timeline**, and a list of the session's findings.

The turn tree shows where the session's tokens went: by prompt, then main agent or subagent, then an approximate split by tool category. Click to zoom. Calls that can't be tied to a prompt, such as ones logged by older Snagboat versions, are grouped as **Unlinked** until a [backfill](#commands).

The context timeline shows how much context each model call sent, split into cache read, cache creation, and fresh input, with your prompts, compactions, findings, and each model's largest-seen and limit lines. Expand it for output tokens, subagent lanes, and drag-to-zoom.

Findings include earlier ones, found by replaying the session through the heuristics when you open it, as well as active ones. Select a prompt (in the tree or on the timeline) to read what you asked. **Explain session**, **Explain turn** on a selected prompt, and **Explain** on a finding ask the [advisor](../README.md#advisor-optional).

Findings ("Show in session"), session ids in the Overview timeline, and the daily chart's bars all link into a session, as does **Snagboat: Open Session...**.

### Suggestions

Opened by **Snagboat: Discover Heuristics**. It reads this workspace's last 30 days (`snagboat.discovery.days`) and suggests heuristics from what's unusual for you:

- **candidate rules** at your own turns' tails, each with its threshold, how many of your turns reach it, your percentiles, a replay score, and up to five sessions where it would have fired;
- how the **built-ins' thresholds** compare with your history, with **Apply** to take the suggested value;
- **command families** that could split "Shell command" into sub-categories;
- **your rules**: saved rules and categories, where they came from, and the ones written in settings.

Accept, adjust a threshold (the replay updates as you type), or dismiss each one; nothing is added until you accept. **Ask the advisor** has a model name the candidates, propose rules of its own, and group your shell commands, all scored the same way. Details: [heuristics.md](heuristics.md#discovery).

## Notifications

Off by default. With `snagboat.nudges.notify` set to `warnings` or `all`, a finding notifies when it appears, with buttons to show it in its session, explain it, acknowledge it, or mute it. There's at most one per turn, never a modal dialog, and `runaway-turn` and `context-pressure` warn early, at 80% of their thresholds. Details: [heuristics.md](heuristics.md#nudges).

## Reviews

**Snagboat: Write Review** writes a Markdown review of this workspace's last 7 days to `~/.snagboat/reviews/` (`snagboat.advisor.reviewDirectory`), without a model. It covers:

- what the agents' work cost, by model, day, and tool category;
- which heuristics fired, and how you responded;
- rules to retire or add;
- how findings were shown in the status bar, with suggested changes to Snagboat.

It names heuristics, rules, models, and session ids, never prompts, paths, or commands. Afterwards, **Ask the Advisor** has a model add its judgment and suggested changes to the file, labelled as model output. `snagboat.advisor.weeklyReview` (off by default) writes the review once a week by itself.

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
| **Snagboat: Preview Advisor Digest...** | Shows a session's digest exactly as a provider would get it. |
| **Snagboat: Set Advisor API Key...** | Stores a hosted provider's key in VS Code's secret storage (leave it empty to remove). |
| **Snagboat: Write Review** | Writes this workspace's weekly review (above). |
| **Snagboat: Backfill Sessions from Transcripts...** | Re-reads the transcripts behind days logged by older versions and rewrites those days, so their sessions get turns, turn ends, and tool calls, and their past findings are complete. It shows what will change and asks first. |
| **Snagboat: Remove Captured Text** | Deletes stored prompts and reply excerpts, keeping the events, and can turn capture off. |
| **Snagboat: Remove Claude Code Hooks from Project...** | Removes Snagboat's entries from a folder's `.claude/settings.json`, leaving your own hooks alone, and stops adding them there. |
| **Snagboat: Clear Event Log** | Deletes this workspace's logged events after confirming. Adapter checkpoints are kept, so already-seen history isn't re-imported. |
