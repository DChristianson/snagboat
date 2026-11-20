# Goal tracking lifecycle

The design for step 6 of the [architecture RFC](architecture-rfc.md) (experiments), settled on November 16, 2026. Nothing here is built yet. The work is tracked in Beads under `snagboat-79f.7`; [the build order](#build-order) lists each bead. The reviewed plan, with UI mockups, is [this page](https://claude.ai/artifact/N55Pkb81VkMkzSf8m2dw87).

You set a goal, which creates an advisor to manage it. The advisor prepares a brief, you discuss it, and once you accept it the brief becomes a tracked experiment. On a schedule, or whenever you ask, you review the tracking results with the advisor, then refine and improve.

The three diagrams are files in [`docs/images/`](../images/), for use in the user docs and in anything written for agents. Each has the same description in its `<desc>` as in the text under it here. Green boxes are new in this plan and blue boxes change. The last bead recolors them once everything is built.

## The loop

![Goal tracking lifecycle](../images/goal-tracking-lifecycle.svg)

1. **You set a goal.** This writes the advisor's `persona.md`. Changing the goal means a new advisor, outside the loop.
2. **Prepare brief.** The advisor writes its first report from your history.
3. **Review brief.** You accept, or you counter with a note and get a revised brief.
4. **Experiment.** The accepted change is running and measured.
5. **Report triggered,** by the advisor's schedule or by your request. The core snapshots the measures.
6. **Prepare report.** The advisor returns a verdict and proposals.
7. **Experiment review.** You decide. A counter with a note gets a revised report. Accepting a proposal, or keeping going, returns to step 4.

### The advisor contract

The advisor is given:

- its `persona.md`: goal, measures, and the kinds of changes it may propose
- the active rules and thresholds, each global or workspace specific
- this period's measures next to the last snapshot
- running experiments with their baselines
- the last round: what you accepted, discarded, revised or kept going with
- on Revise report, each revise note too

It returns:

- a short summary. A prediction with nothing to change goes here, not in a proposal
- a verdict for each running experiment
- at most three proposals: changes to the tracking rules, applied only after you discuss and accept them. Each is one change (a new threshold on an existing nudge rule, or a new rule) with the setting's before and after values, a scope, what the change does, the reason, and a prediction on a named measure
- on Revise report: every accepted proposal kept, each note answered with a revised proposal, and no discarded change suggested again

Accepting a proposal applies its change, and the experiment tracks its prediction.

### The review

When a report is ready you get a notification, and the advisor's card shows how many proposals are waiting. In the report you mark each proposal **Accept**, **Discard** or **Revise** (with a note), and you can switch a choice until you send. With any proposal marked Revise, the send button is **Revise report**: the advisor returns a new revision in which accepted proposals carry over, discarded ones are blocked from being suggested again, and each note is answered by a revised proposal. With none marked Revise, the button is **Accept report**.

Where the review happens is [still open](#open-questions): the advisor UI in the browser, or an agent session.

### Setting up an advisor

Step 1, **You set a goal**, can be a conversation (`snagboat-79f.7.15`, the core; `.16`, the advisor UI; `.17`, an agent session). It replaces the + form as the main way to add an advisor, and the form stays as the fallback.

1. You pick a model first: one of the local model advisors in your settings that offers the `set-up-advisor` ability. Nothing proceeds without one.
2. You describe what you care about. The model asks clarifying questions and settles a goal statement with you, then proposes an advisor: status line, goal id, measures, the rules it speaks for, notification limit, period and voice. The proposal is checked as the + form is checked; ids that aren't on Snagboat's lists are dropped, and a proposal that still fails is kept out with its reasons. The model is told them at once, with the measure and rule ids it may use and the names already taken, and asked once more; you see both answers. Rules go to the model with what each one reports, not only their ids. (Llama 3.1 8B, in the first try, invented a measure and reused a built-in's name.)
3. You accept it, revise it with a note (the conversation continues), or discard the draft. You can switch models on any turn to try another; each answer records the model that gave it, and the model that wrote the accepted proposal becomes the advisor's `model`.
4. Accepting writes `persona.md` as the form does (`checkNewAdvisor`, `writeNewAdvisor`) and keeps the conversation with the advisor as its setup conversation.

The model is sent only what you type in the conversation, its own earlier answers, and Snagboat's lists to choose from (measures, rules by id and title, periods, colors, icons, and the advisor names already taken), never anything from your sessions. So the setup call runs under its own ability, `set-up-advisor`, with its own sending rules and its own approval (`<advisor id>#set-up-advisor` in `advisor-approvals.json`), through `CoreAdvisors.ask` like every other core model call. Adding the ability left every existing approval as it was.

A separate experiments page lists every experiment in one table, filtered by project, advisor, experiment or status. Each row shows the change, its review date, and the tracked measure against its baseline, so you can check in between reports or revert early.

## Data

![Goal tracking data model](../images/goal-tracking-data.svg)

Everything is in the per-user store, written by the core. Each box is an entity, meaning a TypeScript type the code reads and writes.

| Entity | Where | In this plan |
| --- | --- | --- |
| Agent session log | `~/.claude/projects/`, `~/.copilot/session-state/`, hook payloads (outside Snagboat) | unchanged |
| Event | per workspace, `events/<day>.jsonl` | unchanged |
| Daily aggregate | per workspace, `aggregates/<day>.json` | unchanged |
| Finding response | per workspace, `finding-responses.jsonl`, `finding-state.json` | unchanged |
| Session, Finding, Discovery candidate | in memory, rebuilt from events | unchanged |
| Rule / threshold | per user, `rules.json`; `config.json` defaults and `projects[workspace]` | changes: scope, and the experiment that changed it |
| Dismissed candidate | per user, `suggestions.json` | unchanged (keeps only discovery dismissals) |
| Advisor | per user, `advisors/<id>/persona.md` | changes: `period`, `model` |
| Report | per user, `advisors/<id>/periods/<W>.json` | new: measures, rules, verdicts |
| Proposal | per user, `advisors/<id>/proposals.jsonl` | new: accepted, discarded, revised |
| Experiment | per user, `experiments/<id>.json` | new: before and after, baseline, status |
| Setup conversation | per user, `advisor-drafts/<draft id>/setup.jsonl` until accepted, then `advisors/<id>/setup.jsonl` | new: your turns and the model's, each with the model that answered, its proposals, and how it ended (accepted or discarded) |

How they connect: agent logs are collected into events, which roll up into daily aggregates. Sessions and findings are rebuilt from events, and findings come from rules run over events. You respond to a finding, which writes a finding response. Discovery mines candidates from event history; accepting one writes a rule, and dismissing one writes a dismissed candidate. Each advisor has a report per period, each report has up to three proposals, and an accepted proposal becomes an experiment, which changes a rule or threshold. An advisor set up by conversation keeps that setup conversation; accepting its proposal is what wrote the advisor's `persona.md`.

Only events have a formal, versioned schema today (`packages/schema`); Report, Proposal, Experiment and Setup conversation get one too. The event log keeps its current retention, 90 days raw then aggregates. Reports, proposals and experiments are small and kept forever, so a baseline outlives the raw events it came from.

### Lifecycle steps and entities

| Step | Advisor | Report | Proposal | Experiment | Rule / threshold | Event |
| --- | --- | --- | --- | --- | --- | --- |
| Configure (+ form or edit) | create / edit | | | | | |
| Set up by conversation (you and a model) | create, on accept (the setup conversation moves to its folder) | | | | read: rule ids | |
| Prepare brief (advisor, once) | read | create: the brief, from history | add: first proposals | | read | read: history |
| Report triggered (schedule or on demand) | read | create: measures and rules, frozen | read: last round | read: running ones | read | read: since last report |
| Report returned (model call) | | update: summary, verdicts | add: up to three | | | |
| Revise report (you, then model call) | | new revision: accepted kept, notes answered | update: accepted, discarded or revised with a note; revisions replace the original | | | |
| Accept report (you) | | | update: accepted | create: before and after, scope, baseline, review date | update: records the experiment that changed it | |
| Running (each period) | | next report records the experiment's effect | | read | | read |
| Keep going (you, at review) | | | update: kept | update: review moves one period | | |

## Components

![Goal tracking components](../images/goal-tracking-components.svg)

Top to bottom:

- **Front ends**, each of which finds or starts the core and talks to it over HTTP with a token per workspace: the VS Code window (`src/extension.ts`), the Claude Code plugin (`plugins/snagboat/`), the `snagboat` CLI (`src/cli/`) and the advisor UI (`media/ui/`, a page the core serves). All four change.
- **Core service** (`src/core/service/`), in layers:
  - **HTTP** (`server.ts`): ingest and feed; views and actions (changes); admin and UI; advisor routes (changes, with the new report and experiment routes).
  - **Modules**: findings; report (`src/advisor/report.ts`, changes); goals (`src/advisor/goals.ts`, changes); experiments (new: apply and revert); models (`advisorModels.ts`: local models, with approval).
  - **Timers**, each a `setInterval` in `server.ts`: heuristics (every 30 s), reports (new, `periodJob.ts`), ingest (every 30 s), retention (every 6 h), gitOutcomes (every 6 h).
  - **Collect**: the agent event collectors (`claudeCollector.ts`, `copilotCollector.ts`, `hooks.ts`) and the git outcomes collector (`gitOutcomesJob.ts`).
  - **Storage**, every module that writes to the store: events (`storeWriter.ts`), responses (`responses.ts`), rules (`ruleStore.ts` and `config.ts`, changes), advisors (`newAdvisor.ts`, and the new `proposals.ts`), experiments (new).
- **Schema package** (`packages/schema`, `@snagboat/schema`): the types every layer of the core and the front ends import. It changes: Report, Proposal and Experiment join the event types. As with events, each gets TypeScript types and a JSON Schema that a unit test checks against real records; nothing validates against the schema at run time.
- **Store**: `~/.snagboat`, as in the data model.
- **Agent sources**, read and never written: agent logs and the hook script (`~/.snagboat/bin/snagboat-hook`), which feed the collectors.
- **Advisor sources**: a local model (from `config.json` advisors) and, provisionally, a hosted remote model.
- **Code sources**, read only: git repos, for the git outcomes collector.

There is no job runner. `server.ts` starts each timer with `setInterval`, and the core exits after 30 idle minutes, so a timer fires only while a front end keeps the core alive. The reports timer therefore catches up on a missed report when the core starts, as gitOutcomes does. Calls inside the core are implied; only scheduled triggers and writes are drawn.

### HTTP routes

| Group | Routes | Called by |
| --- | --- | --- |
| Ingest and feed | `POST /events`, `POST /hook`, `GET /events/stream`, `POST /flush` | VS Code windows, the hook script |
| Views and actions | `GET /sessions`, `/sessions/:id`, `/sessions/:id/view`, `GET /today`, `GET /findings`, `POST /findings/respond`, `GET /workspaces`, `GET`/`POST /suggestions`, `POST /retention` | advisor UI, CLI, status line, windows |
| Admin and UI | `GET /health`, `POST /tokens`, `POST /ui-links`, `POST /ui-session`, `GET /ui/…`, `POST /shutdown` | front ends starting up, the browser |
| Advisor routes | `GET /advisors`, `GET /advisor-form`, `POST /advisors` | advisor UI |
| Advisor routes, setup | `GET`/`POST /advisor-setups` (drafts and models, or `?advisor=` for an advisor's setup conversation; start, with a model), `GET /advisor-setups/:id`, `POST /advisor-setups/:id/messages` (your turn; optional model switch), `POST /advisor-setups/:id/proposal` (accept, revise with a note, discard), `POST /advisor-setups/:id/approval` (the request waiting for approval) | advisor UI, MCP tool |
| Advisor routes, new | `GET`/`POST /advisors/:id/report` (read, or trigger now), `POST /advisors/:id/report/:rev` (accept or revise report), `POST /proposals/:id` (accept, discard, or revise with a note), `GET /experiments`, `POST /experiments/:id` (keep or revert) | advisor UI, CLI, MCP tool |

## What changes in the code

**Changes**

- **Persona settings.** The settings block at the top of `persona.md` adds `period` (weekly by default) and `model`, so a goal advisor names the model that reports for it. This replaces matching a model advisor to a persona by id. `may_change`, the list of the kinds of changes an advisor may propose (today always `[rules]`), is now enforced: a proposal outside it is rejected. (`src/advisor/goals.ts`)
- **Periods.** "Since last period" means since the stored snapshot, not a rolling now-minus-7-days window. (`src/advisor/report.ts`, `measures.ts`)
- **Propose heuristics becomes the performance report.** Its output gains scope, goal measure, expected effect and verdicts. It also gets the persona's goal and the experiments as input. (`src/advisor/proposeHeuristics.ts`, `prompts.ts`)
- **Applying a change knows its scope.** Apply writes a workspace change to `config.json` projects. Saved rules get a scope field and `provenance.experiment`. (`src/core/service/suggestions.ts`, `src/heuristics/ruleStore.ts`)
- **Brief and badges.** A brief whose surface is `suggest` becomes "2 proposals waiting". The findings view and status bar link to the inbox. (`src/advisor/brief.ts`, `src/ui/findingsView.ts`)
- **Advisor page.** The static "Proposed changes" panel becomes the real report and proposal inbox. (`media/ui/`)

**New**

- **Period job in the core.** Triggers each advisor's report on its schedule, or on demand from the UI or CLI. It runs next to the core's git-outcomes job and catches up a missed period at start. (`src/core/service/periodJob.ts`)
- **Proposal thread store.** An append-only event log per advisor: proposed, accepted, discarded, revised (with note), closed. Discarded changes are checked before a report is shown, so they are never suggested again. A revised proposal points to the one it replaces. (`src/core/proposals.ts`)
- **Experiment store.** One file per experiment holding the change, before and after values, scope, a baseline copied from the period snapshot, the review date and a status. (`src/core/experiments.ts`)
- **Endpoints.** The new advisor routes above.
- **Plugin and CLI.** An MCP tool `snagboat_proposals`, and `snagboat experiments` to list and revert experiments.

**Goes away**

- **Weekly review in the extension.** The hourly timer, `reviews/<week>.md`, and the "Ask the Advisor" toast. Performance reports replace them, and the core owns the schedule. (`src/extension.ts`, `src/review/review.ts`)
- **Most separate advisor abilities.** summarize-week, propose-nudges, propose-tactics and propose-heuristics become one performance report per advisor. Summarize-session (Explain) stays. (`src/advisor/`)
- **Ask the advisor on Suggestions.** "Ask the advisor", "Ask another advisor", Apply for advisor thresholds and the in-memory advisor proposals go. Discovery candidates stay. They are deterministic and become input to the brief. (`src/discovery/suggestionsController.ts`)
- **Dismissing advisor proposals.** A plain dismiss is replaced by Discard proposal, which is recorded so that the advisor does not suggest the change again. `suggestions.json` keeps only discovery dismissals.

## Build order

Two rules for the beads: each one is a code change, and each names the boxes it touches on the components and data diagrams. A change that touches something on neither diagram means the diagram is updated in the same pull request.

| Step | Bead | What | Components diagram | Data diagram | After |
| --- | --- | --- | --- | --- | --- |
| 1 | `snagboat-79f.7.1` | Persona settings: `period` and `model` | goals module, advisors storage | Advisor | |
| 1 | `snagboat-79f.7.2` | Period snapshots and the core period job, with no model yet. The deterministic brief already gives a summary, so this works on its own | reports timer, report module, advisor routes | Report | .1 |
| 2 | `snagboat-79f.7.3` | Types and a test-checked JSON Schema for Report, Proposal and Experiment in `packages/schema`, as events have | schema package | Report, Proposal, Experiment | .2 |
| 2 | `snagboat-79f.7.4` | The performance report prompt and the proposal thread store, with `may_change` enforced | report module, models module, advisors storage, advisor routes | Report, Proposal | .3 |
| 2 | `snagboat-79f.7.5` | Proposals read-only on the advisor page, and the brief's badges | Advisor UI, VS Code window | reads Report, Proposal | .4 |
| 3 | `snagboat-79f.7.7` | Accept, discard and revise in the core, with Accept report and Revise report: the routes, the thread log's status changes, and the revision call. No front end | advisor routes, report module, models module, advisors storage | Proposal, Report | .4 |
| 4 | `snagboat-79f.7.13` | The review on the advisor page: mark each proposal, then Accept report or Revise report | Advisor UI | changes Proposal, Report through the core | .5, .7 |
| 4 | `snagboat-79f.7.6` | The review in an agent session: MCP tools to read the report, mark proposals and send it. The MCP server's first tools that write | Claude Code plugin | changes Proposal, Report through the core | .7 |
| 5 | `snagboat-79f.7.8` | The experiment store, scope-aware apply and revert, and saved rules with scope | experiments module and storage, rules storage, advisor routes | Experiment, Rule / threshold | .7 |
| 5 | `snagboat-79f.7.9` | The experiments page in the advisor UI | Advisor UI | reads Experiment, Report | .8 |
| 5 | `snagboat-79f.7.10` | `snagboat experiments` in the CLI | snagboat CLI, Claude Code plugin | reads Experiment | .8 |
| 6 | `snagboat-79f.7.11` | Verdicts in the next report, keep going at the review, overlap warnings | report module, experiments module, advisor routes, Advisor UI | Report, Experiment, Proposal | .8 |
| 6 | `snagboat-79f.7.14` | The VS Code findings view and status bar show proposals waiting and open the advisor's page (split from `.5`: a window's token can't read reports, so it gets counts only) | VS Code window, advisor routes | reads Report, Proposal (counts) | .5 |
| 6 | `snagboat-79f.7.12` | Remove the weekly review and the old ask-the-advisor paths; recolor the diagrams and put them in the user docs | VS Code window, report module | Dismissed candidate, Discovery candidate | .11 |
| 7 | `snagboat-79f.7.15` | Setting up an advisor by conversation, in the core: pick a model first, talk the goal through, review the proposed advisor (accept, revise with a note, discard). The conversation is kept with the advisor as its setup conversation | advisor routes, goals module, models module, advisors storage, schema package | Advisor, Setup conversation (new: added to the diagram in the same change) | |
| 7 | `snagboat-79f.7.16` | The setup conversation in the advisor UI: a chat on the + page with a model picker, the form kept as a fallback | Advisor UI | Setup conversation, Advisor (through the core) | .15 |
| 8 | `snagboat-79f.7.17` | The setup conversation in an agent session, through MCP | Claude Code plugin | Setup conversation, Advisor (through the core) | .15 |

The reviewed plan had "investigate VS Code Agent Mode as the surface for the review, and decide between it and the advisor UI" as step 3, before accept, discard and revise. Here the order is the other way round. The review logic is built once in the core (`.7`), and each surface is a thin client of it: the advisor page (`.13`) and an agent session through MCP (`.6`). Neither blocks the other or anything after them, so the agent terminal can be explored with the real actions, not a read-only view, and the two surfaces can both stay. Whether Snagboat can appear in a VS Code Agents window at all is `snagboat-i52`.

The components diagram here has one box the reviewed plan did not: the schema package, added on November 16, 2026 so that `snagboat-79f.7.3` has a component to point at.

## Open questions

- Does the review flow live in the advisor UI in the browser, or in an agent terminal (VS Code Agent Mode)? Both get built, as clients of the same core routes (`snagboat-79f.7.13` and `.6`), and neither blocks the experiment store. What is left to decide, once both can be tried: whether to keep both, and whether an agent should be able to accept a rule change for you.
- An advisor with no model set up can still produce a report from the numbers alone: measures, trends and findings, with no written summary. Should that report also turn discovery's mined rule candidates into proposals, so the loop works without a model, or show the numbers only? Needed for `snagboat-79f.7.4`.
- Which outcome sources should reports have before this ships? Built today: tests going green, finding responses, approvals and notifications, and from git: milestones, commits kept or reverted, and code survival. Planned but not built: a Beads adapter for milestones (closed issues), and the phase 8 heartbeat that tells a stalled agent from a sleeping laptop.

## Decided

- The new advisor routes stay in `server.ts` as one dispatch line each; their logic lives in its own modules (`periodJob.ts` first). Decided November 17, 2026, building `snagboat-79f.7.2`.
- A report covers the time since the advisor's last report, so a report you ask for and the scheduled ones chain with no gap or overlap. Scheduled reports are named by their period (`2026-W46`), asked-for ones `2026-W47-asked-1`. Periods start at local midnight, Monday or the 1st. Reports cover every workspace, so only tokens that read every workspace (the admin token, the advisor UI's) can see them.

- Reports are weekly by default. Each advisor can set its own period, and you can always ask for a report.
- Experiments that affect the same measure in the same scope may run together. When one fires while another is running, the core flags the overlap as a problem, and the report says the two results may be confounded.
- Snagboat keeps its own store for proposals and experiments for now. Beads is the candidate base store later, so each proposal stays one record whose revisions link to what they replace. That shape maps onto beads.
- Setting up an advisor by conversation runs under a new ability, `set-up-advisor`, with its own sending rules and approval, not under an existing ability's: it sends only what you type in the conversation. Its approval is kept apart from the advisor's (`<advisor id>#set-up-advisor`), so adding the ability didn't ask again for advisors you had approved. Decided November 18, 2026, building `snagboat-79f.7.15`; to fold it into the advisor's one approval instead, remove it from `SEPARATELY_APPROVED` in `src/advisor/advisors.ts`.
- Report, Proposal and Experiment get formal schemas in `packages/schema`, as events have, so the advisor UI, CLI and MCP tool share one definition. That means what events have today: TypeScript types plus a JSON Schema checked by a unit test, with no run-time validation.
