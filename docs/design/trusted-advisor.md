# Design: self-discovered heuristics and a trusted advisor

Status: accepted; phases 1 to 4 and 6 done (rule engine, discovery, providers and Explain, advisor-proposed heuristics, live nudges), and the periodic review is done. Phase 5 was replanned on 2026-10-30 as [installed advisors](#installed-advisors); what was left of the review's presentation work, and everything about UX optimization and telemetry, moved to a new [phase 7](#phases). See [heuristics.md](../heuristics.md#rules) and [roadmap.md](../roadmap.md#planned-tasks).

## Summary

Snagboat's heuristics are hand-written and hand-tuned. This design adds two things on top of the event log:

1. **Self-discovered heuristics.** Snagboat looks for recurring trouble in your own history and proposes new heuristics as declarative rules. Each proposal is scored by replaying it over your past sessions before you decide whether to keep it.
2. **A trusted advisor.** A model you choose explains sessions and findings, proposes heuristics, nudges you during a session, and writes a periodic review, including whether you noticed what it found and how to make that easier. "Sovereign" means you control where it runs: a local model by default, or a hosted provider with your own key. Nothing leaves your machine without your say-so, and you can always see what was sent.

## Problems this addresses

- **Heuristics only catch what someone thought of.** The eight built-ins encode one person's guesses. Your sessions have their own failure patterns that no built-in names.
- **Thresholds are one-size-fits-all.** Defaults were calibrated on one history. "100 model calls" is a runaway for one person and a normal Tuesday for another.
- **Findings say what, not why.** A finding names a pattern ("12 calls hit the same two targets") but not what went wrong or what to try instead.
- **History goes unread.** The Sessions tab shows one session at a time. Nobody looks across weeks of sessions for what keeps going wrong.
- **A finding nobody sees doesn't help.** Findings show up as a status bar icon, a tooltip line, or an entry in a session you may never open. Nothing checks whether the important ones get noticed.

## Goals

- Propose heuristics from your own history, and show how each would have fired in the past before you accept it.
- Let accepted heuristics run in the live engine exactly like built-ins: status bar, Sessions tab, past findings, acknowledge and mute.
- Explain a session or finding in plain language on request.
- Keep you in control of every byte that goes to a model, with local-only as the default.
- Work without any model at all for the parts that don't need one.

## Non-goals

- **No autonomous action.** The advisor suggests; it never changes your code, settings, agent configuration, or heuristics on its own.
- **No generated code.** Heuristics are declarative rules, evaluated by Snagboat. Generated TypeScript is out of scope (see [Decisions](#decisions)).
- **No prompt text sent without permission.** Snagboat stores prompts by default (with redaction and a short retention; see [PRIVACY.md](../../PRIVACY.md#captured-text)); this design only sends them to a provider you've allowed to receive them.
- **No shared or crowd-sourced heuristics** across users, for now.

## What the advisor can see

Everything comes from the existing event log. Per session: turns, model calls with token counts and context sizes, tool calls with categories, status and targets, compactions, subagents, turn ends, findings (past and active). Optional reply excerpts if `snagboat.captureContent` is on. Session names and prompt text (both captured by default, under `snagboat.captureContent`). Prompts are the best context there is for "what was this turn trying to do", and also the most sensitive.

Sensitive fields:

| Field | Why it's sensitive | Default before sending to a model |
| --- | --- | --- |
| Tool targets: shell commands | Can contain secrets, hostnames, tokens | Replaced by category plus command name (`npm test` → `tests-builds: npm`) |
| Tool targets: file paths | Reveal project structure and names | Relative to the workspace, or hashed |
| Reply excerpts | Agent text about your code | Not sent unless you opt in per provider |
| Prompt text | What you asked, in your words; can contain pasted code or secrets | Not sent unless you opt in per provider; off by default for hosted providers |
| Session names | Summarize what you worked on | Sent to local providers; opt-in for hosted ones |
| Session ids, timestamps | Low risk | Sent |

The **session digest** is the unit sent to a model: a compact, structured summary of a session or turn after these rules apply. It's the same digest whatever the provider, so you can read exactly what a model would see.

## Self-discovered heuristics

### Rule format

A rule is a small JSON document the engine evaluates. It covers what the built-ins do with counts, shares, sums, and gaps over a scope:

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

- **Scopes:** `turn` (current turn, clears on the next prompt), `session`, or `window` (rolling minutes).
- **Filters:** event kind, agent, tool category, raw tool name (exact or a `*` pattern, e.g. `mcp__github__*`), status, main agent or subagent. Categories keep a rule portable across agents; raw names catch what a category lumps together (Claude Code's `Bash` and Copilot's `bash` share a category but not a name).
- **Measures:** `count`, `distinctTargets`, `maxPerTarget`, `topShare` (share of the top N targets), `sumTokens`, `contextPercent`, `failureRate`, `idleMinutes`, `consecutive` (longest run of matching events).
- **Conditions:** thresholds on the measure, optionally combined (`all` / `any`).

A `RuleHeuristic` adapter turns each rule into a `Heuristic` for the existing engine, so rules get replay, past findings, the Sessions tab, acknowledge and mute for free. As a check on expressiveness, `runaway-turn`, `tool-churn`, and `backtracking` should each be expressible as rules. If one isn't, the format is missing something.

Accepted rules live in Snagboat's global storage (shared by every workspace on the machine), each with its provenance: who proposed it, when, and its replay score at acceptance. **Snagboat: Export Rules** writes them to a JSON file you can keep, commit, or carry to another machine, and **Snagboat: Import Rules** reads one back, replaying each imported rule over your history before it's added.

### Discovery without a model

The first discovery pass needs no model:

Discovery mines a recent window, the last 30 days by default (`snagboat.discovery.days`), so candidates follow your current habits rather than old ones. It reads only the current workspace's history (each workspace's log is separate), and each accepted rule records which workspace that was.

1. **Feature extraction.** For every turn and session in the window: call and tool counts, per-category counts, failure rates, max repeats per target, context peak, cache rebuilds, idle gaps, duration, tokens.
2. **Your own baseline.** Percentiles of each feature over your history, the same way the phase 3 defaults were calibrated by hand, but automatic and per user.
3. **Outliers.** Turns far outside your own normal on one or more features. Each outlier family becomes a candidate rule ("turns with 6 or more reads of one file: 1% of your turns").
4. **Personal thresholds.** For the built-ins, suggest thresholds from your own percentiles ("your 99th percentile is 140 model calls; runaway-turn is set to 100").

### Discovery with the advisor

The advisor sees outlier digests and the session context around them, and proposes rules with a title, a summary template, and a suggested action. Its proposals go through the same scoring as the statistical ones.

### Scoring a candidate

Every candidate, from either source, is replayed with `FindingReplay` over your stored history before you see it:

- how often it would have fired over the discovery window, in how many sessions, and when;
- overlap with existing heuristics (a candidate that only re-finds `stalled` is noise);
- examples: links to the sessions where it would have fired, opened in the Sessions tab with the candidate's past findings shown.

You accept, tweak the threshold (replay updates live), or dismiss. Dismissals are remembered so the same candidate doesn't come back.

### Discovered tool categories

"Shell command" is the catch-all for shell calls that aren't scripts, tests and builds, or version control, so it ends up holding most of them. Rather than a fixed split chosen by hand, discovery proposes **shell sub-categories** from your own history, accepted the same way as rules:

```json
{
  "id": "user:shell/package-install",
  "parent": "shell",
  "label": "Package installs",
  "match": ["npm install", "npm i", "pip install", "brew install", "cargo add"]
}
```

- **Matching:** on the first word or two of the command, like the built-in table. Accepted categories are checked before the built-in "Shell command" fallback; the built-in categories themselves don't change.
- **Refinement only:** every discovered category has `shell` as its parent, so a rule or heuristic filtering on `shell` still matches all of them, and a rule can target one sub-category. Nothing written against today's categories breaks.
- **Without a model:** the command names in your shell calls over the discovery window, by frequency. A command family taking a large share of them becomes a candidate on its own (`curl` 18% of shell calls).
- **With the advisor:** it groups command names into named categories (`curl` and `wget` as "Network"; `ls`, `cat`, and `find` as "File system"). It sees command names only, never arguments, the same as the digest's redaction for shell targets.
- **Scoring:** a replay shows the share of shell calls each candidate would take and what would be left in plain "Shell command", with example sessions.
- **Applying:** new tool calls get the accepted category as `toolCategory`. **Snagboat: Relabel Shell Calls** relabels history from the stored command lines, so it reaches calls logged through hooks too, not only days Backfill can re-read. Categories live in global storage with the rules, and export and import with them.

### Learning from use

Acknowledging and muting are feedback. A rule you keep muting is a candidate for retirement or a higher threshold; one you act on is working. The review (below) reports this.

## The trusted advisor

### Providers

One provider interface, with two kinds of implementation:

- **Local (default):** an OpenAI-compatible endpoint on localhost (Ollama, llama.cpp server, LM Studio). Nothing leaves the machine.
- **Hosted:** a provider you configure with your own API key, kept in VS Code's SecretStorage. Off until you add one.

Per provider you set what it may receive: digests only, or digests plus reply excerpts, plus whether paths are sent relative or hashed. Each capability can be pinned to a provider (for example, live nudges always local, periodic review hosted).

### Egress controls

- **Preview:** before the first request to a provider, and on demand afterwards, you see the exact payload.
- **Audit log:** every request to a hosted provider is recorded locally: when, which capability, size, and the payload's hash. Payloads themselves are kept only if you opt in, under the same retention as raw events.
- **No standing access:** the advisor gets digests Snagboat builds for one request. It has no tools and can't query the log, read files, or call out.

### Installed advisors

Today there is one advisor: a provider per capability (`snagboat.advisor.explainProvider` and the other three) and prompts fixed in Snagboat. Phase 5 makes advisors something you install several of, each with its own prompts and its own view of your data. An **advisor** is:

- a **kind**, which is how it's asked:
  - `model`: an OpenAI-compatible endpoint, local or hosted, as today;
  - `hypaware`: HypAware, asked for insights specific to a workspace;
  - `agent`: recommendations mined from what Claude Code and Copilot themselves produce (below);
- the **abilities** it offers, from the [list below](#abilities) (an ability is what this design has called a capability; the code keeps `Capability`);
- a **prompt per ability**, for model advisors, replacing Snagboat's default for that ability;
- a **data policy per ability**: what it may receive. Today's `send` rules (prompts, replies, session names, relative or hashed paths), set once per provider, become settable per ability too, so an advisor can see prompts when it explains a turn but not when it writes a review.

Settings: `snagboat.advisors` lists them, and each ability names the advisor it uses by default. The existing `snagboat.advisor.providers` entries read as model advisors with default prompts and today's `send` rules, so nothing already configured changes behavior. Several advisors can offer one ability: Explain uses the one chosen for it, and **Ask another advisor** offers the rest; a review can carry one section per advisor asked. Every answer is labeled with the advisor, its kind, and its model where there is one.

Local or hosted stays a property of the address, not the kind: a HypAware advisor at a loopback address is local, one anywhere else is hosted, and it is previewed, approved, and audited like any hosted model. The data policy applies before anything is built for it, whatever the kind.

**HypAware.** Two roles were noted in the roadmap. The advisor role is this phase: Snagboat asks HypAware about a workspace and shows what comes back as advice. What it's asked, how it's authenticated, and what workspace data it needs from Snagboat are open and settle in a spike first. The event-source role (HypAware feeding normalized events in place of the built-in hooks) is an adapter, not an advisor, and stays in the [roadmap](../roadmap.md#planned-tasks).

**Recommendations from the agents.** Claude Code and Copilot already give advice about how you work with them, and Snagboat sees some of it:

- **In replies.** An agent's replies often carry a recommendation to you ("add this to CLAUDE.md", "run the tests before asking me to push"). Reply excerpts are already captured (`textExcerpt`, 500 characters, when `snagboat.captureContent` is on). An `agent` advisor could collect them per session, and a model advisor allowed to see replies could pull out the ones addressed to you. Without a model this is weak: a keyword scan over 500-character excerpts.
- **In the agents' own reports.** Claude Code's `/insights` writes a usage report locally from its transcripts; Snagboat could read it when it's there and quote its recommendations as a labeled source, never run it. Whether Copilot keeps anything comparable, in its CLI session logs or elsewhere, is unknown.

Whether either is worth building is decided by a spike over real history before anything is designed in detail: how many recommendations there are, and whether they say anything the heuristics don't.

### Abilities

What an advisor can do for you, implemented and discussed, ranked by value to the person using Snagboat. The ranking is a judgment to argue with; it decides what phase 5 builds after the plumbing, top first. "Prompts" in the last column means the ability needs or is sharpened by prompt text (see [Prompt text as context](#prompt-text-as-context)).

| # | Ability | Area | Status | Needs |
| --- | --- | --- | --- | --- |
| 1 | **Explain** a session, turn, or finding: what happened, likely cause, what to try | Summary (text) | Done | Prompts sharpen it |
| 2 | **Nudge line** on a finding, in the tooltip, and **early warnings** for `runaway-turn` and `context-pressure` | Nudges | Done | The [nudge refinements](../roadmap.md#planned-tasks) |
| 3 | **Session headline**: one line per session in the session list and breadcrumb, what you were trying to do and how it went, cached once a session ends | Summary (text) | Discussed | Prompts; a small, fast local model |
| 4 | **Propose rules**, name and explain discovery's candidates, group shell commands | Heuristics | Done | |
| 5 | **Actionable rules**: judge proposals on whether they name a cause and a fix, not only whether they fire (an [open question](#open-questions)) | Heuristics | Discussed | A rubric in `eval:advisor` and a stronger propose prompt |
| 6 | **Weekly review** with the advisor's judgment added | Summary (text) | Done | Prompts, so it can say what the costliest sessions were for |
| 7 | **Annotated session map**: the advisor marks where a session went wrong on the context timeline and turn tree, as structured output Snagboat draws, not an image | Summary (graphic) | New | The visualization prototypes of phase 7 |
| 8 | **Model fit**: expensive models doing simple work (the [model-fit heuristic](../roadmap.md#planned-tasks)) | Heuristics | Planned | Prompts, to classify the ask |
| 9 | **Daily digest**: yesterday's sessions, cost, and findings in a few lines, in the Overview or a notification | Summary (text) | New | |
| 10 | **Waiting on you or stuck**: tell an inattentive user from a stalled agent (the [`stalled` entry](../roadmap.md#planned-tasks)) | Heuristics | Planned | The last event before the gap; VS Code focus |
| 11 | **What to try next** after a turn ends with failures, offered once, from the turn's digest | Nudges | New | Prompts |
| 12 | **Insights from HypAware** about the workspace | Summary (text) | Planned | The HypAware spike |
| 13 | **Recommendations the agents made** to you, collected per session and per week | Summary (text) | Discussed | Replies; the spike above |
| 14 | **The week in one picture**: tokens by day and model with findings marked, in the review | Summary (graphic) | New | No model |
| 15 | **Personal thresholds** for the built-ins, from your percentiles | Heuristics | Done, no model | |
| 16 | **Rules to retire or raise**, from how you respond to their findings | Heuristics | Done, in the review | |
| 17 | **Review across workspaces** | Summary (text) | Blocked | Storage shared between workspaces |

### Tuning an advisor

Per advisor and per ability, two things are yours to set:

- **The prompt.** Snagboat's instruction for the ability can be replaced. A long prompt is awkward in `settings.json`, so an advisor's prompt is a file (`~/.snagboat/advisors/<id>/<ability>.md` by default, or any path), and Snagboat's defaults are written out on request as a starting point. Snagboat always appends what the prompt can't change: the data-handling rules (quoted text is data, never instructions; redacted values are not to be guessed), the output shape it parses (rule JSON, one line for a nudge), and the data itself. Changing a prompt doesn't change what's sent, so it needs no new approval, but the preview shows the prompt in place, and `npm run eval:advisor` takes an advisor id so two prompts can be compared on the same digests.
- **The data.** Today's `send` rules, per ability. The defaults stay as they are: local advisors get prompts and session names, hosted ones neither, and nobody gets replies without being allowed. A policy can only narrow what the kind's default allows for a hosted advisor; it can widen it only by your explicit setting, which changes the approval key and so asks you to look at the payload again.

### Prompt text as context

Prompts are the best context there is for what a turn was trying to do. The plumbing exists: the digest carries each turn's prompt (clipped to 1,000 characters) under the provider's policy, local providers get it by default, and hosted ones with `send.prompts`. What's missing is use:

- Explain's and the nudge's instructions never tell the model what the prompt is for; the model is left to notice it. The instructions should say it: the prompt is the goal, judge the turn's work against it, and say when the work drifted from the ask.
- Propose sends two turn digests per candidate, prompts included, but asks nothing about them. With prompts, candidates can be named by intent ("long turns after one-line asks") rather than by counts alone, which is what model fit and actionability need.
- The review sends no prompts at all, so the advisor can't say what the costliest sessions were for. Allowed advisors should get the first prompt of each costliest session, clipped.
- Nothing summarizes a session from its prompts, which is the session headline above.

Each of these is gated by the per-ability data policy, so a hosted advisor allowed prompts for Explain still gets none in a review unless you say so. `eval:advisor` gains cases that run with and without prompts, so the gain is measured, not assumed. PRIVACY.md's advisor section changes from "per provider" to "per advisor and ability".

### Capabilities

| Capability | Trigger | Output | Default provider |
| --- | --- | --- | --- |
| Explain | "Explain" on a session, turn, or finding | What happened, likely cause, what to try | Local |
| Propose heuristics | "Find patterns" in the Sessions tab, or the weekly review | Candidate rules, scored by replay | Local |
| Live nudges | A finding fires, or a turn crosses a rule threshold | One short suggestion in the status bar tooltip or a notification | Local |
| Periodic review | Weekly (opt-in), or on demand | A Markdown report: patterns, costs, which heuristics fired and helped, rules to add or retire | Your choice |
| Presentation review | Part of the periodic review, or on demand | Where important findings went unnoticed, and UI changes to make them easier to find: settings you can apply, and design recommendations for Snagboat | Your choice |

### Presentation review

Finding something matters only if you see it. The presentation review checks how findings appear in the three places Snagboat shows them: the **status bar** (icon, text, and tooltip), **notifications**, and the **detail view** (the Overview, the Sessions tab, and a session's findings list). It recommends changes so the findings that matter most are the easiest to find. It needs no telemetry: an agent reviews the UI itself.

**An agent reviews the UI.** Replay takes your history to the moments that matter: when a warning was active, or when several findings were active at once. For each moment, Snagboat rebuilds what each surface showed, using the same code that draws it. `buildDetailState` and `buildSessionView` are already pure functions. The status bar's text and tooltip would be split out of `renderStatusBar` into one. A notification is its message and buttons. The agent gets those snapshots and judges, surface by surface, whether the important finding was easy to find: a warning listed after three infos in the tooltip, a finding shown only in a session's list, a status bar that looks the same for one info as for two warnings. A text snapshot works with any model. A rendered screenshot of the detail view, from a headless webview, lets a vision model judge layout too. Snapshots carry each finding's heuristic, severity, and position, never its summary (which can contain paths) or session names.

The same review runs as a dev script, like `replay:heuristics` and `eval:advisor` (for example, `npm run review:ui`), over the redacted fixture or your own history. That way design problems are found while building Snagboat, not only from inside a user's review.

**Local interaction counts, optional.** To check the review's guesses against what you actually do, Snagboat can count your interactions with its own UI: detail view tabs and sessions opened, status bar clicks, and what you do with notifications (open, dismiss, ignore). These are local telemetry only, off by default (`snagboat.advisor.uiSignals`). They're stored as daily counts on your machine, never as a click-by-click record, and they never leave it. Only a local provider can read them, and they're never added to a hosted provider's digest. Retention and **Clear Event Log** cover them. PRIVACY.md and the README promise no telemetry of the extension itself. When this is built, they should say that nothing is ever sent anywhere and that local interaction counts are kept only if you turn them on, and PRIVACY.md's storage table should list the file.

Response to findings is another signal, and it needs no interaction counts: how long findings stayed active before you acknowledged them, which ones you muted, and which expired unacknowledged. Acknowledgements are kept in memory today, so this needs them stored, with their times, alongside findings.

**What it recommends**, in two kinds, kept apart:

- **Settings you can apply,** each with a button: send a heuristic's warnings as notifications, show a finding count in the status bar text rather than only in the tooltip, mute a heuristic you always mute anyway. Each one shows, by replay, how your past findings would have appeared under it.
- **Design recommendations for Snagboat itself,** for changes no setting can make, each with the snapshot that shows the problem and a proposed change. For example: "with a warning and two infos active, the tooltip lists the infos first." These go in the review report, worded so they can be filed as GitHub issues. Nothing is filed or sent automatically.

**Without a model**, fixed checks still run over the snapshots ("a warning not first in the tooltip", "a warning shown only in the detail view"), and so do the response-to-findings measurements and the settings recommendations. The agent adds judgment about layout and wording, and the design recommendations.

### Where reviews go

A review covers your work, not one project, so it's written outside any project: by default to `~/.snagboat/reviews/` (next to the hook routes Snagboat already keeps in `~/.snagboat`), one Markdown file per review, named by date (`2026-W44.md`). `snagboat.advisor.reviewDirectory` changes the location. The files are yours: readable anywhere, easy to keep in a notes folder or repo, and never sent anywhere by Snagboat.

Covering every project needs each workspace's log, but today each workspace's storage is isolated. The review shares that dependency with the [cross-workspace token budget](../roadmap.md#planned-tasks): either a shared index of every workspace's events, or reading each workspace's log from VS Code's workspace storage. Until then, a review covers the workspaces open when it's written.

### Live nudges

Nudges fire when a finding appears. A rule can also warn early, before its threshold, where acting early saves something real: `runaway-turn` (tokens are being burned) and `context-pressure` (compaction is coming). Each rule has an optional early-warning point (`earlyWarning`, a share of its threshold, such as `0.8`), off by default and on for those two. A nudge says when it's early ("heading for a runaway: 80 of 100 calls").

Live nudges are rate-limited (at most one per turn, none while you're typing a prompt) and always dismissible. They never interrupt with modal dialogs.

### Trust boundaries

- **Untrusted inputs.** Tool targets and reply excerpts come from agent sessions and can contain text written to manipulate a model (prompt injection). Digests mark them as data, and the advisor's output is only ever displayed or offered as a suggestion, so a manipulated answer can't act.
- **Rules are data.** An advisor-proposed rule can only describe counts and thresholds over events. It can't run code, read files, or send anything.
- **Advice is labeled.** Everything the advisor writes is marked as model output, with the provider and model named.

## Phases

1. **Rule engine (done).** The rule format, `RuleHeuristic`, storage, and porting two or three built-ins to rules to prove the format. The tool-category format too, with `shell` matching its sub-categories. A manual "add rule" path (JSON in settings) for testing. As built: rules can name several measures (`measures`) for conditions over more than one, as `runaway-turn` and `backtracking` need; the three ports are checked against their built-ins in tests rather than replacing them. Export and Import Rules came with discovery's view, in phase 2.
2. **Discovery without a model (done).** Feature extraction, personal baselines, outlier candidates, replay scoring, and a "Suggested heuristics" view with accept, tweak, and dismiss. Personal threshold suggestions for the built-ins. Shell sub-category candidates from command frequencies. Useful on its own, with no model involved.
3. **Providers, model testing, and explain (done; see the first evaluation under Open questions).** The provider interface, local and hosted providers, the digest builder with redaction, preview, and audit log. Then an evaluation harness (a dev script like `replay:heuristics`, e.g. `npm run eval:advisor`) that runs each capability over digests of your real sessions with several models, local and hosted: rules are scored automatically (valid, replay results, overlap), explanations side by side for you to judge. Its results pick the default models. Then "Explain" on sessions and findings.
4. **Advisor-proposed heuristics (done).** The advisor joins discovery, proposing rules and grouping and naming shell sub-categories; proposals go through the same scoring.
5. **Installed advisors (replanned 2026-10-30, next).** The periodic review that was phase 5 is done: recorded responses, snapshots with fixed checks, **Snagboat: Write Review**, the advisor's part of it from text snapshots, `npm run review:ui`, and the opt-in weekly schedule. Its open presentation work moved to phase 7. This phase is [installed advisors](#installed-advisors), [tuning](#tuning-an-advisor), and [prompt text as context](#prompt-text-as-context), in this order:
   1. **The advisor model.** `snagboat.advisors`, with kind, abilities, a prompt file and data policy per ability, and a default advisor per ability; existing `providers` entries read as model advisors unchanged. Preview, approval, and audit per advisor. **Ask another advisor** where one ability has several.
   2. **Prompt text in every ability.** The instructions for Explain, nudges, and propose use the prompt as the goal; the review gets the costliest sessions' first prompts; all under the per-ability policy; `eval:advisor` cases with and without prompts.
   3. **Custom prompts.** Default prompts written out on request, replaced per advisor and ability, shown in the preview, compared in `eval:advisor`.
   4. **Spikes.** HypAware's API and authentication, and what a workspace insight needs from Snagboat; then the HypAware advisor. Recommendations from the agents over real history (replies, and Claude Code's `/insights` report if it's readable); then an `agent` advisor if the spike finds enough.
   5. **Abilities**, from the [ranked list](#abilities), top undone first: the session headline, then actionable rules, then the review's use of prompts, then the daily digest and what to try next.
6. **Live nudges (done).** Notifications for findings, opt-in with `snagboat.nudges.notify`, at most one per episode and per turn; early warnings through a `progress` hook on heuristics (`runaway-turn`, `context-pressure`, and rules with `earlyWarning`); and an opt-in advisor line in the tooltip that never prompts mid-work. Not done: holding nudges while you type a prompt, since the agent's input box isn't visible to Snagboat.
7. **Presentation, UX optimization, and telemetry (new, 2026-10-30).** Everything about whether Snagboat's output gets seen and how it should look, collected from the old phase 5 and the roadmap, to be taken up after phase 5 and after the agent's review has run on real history:
   - rendered screenshots of the detail view, from a headless webview, so a vision model can judge layout in the presentation review;
   - the optional local interaction counts (`snagboat.advisor.uiSignals`), and the PRIVACY.md and README changes they need; whether to build them at all is the open question below;
   - measuring the efficacy of what's shown: response-to-findings beyond what the review records (time to acknowledge by surface, findings that expired unseen), and the settings recommendations that follow from it;
   - [consolidating how insights, reports, and reviews are presented](../roadmap.md#planned-tasks) as one design, which decides where phase 5's new abilities (headlines, digests, annotated maps) appear;
   - the [prototypes of session visualizations and ways to specify preferences](../roadmap.md#planned-tasks), including the annotated session map and the week-in-one-picture from the abilities list;
   - the presentation review's checks extended to whatever surfaces result.

## Open questions

- **Which models to test first,** and how many digests make a fair comparison. First run (2026-10-28, `npm run eval:advisor`, 2 sessions, 12 cases, local Ollama):
  - llama3.1 (8B) answered in 15 to 30 seconds, but Ollama's default 2,048-token window cut every whole-session prompt (5,000 to 7,700 tokens), and those answers lost the required headings. Its turn and finding answers were well-formed but generic, and it misread a turn's length as idle time.
  - qwen3.5 was specific and grounded (named the files and failures, said when the digest couldn't tell), but took 105 to 180 seconds, mostly thinking. One whole-session request hit the old 180-second timeout.
  - Proposing heuristics (same day, `--capability propose`): asking for JSON mode broke both, since Ollama refuses it for qwen3.5 and llama3.1 looped until aborted, so the request asks for JSON in words and the parser finds it. llama3.1's 2,048-token window cut the 4,500-token request every time. qwen3.5 (about 2 minutes) named all four candidates well and grouped shell commands sensibly. Its first rules filtered `toolName` on shell commands (`sed`) and could never fire, so the prompt now explains `toolName` and lists the tool names seen, and rules that would never have fired on your history are dropped. Its second try gave two rules that fire (8 and 20 episodes in 3 sessions). It kept writing "{value}M tokens" for an already-formatted value, so a unit glued to a placeholder is now removed.
  - The review (same day, `npm run review:ui --models qwen3.5`): the first try failed at exactly 5 minutes, because Node's `fetch` gives up on headers that slow and Ollama sends none until it's done. Completions are now streamed. Streamed, qwen3.5 answered in 3.6 minutes and rightly recommended notifications for warnings. It also read `stalled` as agent hangs (see the `stalled` note in the roadmap) and asked for token counts that the snapshot had only left out, so the review prompt now explains elided counts and carries a short glossary of the built-in heuristics.
  - So far: no default model is set (you pick from your server's models on first use). Turn and finding explanations fit any local model; whole sessions need a larger context window. Explain now warns when a server reads far less than it was sent, and local requests may take up to 10 minutes. Still open: whether to compact the digest (pretty JSON costs about 30%), and whether to turn thinking off for reasoning models.
- **Actionability and value of rules (noted 2026-10-28, not started).** Proposals should be judged on whether they name a cause and an action the person can take, not only on whether they fire. "Check what the agent is doing, it may be a problem" is weak. Strong ones name the cause and the fix:
  - the agent is downloading software with known vulnerabilities, so set guardrails;
  - the prompts are too complex for the model's tier, so plan more before prompting;
  - the model's tier is too high for the prompt, so drop to a smaller model (see the model-fit heuristic in the roadmap).

  This needs an evaluation of actionability and value alongside replay scoring (episodes, overlap). That might mean a rubric applied in `npm run eval:advisor`, a stronger requirement in the propose prompt, or both. Discovery's own suggested actions are generic today and would be judged the same way.
- **Telling an inattentive user apart from a stalled agent** (noted 2026-10-28): see the `stalled` entry in the [roadmap](../roadmap.md#planned-tasks). It affects what Explain and proposals say about idle time.
- **Whether local interaction counts add enough** to be worth building, beyond the agent's review of snapshots and the response-to-findings signals. Decide in phase 7, after the agent's review has run on real history.
- **How HypAware is asked** (noted 2026-10-30): its API, authentication, what a workspace insight needs from Snagboat, and whether its answers fit the digest's egress controls as they are or need a policy of their own. A spike in phase 5 answers this.
- **Whether the agents' recommendations are minable** (noted 2026-10-30): how many a week of replies holds, whether Claude Code's `/insights` report is readable and stable enough to quote, and whether Copilot keeps anything comparable. A spike over real history, before the `agent` kind is designed further.
- **What a per-ability prompt may change** (noted 2026-10-30): the instruction only, or also the digest's shape (which fields, how many turns). The former keeps the data policy simple; the latter lets a small local model get a shorter digest. Start with the instruction only.

## Decisions

From the first discussion:

| Question | Decision |
| --- | --- |
| What "sovereign" means | Your choice of provider: local by default, hosted with your own key, with per-provider data controls and an audit log |
| What the advisor does | Explain sessions, propose heuristics, live nudges, periodic review (including a presentation review, added later) |
| Form of generated heuristics | Declarative rules evaluated by Snagboat, not generated code |
| Choosing models | Test several, local and hosted, with an evaluation harness over real session digests before picking defaults |
| Where accepted rules live | Snagboat's global storage, with export to and import from a JSON file |
| How much history discovery mines | A recent window (30 days by default) |
| Which workspaces discovery reads | The current workspace only, for now. Each accepted rule records the workspace it was discovered in. Revisit once there's storage shared across workspaces. |
| What rules filter on | Both Snagboat's tool categories and raw tool names |
| Reviewing how findings are presented | No telemetry needed: an agent reviews snapshots of the status bar, notifications, and detail view, rebuilt by replay at the moments findings were active. Optional local interaction counts are off by default and never leave the machine. Output: settings you apply with a click, and design recommendations for Snagboat written up for you to file. |
| Splitting "Shell command" | Discovered from your history as sub-categories of `shell`, proposed by discovery and the advisor and accepted like rules, rather than a fixed split |
| Which hosted providers first | OpenAI-compatible endpoints only: one client covers local servers and hosted ones (and Anthropic's compatibility endpoint) with a base URL and your key |
| What makes a provider local | Its address: loopback only. Anything else is hosted, must use https, and is audited, whatever it's called |
| Where reviews go | Markdown files in a user-level folder outside any project (`~/.snagboat/reviews/` by default) |
| When live nudges fire | On findings, plus early warnings only where acting early saves something real (`runaway-turn`, `context-pressure` by default); a per-rule setting, off otherwise |

From the replanning of 2026-10-30:

| Question | Decision |
| --- | --- |
| One advisor or several | Several, installed: each with a kind (`model`, `hypaware`, `agent`), the abilities it offers, and a prompt and data policy per ability. Existing providers read as model advisors unchanged. |
| What a prompt override may change | The instruction, from a file per advisor and ability. The data-handling rules, the parsed output shape, and the data itself are appended by Snagboat and can't be changed. |
| Where data access is set | Per advisor and per ability, with today's per-provider defaults; widening a hosted advisor's access changes its approval key |
| Prompt text for the advisor | Used by every ability where the policy allows, with the instructions saying what it's for; the gain measured in `eval:advisor` with and without it |
| HypAware's two roles | The advisor role is phase 5; the event-source role is an adapter and stays in the roadmap |
| Agents' recommendations | A spike over real history first; an `agent` advisor only if it finds enough |
| Where UX and telemetry work goes | Phase 7, after phase 5: screenshots for vision models, local interaction counts, efficacy measures, consolidating surfaces, and the visualization and preference prototypes |
| Retention of shell targets and file paths | One clock: they live as long as their event (`rawDays`). A separate, shorter clock was considered and dropped. |
