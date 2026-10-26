# Design: self-discovered heuristics and a trusted advisor

Status: accepted, not started. Planned after the current roadmap work; see [roadmap.md](../roadmap.md#planned-tasks).

## Summary

Snagboat's heuristics are hand-written and hand-tuned. This design adds two things on top of the event log:

1. **Self-discovered heuristics.** Snagboat looks for recurring trouble in your own history and proposes new heuristics as declarative rules. Each proposal is scored by replaying it over your past sessions before you decide whether to keep it.
2. **A trusted advisor.** A model you choose explains sessions and findings, proposes heuristics, nudges you during a session, and writes a periodic review. "Sovereign" means you control where it runs: a local model by default, or a hosted provider with your own key. Nothing leaves your machine without your say-so, and you can always see what was sent.

## Problems this addresses

- **Heuristics only catch what someone thought of.** The eight built-ins encode one person's guesses. Your sessions have their own failure patterns that no built-in names.
- **Thresholds are one-size-fits-all.** Defaults were calibrated on one history. "100 model calls" is a runaway for one person and a normal Tuesday for another.
- **Findings say what, not why.** A finding names a pattern ("12 calls hit the same two targets") but not what went wrong or what to try instead.
- **History goes unread.** The Sessions tab shows one session at a time. Nobody looks across weeks of sessions for what keeps going wrong.

## Goals

- Propose heuristics from your own history, and show how each would have fired in the past before you accept it.
- Let accepted heuristics run in the live engine exactly like built-ins: status bar, Sessions tab, past findings, acknowledge and mute.
- Explain a session or finding in plain language on request.
- Keep you in control of every byte that goes to a model, with local-only as the default.
- Work without any model at all for the parts that don't need one.

## Non-goals

- **No autonomous action.** The advisor suggests; it never changes your code, settings, agent configuration, or heuristics on its own.
- **No generated code.** Heuristics are declarative rules, evaluated by Snagboat. Generated TypeScript is out of scope (see [Decisions](#decisions)).
- **No prompt text.** Snagboat never stores prompts, and this design doesn't change that.
- **No shared or crowd-sourced heuristics** across users, for now.

## What the advisor can see

Everything comes from the existing event log. Per session: turns, model calls with token counts and context sizes, tool calls with categories, status and targets, compactions, subagents, turn ends, findings (past and active). Optional reply excerpts if `snagboat.captureContent` is on.

Sensitive fields:

| Field | Why it's sensitive | Default before sending to a model |
| --- | --- | --- |
| Tool targets: shell commands | Can contain secrets, hostnames, tokens | Replaced by category plus command name (`npm test` → `tests-builds: npm`) |
| Tool targets: file paths | Reveal project structure and names | Relative to the workspace, or hashed |
| Reply excerpts | Agent text about your code | Not sent unless you opt in per provider |
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

Discovery mines a recent window, the last 30 days by default (`snagboat.discovery.days`), so candidates follow your current habits rather than old ones.

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

### Capabilities

| Capability | Trigger | Output | Default provider |
| --- | --- | --- | --- |
| Explain | "Explain" on a session, turn, or finding | What happened, likely cause, what to try | Local |
| Propose heuristics | "Find patterns" in the Sessions tab, or the weekly review | Candidate rules, scored by replay | Local |
| Live nudges | A finding fires, or a turn crosses a rule threshold | One short suggestion in the status bar tooltip or a notification | Local |
| Periodic review | Weekly (opt-in), or on demand | A Markdown report: patterns, costs, which heuristics fired and helped, rules to add or retire | Your choice |

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

1. **Rule engine.** The rule format, `RuleHeuristic`, storage, and porting two or three built-ins to rules to prove the format. A manual "add rule" path (JSON in settings) for testing.
2. **Discovery without a model.** Feature extraction, personal baselines, outlier candidates, replay scoring, and a "Suggested heuristics" view with accept, tweak, and dismiss. Personal threshold suggestions for the built-ins. Useful on its own, with no model involved.
3. **Providers, model testing, and explain.** The provider interface, local and hosted providers, the digest builder with redaction, preview, and audit log. Then an evaluation harness (a dev script like `replay:heuristics`, e.g. `npm run eval:advisor`) that runs each capability over digests of your real sessions with several models, local and hosted: rules are scored automatically (valid, replay results, overlap), explanations side by side for you to judge. Its results pick the default models. Then "Explain" on sessions and findings.
4. **Advisor-proposed heuristics.** The advisor joins discovery; proposals go through the same scoring.
5. **Periodic review.**
6. **Live nudges.**

## Open questions

- **Which models to test first,** and how many digests make a fair comparison.

## Decisions

From the first discussion:

| Question | Decision |
| --- | --- |
| What "sovereign" means | Your choice of provider: local by default, hosted with your own key, with per-provider data controls and an audit log |
| What the advisor does | All four: explain sessions, propose heuristics, live nudges, periodic review |
| Form of generated heuristics | Declarative rules evaluated by Snagboat, not generated code |
| Choosing models | Test several, local and hosted, with an evaluation harness over real session digests before picking defaults |
| Where accepted rules live | Snagboat's global storage, with export to and import from a JSON file |
| How much history discovery mines | A recent window (30 days by default) |
| What rules filter on | Both Snagboat's tool categories and raw tool names |
| Where reviews go | Markdown files in a user-level folder outside any project (`~/.snagboat/reviews/` by default) |
| When live nudges fire | On findings, plus early warnings only where acting early saves something real (`runaway-turn`, `context-pressure` by default); a per-rule setting, off otherwise |
