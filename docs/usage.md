# Using Snagboat

Where Snagboat shows what it sees, and every command. Settings are in [settings.md](settings.md); what each heuristic looks for is in [heuristics.md](heuristics.md).

## Status bar

One item: today's tokens, agent events, and local edits (resetting at local midnight), plus the most important active finding as a glyph. Hover for a breakdown by agent, all-time totals, active findings, the advisor's line under a finding when `snagboat.nudges.advisor` is on, and any health problems with Snagboat itself (shown as ⚠). Click it to open the detail view.

## Detail view

Open it from the status bar, or with **Snagboat: Open Detail View**. It has four tabs.

### Overview

- today's totals;
- active findings, each of which you can **acknowledge** (hidden from the status bar until that problem clears) or **mute** (hidden for this workspace until unmuted), or use to filter the timeline to the events behind it;
- a per-day token chart by agent over 7, 30, or 90 days, with a table view;
- a filterable timeline of the last 24 hours, where file targets open the file, prompts and reply excerpts can be expanded, and sessions show their names.

### Sessions

Lists each day's agent sessions by name. Opening one shows a **turn tree** above a **context timeline**, and a list of the session's findings.

The turn tree shows where the session's tokens went: by prompt, then main agent or subagent, then an approximate split by tool category. Click to zoom. Calls that can't be tied to a prompt, such as ones logged by older Snagboat versions, are grouped as **Unlinked** until a [backfill](#commands).

The context timeline shows how much context each model call sent, split into cache read, cache creation, and fresh input, with your prompts, compactions, findings, and each model's largest-seen and limit lines. Expand it for output tokens, subagent lanes, and drag-to-zoom.

Findings include earlier ones, found by replaying the session through the heuristics when you open it, as well as active ones. Select a prompt (in the tree or on the timeline) to read what you asked. **Explain session**, **Explain turn** on a selected prompt, and **Explain** on a finding ask the [advisor](../README.md#advisor-optional); **Tactics** asks it whether the models used fit each turn and whether a different way of prompting would have cost less. With `snagboat.advisor.headlines` on, each ended session gets a one-line headline from the advisor under its name in the list.

Findings ("Show in session"), session ids in the Overview timeline, and the daily chart's bars all link into a session, as does **Snagboat: Open Session...**.

### Explore (experimental)

A place to try views and compare them on real data; whatever earns its keep later moves into the Sessions tab. The picker lists every session, newest first; check up to 8, from any days (the session open in the Sessions tab is checked the first time), then press **Load**; **Unload** drops them. Loaded sessions are kept current from live events, as the open session is.

The visualizers sit in a carousel, one slide each. **Previous** and **Next**, the arrow keys when the strip has focus, and the row of dots move between them. The controls stay in view: the carousel takes the height left in the window, and a drawing taller than that scrolls inside its slide. Each slide has the visualizer's title and description above its drawing; a visualizer that works on one session at a time is drawn once per loaded session, stacked down the slide under the session's name. The twenty-six so far:

- **Turn tree**: the Sessions tab's tree; with several sessions loaded, each session's tree hangs under one root, so zooming compares sessions first and drills into one below.
- **Context timeline**: the Sessions tab's timeline, one per session.
- **Session strips**: one row per session over clock time, turns as blocks, compactions as ticks, findings as badges, so idle gaps show.
- **Cost per prompt**: one column per turn, sessions side by side on one y axis; two buttons above the chart stack the tokens by agent (main agent and subagents) or by tool category (the tree's approximate split, marked ≈).
- **Context fill**: context size per main-agent call by call index, one line per session, with the first call after each compaction marked and each model's largest-seen and limit lines, so sessions line up by progress rather than by clock.
- **Sequence diagram**: one per session, with you, the main agent, each subagent, and each tool category as lifelines and events in order under a band per turn; repeated tool calls fold into ×N arrows, failures are crossed, and delegations are dashed because they're inferred. Click a band to select the turn; a very long turn is cut short until you do.
- **Event graph**: one row per turn, left to right, with prompts, model calls, tool calls, and compactions as shapes and a lane for each subagent. Solid edges are the order the events recorded; dashed ones are inferred (what led to what, and possible retries after a failed tool call), because the events don't record causes.
- **Actor graph**: you, agents, subagents, models, and tool categories in columns, joined by typed edges (message, delegation, model call, tool call) as thick as they are frequent, with delegation dashed because it's inferred. With a turn selected, the actors in it stand out; click an actor to select the first turn it appears in.
- **Prompt terms**: the words in your prompts as a graph, sized by how many prompts use each and joined when they share a prompt, counted in the page with no model involved. Click a term to list its prompts, and click a prompt to select its turn; it needs prompt text, so it stays empty if text capture was off or the text has aged out.
- **Gantt and waterfall**: one per session, over clock time. Gantt has a row each for you, the main agent, each subagent, and each tool category; Waterfall has a row per turn, and selecting a turn opens it below on its own time axis. Calls are recorded as moments, so they're ticks, and nearby ticks fold together.
- **Treemap**: tokens as area, grouped by session, turn, and tool category, or by tool category across sessions. It uses the tree's approximate category split, marked ≈. Click a block to select its turn.
- **Heatmap**: patterns across the loaded sessions, in three grids: tokens by session and hour of day, tool calls by session and category, and findings by heuristic and day. Darker is more, on a square-root scale, with each step's range in the legend. Click a cell to select its session and busiest turn.
- **Tool-call ribbon**: one per session, showing which tool category followed which within turns, with ribbons as wide as the step was common. Each agent's calls in a turn are one sequence, so a subagent's don't read as following the main agent's. Click a ribbon to list the turns it came from; selecting a turn dims the ribbons outside it.
- **Week in one picture**: seven days as rings around a 24-hour clock, with tokens by hour as color and findings as dots, and a table of each day's numbers beside it. It counts only the loaded sessions, so load more to fill the week; **Earlier** and **Later** move between weeks when the sessions span several. Click a wedge to select that hour's busiest turn.
- **Histogram**: how a measurement is spread across the loaded sessions, such as tokens per model call or tool calls per turn, stacked by session. The last bar gathers anything past the 99th percentile.
- **Box and violin**: how a measurement varies between sessions, one row each with its density, quartiles, and outliers. Click a dot to select its turn.
- **Ridgeline**: the shape of a per-call measurement by session or by model, as overlapping curves on one axis. Each curve is scaled to its own peak, so it compares where values fall, not how many there were.
- **Scatter plot**: every turn as a point, its length against its tokens, model calls, or tool calls, on log axes. Turns with none of a measure can't be drawn on a log axis, and the note counts them. Click a point to select its turn.
- **Bubble chart**: each session by span and tokens, with area for tool calls and color for its worst finding. Span includes idle time. Click a bubble to select its session.
- **Sunburst**: the turn tree as rings, from sessions through prompts and agents to tool categories (the tree's approximate split, marked ≈). Outer arcs look bigger than inner ones of the same value, so the treemap is better for comparing sizes. Click an arc to select its turn.
- **Calendar heatmap**: the loaded sessions by local day, a column per week, showing tokens, model calls, or findings. It counts only what's loaded, up to 8 sessions. Click a day to select its busiest turn.
- **Radar**: a profile of each session over seven measures, each axis scaled to the largest among those loaded, so one session alone fills every axis it has any of. Hover a point for the numbers.
- **Parallel coordinates**: every turn as a line across six measures, each axis on its own scale. Click a line to select its turn, and the others dim.
- **Streamgraph**: one per session, showing how activity changed over clock time: tokens by agent or by model, or tool calls by category, as layers around a center line. Read thickness, not position. Click a layer to select the busiest turn at that time.
- **Sankey**: where tokens went, from sessions through the main agent or subagents to models. Widths are measured tokens, with no tool category split. Click a ribbon to list its costliest turns.
- **Adjacency matrix**: who acted on whom, as a grid with a count in each cell: messages, delegation (outlined dashed, because it's inferred), model calls, and tool calls. It stays readable with more actors than the actor graph. Click a cell to select the turn with the most of it.

Selecting a turn in one visualizer (a click on a prompt, block, column, or point) selects it in the others. The **puck**, a small circle in the bottom-right corner until you move it, names the current visualizer, gives its description, and shows its tags as chips in four facets: category (the question the view answers), purpose (informative or expressive), level (one session or a project's sessions), and dimension (what it highlights). Every value in the vocabulary is shown, with the current visualizer's outlined; hover a chip for what it means. Click a chip to narrow the carousel to visualizers with that tag: within a facet, picked values are ORed; across facets, ANDed. **Clear** removes the filters. The puck starts as a small circle with the current visualizer's title: click it to expand the puck to the rest of this, and **Collapse** shrinks it again when it covers a chart. Drag the puck by its title (or anywhere on the small circle) to move it to another corner, or focus **Collapse** or **Expand** and press an arrow key. The picked sessions, the current visualizer, the filters, the puck's state and corner, and the selection are remembered when the view reopens.

The same views run as a web demo at <https://dchristianson.github.io/snagboat/>: over example sessions, or over your own daily files (`events/YYYY-MM-DD.jsonl`; **Snagboat: Reveal Event Log Folder** opens the folder they're in), read in your browser and sent nowhere. See [PRIVACY.md](../PRIVACY.md#the-web-demo).

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

It names heuristics, rules, models, and session ids, never prompts, paths, or commands. Afterwards, **Ask the Advisor** has a model add three sections to the file, labelled as model output: a summary of the week, how findings were shown with suggested changes, and tactics to try from the two costliest sessions. **Ask Another Advisor** appears when several advisors offer those. `snagboat.advisor.weeklyReview` (off by default) writes the review once a week by itself.

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
| **Snagboat: Write Default Advisor Prompts...** | Writes an advisor's default persona and per-ability instructions to `~/.snagboat/advisors/<id>/` to edit from (see [settings.md](settings.md#installed-advisors)). |
| **Snagboat: Write Review** | Writes this workspace's weekly review (above). |
| **Snagboat: Backfill Sessions from Transcripts...** | Re-reads the transcripts behind days logged by older versions and rewrites those days, so their sessions get turns, turn ends, and tool calls, and their past findings are complete. It shows what will change and asks first. |
| **Snagboat: Reveal Event Log Folder** | Shows this workspace's event log folder (the daily `events/<date>.jsonl` files) in your file manager, to load them into the [web demo](#explore-experimental). Says so instead if nothing has been logged yet. |
| **Snagboat: Remove Captured Text** | Deletes stored prompts and reply excerpts, keeping the events, and can turn capture off. |
| **Snagboat: Remove Claude Code Hooks from Project...** | Removes Snagboat's entries from a folder's `.claude/settings.json`, leaving your own hooks alone, and stops adding them there. |
| **Snagboat: Clear Event Log** | Deletes this workspace's logged events after confirming. Adapter checkpoints are kept, so already-seen history isn't re-imported. |
