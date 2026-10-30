# Implementation roadmap

## Dependencies

No runtime dependencies: the extension uses only Node.js and VS Code built-ins, so nothing third-party is bundled or shipped. File watching is Node's `fs.watch` plus a backup rescan (chokidar was used until it moved to requiring Node 22.22, and Snagboat used only a sliver of it).

| Purpose | Dev dependency | License |
| --- | --- | --- |
| Language | TypeScript 7 | Apache-2.0 |
| Bundling | esbuild | MIT |
| Integration tests | `@vscode/test-electron`, mocha | MIT |
| Packaging | `@vscode/vsce` | MIT |
| Types | `@types/vscode` (pinned to the minimum VS Code), `@types/node` (pinned to its Node major) | MIT |

The minimum supported VS Code is 1.119 (Node 22.22), which Copilot's telemetry export needs anyway. [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) is generated from what's actually bundled, and CI fails if anything bundled appears without being listed. One override in `package.json`: `@azure/msal-node` is forced to `^7.1.1` (fixing GHSA-xcx6-jx8p-x3h5) because `@vscode/vsce`'s `@azure/identity` still asks for `^6`; drop it once `@azure/identity` allows 7. Likely future additions: `ovsx` for publishing to Open VSX (publish-time only), and possibly a SQLite library if log export needs one.

## CI/CD

In place ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), on pushes to `main` and pull requests:

- on Ubuntu and macOS: `npm ci`, unit tests (`npm run test:unit`, which also type-checks via `tsc` and replays the redacted transcript fixture through every heuristic, pinning what fires), the production bundle, the third-party license check (`npm run licenses -- --check`), and `.vsix` packaging
- the integration suite (`npm test`) in a real VS Code: latest stable on Ubuntu (under a virtual display) and macOS, plus the minimum supported version (1.119) on Ubuntu
- Dependabot updates for npm and GitHub Actions
- `main`'s ruleset requires every unit and integration job to pass before a merge (the 1.119 job's name includes the version, so raising the minimum means updating the ruleset)

Releases ([.github/workflows/release.yml](../.github/workflows/release.yml)): pushing a `v*` tag that matches `package.json`'s version runs all of the above, then builds the `.vsix` and publishes a GitHub release with it attached.

Planned:

- publishing to the VS Code Marketplace and Open VSX from the release workflow (needs a token for each, stored as repository secrets)

## Session-level meta-characters

The design reserves longer-window rollups for three virtues and their failure modes:

- laziness
- impatience
- hubris

These rollups should evaluate sessions, days, or PRs instead of the short event windows used by the live heuristics engine.

## Planned tasks

- **Per-field retention — done for captured text.** Prompt text and reply excerpts are kept for `snagboat.retention.textDays` (default 30), then removed from their events in place, keeping one event store. Still open: whether shell-command `target`s and file paths need a shorter clock of their own; they live as long as their event (`rawDays`). See [PRIVACY.md](../PRIVACY.md#retention).
- **Per-window hook routing with discovery files and auth tokens — done.** Hooks previously all went to fixed port 45679, so the first VS Code window to bind it logged every project's hook events and the rest got none. Each window now listens on its own port and publishes per-folder route files with an auth token; a stable sh script routes each hook by `CLAUDE_PROJECT_DIR` (see [architecture.md](architecture.md#claude-code-adapter)). Existing projects' old `curl` hook entries are rewritten in place the next time a window opens them. Workspace folders added or removed while a window is open are routed (or unrouted) right away. Not handled: the script needs a POSIX shell, so Windows is unsupported (as before).

  Separately, zero Claude tokens in a window had a different cause, now fixed: a window opened before its project's first Claude session never noticed the transcripts folder appearing. The tailer now checks for a missing folder every 15 minutes.

- **Conversation-aware view — done (phases 1–3).** Prompts, turns, compactions, subagents, and context size per call; a context timeline and a turn tree; turn-based heuristics calibrated by replaying real transcripts. Also fixes subagent tokens not being counted. See [design/conversation-view.md](design/conversation-view.md).
- **Backfill sessions from transcripts — done.** **Snagboat: Backfill Sessions from Transcripts...** re-reads the session logs older days' events came from and rewrites those days, so history logged by older builds gets turns, turn ends, and tool calls. See [architecture.md](architecture.md#backfill).
- **Prompt text and session names — done.** Text capture is on by default (`snagboat.captureContent`): your prompts (up to 2,000 characters, your own words without injected IDE context), reply excerpts, and session names (Claude Code's `ai-title`, Copilot's `workspace.yaml` name), with common secret formats redacted, prompts and replies kept for `textDays`, and **Snagboat: Remove Captured Text**. Names show in the session list, breadcrumb, and Overview; prompt text when you select a turn and in tooltips. See [PRIVACY.md](../PRIVACY.md#captured-text). Open: the advisor's use of prompts, gated per provider (see the advisor design).
- **Copilot Agent reply excerpts — done.** Each `assistant.message` in a Copilot agent session's `events.jsonl` now yields a reply excerpt (on the turn end, or on its own tokenless `turn_stop` for a reply that also requests tools), so `verbal-hedge` sees Copilot replies. See [design/conversation-view.md](design/conversation-view.md#copilot).
- **Faster startup — done.** Activation (and the reload after a backfill or text removal) used to parse the raw log about four times over: all-time totals, daily history, the session index, and recent events, plus today's days again. It now reads each day once into a snapshot they all rehydrate from (`EventLog.snapshot`).
- **Model-fit heuristic (planned, not started; enabled by prompt text).** Flags expensive models doing simple work, such as a top-tier model running a one-line `git push` or `npm test`. Signals, per turn:
  - **the ask:** a short prompt that reads as an instruction to run something ("commit and push", "run the tests"), from `promptText`;
  - **the work:** few model calls, little output, and tool calls that are mostly shell, version control, or tests and builds (finer shell categories, once the advisor discovers them, would sharpen this);
  - **the model:** its tier, from a small table of model families (for example Opus above Sonnet above Haiku) that you can override, since Snagboat has no price data.

  It would report info-level, per session over a window ("9 simple turns on opus-5-5 today; a smaller model or a direct command would do"), with the tokens those turns cost. To calibrate by replay like the other heuristics, once enough history has prompt text. A candidate for the advisor's rule format later; prompt classification may need the advisor's model rather than keywords.
- **Self-discovered heuristics and a trusted advisor (phases 1 to 4 and 6 done, phase 5 mostly done).** Phase 1, the rule engine, is in: declarative rules and shell sub-categories, from settings or global storage (see [heuristics.md](heuristics.md#rules)). Phase 2, discovery without a model, is done: the Suggestions tab proposes rules, built-in thresholds, and shell sub-categories from the current workspace's history, scored by replay, to accept, tweak, or dismiss, plus Export and Import Rules (see [heuristics.md](heuristics.md#discovery)). Phase 3 is done: **Explain** on sessions, turns, and findings, using an OpenAI-compatible provider (local by default), with redacted digests, payload approval, and an audit log for hosted providers (see the README's Advisor section and [PRIVACY.md](../PRIVACY.md#the-advisor)), plus `npm run eval:advisor` to compare models on your own sessions. Phase 4 is done: **Ask the advisor** in the Suggestions tab names discovery's candidates, proposes a few rules, and groups shell commands, all validated and scored by replay. Phase 5 is in progress: **Snagboat: Write Review** writes a weekly Markdown review without a model, covering usage, findings and your responses to them (now recorded), rules to retire or add, and fixed checks over status bar snapshots rebuilt by replay. The advisor can add its judgment to a review, `npm run review:ui` runs the presentation review while building Snagboat, and `snagboat.advisor.weeklyReview` writes the review weekly. Still open in phase 5: rendered screenshots for vision models, and the optional local interaction counts. Phase 6 is done: opt-in notifications for findings (`snagboat.nudges.notify`), at most one per turn, early warnings for `runaway-turn`, `context-pressure`, and rules with `earlyWarning`, and an opt-in advisor line in the tooltip (see [heuristics.md](heuristics.md#nudges)). Snagboat proposes heuristics from your own history as declarative rules, scored by replay before you accept them, and an advisor running on a model you choose (local by default) explains sessions, proposes heuristics, nudges during a session, and writes a periodic review. Discovery also proposes sub-categories of "Shell command" from your history, replacing a fixed split. A presentation review has an agent look at the status bar, notifications, and detail view as they appeared when important findings were active, rebuilt by replay with no telemetry. It recommends settings and UI changes that make those findings easier to find. See [design/trusted-advisor.md](design/trusted-advisor.md).
- **More nuance for `stalled` (noted 2026-10-28, not started).** A quiet, unfinished turn is read as the session stalling out, but often the agent is waiting on you: a permission prompt, a question, or a turn you walked away from. Those need telling apart from an agent that's actually stuck, so findings, Explain, and proposals stop blaming the agent for your attention. The signals to look at are the last event before the gap (a tool request waiting for approval, a reply ending in a question), whether VS Code had focus, and how the gap ended (your prompt or the agent resuming).
- **Nudge refinements (noted 2026-10-29, not started).** Gaps found in the live nudges after phase 6:
  - The nudger is skipped while `snagboat.nudges.notify` is off, so it never sees episodes already under way, and turning notifications on nudges them as if new.
  - Its state is in memory only, so after a window reload every finding still active is nudged again, and a turn can get a second nudge.
  - The advisor's tooltip line is pruned only while notifications are on, so a stale line can reappear under a later episode of the same heuristic.
  - Nothing limits concurrent advisor asks for nudges; with a slow local model, several turns in a row can queue requests (the load that wedged Ollama during testing).

  Likely fixes: always run the nudger and prune advice, treat the first update after activation or a log reload as already seen, and allow one nudge ask at a time. The "none while you're typing a prompt" rule is also unbuilt, since Snagboat can't see the agent's input box.
- **README rework (noted 2026-10-29, done 2026-10-30, except the optional GIF).** The README was made quicker to skim, with reference material moved out:
  - a **Highlights** section right after the screenshot:
    - one event log for both agents, Claude Code and Copilot, normalized into daily JSONL;
    - eight heuristics with thresholds tuned by replaying real sessions, a replay that also runs in the unit tests;
    - discovery of rules and thresholds from your own history, scored by replay before you accept them;
    - a privacy-first advisor: local by default, a redacted digest for hosted providers, payload approval, no tools for the model, and an audit log;
  - "How it fits together" (the mermaid diagram) moved up, right after Highlights;
  - the Settings table moved to `docs/settings.md`, and the Commands list and the Sessions tab paragraph moved to `docs/usage.md`, leaving a "Quick tour" of five or six lines in the README that links to both;
  - "Why" tightened: the motivation first (long stretches in agent sessions, wanting to see them top down), then the history of the name;
  - perhaps dropping the aside "(Yes, 'X, not Y' is the most AI sentence there is.)", which a skimming reader may take as flippant, though it does show some self-awareness (a judgment call);
  - optionally, a GIF of 10 to 20 seconds showing a finding firing and a click through to its session.
- **HypAware integration (noted 2026-10-30, not started).** Use HypAware in two roles:
  - **as a source of events:** HypAware configured as a queryable event source in place of Snagboat's built-in hooks, feeding the same normalized events, so heuristics, discovery, sessions, and the review work unchanged;
  - **as a trusted advisor:** asking HypAware for insights specific to a workspace, alongside or instead of the advisor's own providers, with its answers labeled as advice and held to the same egress controls (see [design/trusted-advisor.md](design/trusted-advisor.md)).

  Open: how HypAware is queried and authenticated, how its events map onto Snagboat's schema, what happens to the built-in hooks and adapters when it's the source (switched off, or used as a fallback), and what workspace data its insights need from Snagboat.
- **Consolidate how insights, reports, and reviews are presented (noted 2026-10-30, not started).** Each feature found its own place to show its output, and together they're scattered:
  - findings appear in the status bar and its tooltip, in notifications, and in the detail view (the Overview, and a session's findings in the Sessions tab);
  - Explain answers open as untitled Markdown documents beside the editor;
  - discovery's and the advisor's suggestions are in the Suggestions tab;
  - the weekly review is a Markdown file in `~/.snagboat/reviews/`, opened from a notification;
  - the advisor's nudge line is in the tooltip, and payload previews open as separate JSON documents.

  Reconsider them as one design: where each kind of insight belongs, how they link to each other (a finding to its Explain, a review to the sessions it cites), and whether reviews and Explain answers belong in the detail view rather than loose documents. The presentation review's checks and recommendations should cover whatever surfaces result.
- **Prototype session visualizations and ways to specify preferences (noted 2026-10-30, not started).** Two explorations, as prototypes before anything is built in:
  - **Visualizing sessions:** alternatives to today's context timeline and turn tree in the Sessions tab, for seeing a session, or many, top down: where time, tokens, and tool calls went, and where findings fired.
  - **Specifying preferences:** ways to say what you care about, beyond today's per-heuristic settings, mutes, and JSON rules. That covers what to see and be told about, and what counts as a problem for you.

  Prototypes could be throwaway pages over the redacted fixture or exported history, compared side by side before choosing. This overlaps with consolidating how insights are presented (above).
- **An improvements bot for dependencies (noted 2026-10-30, not started).** Dependabot already opens version bumps for npm and GitHub Actions. A bot would also track changes and upgrades that need a decision or code, not only a version bump:
  - workarounds waiting on upstream, such as the `@azure/msal-node` override (dropped once `@azure/identity` allows 7);
  - pinned versions that move with Snagboat's minimum VS Code (`@types/vscode`, `@types/node`, and the 1.119 CI job and ruleset);
  - release notes that change behavior or deprecate something Snagboat uses;
  - possibly the formats Snagboat reads, which are dependencies too: Claude Code's transcripts and hooks, and Copilot's session logs and telemetry.

  It would open issues or pull requests with what changed and what to do, on a schedule.
- **Terminal and git signals.** Complete the generic file-system adapter: terminal shell-integration exit codes as `test_run` events, and `git status`/`git diff` polling to tell real edits from no-op saves (rows already in [schema.md](schema.md)).
- **Cross-workspace token budget.** A global budget across all workspaces, plus a treemap of where tokens go. Needs storage shared between workspaces; today each workspace's storage is isolated. The advisor's all-projects review needs the same storage (see [design/trusted-advisor.md](design/trusted-advisor.md)).
- **Extension points.** `snagboat.adapters` and `snagboat.heuristics` contribution points so other extensions can add sources and heuristics without forking.
- **Log export.** A `snagboat.exportLog` command writing CSV or SQLite, with an optional SQLite side index rebuilt from the JSONL log.
- **Housekeeping — done.** Checkpoint entries for transcripts and Copilot session logs that no longer exist are dropped at activation (only while their folder exists, so an unmounted drive's entries survive). **Snagboat: Remove Claude Code Hooks from Project...** removes Snagboat's entries from a folder's `.claude/settings.json` and turns off `snagboat.claudeCode.configureHooks` for it.
- **Copilot OTel per-window routing.** Copilot still exports every window's telemetry to one fixed port (4318), so the first window to bind it collects all of it. It can't use the hook routing above, since Copilot's exporter takes a single endpoint URL; revisit once live traffic shows whether spans identify the workspace.
- **Windows support.** The hook routing script needs a POSIX shell, so Claude Code hooks don't work on Windows; it needs a Windows equivalent of the script.

## Open questions

- When longer-horizon rollups arrive, should explanation-oriented turns and verification runs become explicit schema annotations or remain derived signals?
