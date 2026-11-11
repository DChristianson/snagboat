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

The minimum supported VS Code is 1.145 (Node 24.22). The `snagboat` CLI needs Node 24 too. [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) is generated from what's actually bundled, and CI fails if anything bundled appears without being listed. One override in `package.json`: `@azure/msal-node` is forced to `^7.1.1` (fixing GHSA-xcx6-jx8p-x3h5) because `@vscode/vsce`'s `@azure/identity` still asks for `^6`; drop it once `@azure/identity` allows 7. Likely future additions: `ovsx` for publishing to Open VSX (publish-time only), and possibly a SQLite library if log export needs one.

## CI/CD

In place ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), on pushes to `main` and pull requests:

- on Ubuntu, macOS and Windows (where `sh` and `curl` are Git Bash's, as when Claude Code runs a hook): `npm ci`, unit tests (`npm run test:unit`, which also type-checks via `tsc` and replays the redacted transcript fixture through every heuristic, pinning what fires), the production bundle, the third-party license check (`npm run licenses -- --check`), and `.vsix` packaging
- the integration suite (`npm test`) in a real VS Code: latest stable on Ubuntu (under a virtual display) and macOS, plus the minimum supported version (1.145) on Ubuntu
- Dependabot updates for npm and GitHub Actions
- `main`'s ruleset requires every unit and integration job to pass before a merge (the 1.145 job's name includes the version, so raising the minimum means updating the ruleset)

Releases ([.github/workflows/release.yml](../.github/workflows/release.yml)): pushing a `v*` tag that matches `package.json`'s version runs all of the above, then builds the `.vsix` and publishes a GitHub release with it attached.

The web demo ([.github/workflows/pages.yml](../.github/workflows/pages.yml)): every push to `main` runs `npm run build:web` and deploys `out/web/` to GitHub Pages (see [architecture.md](architecture.md#web-demo)).

Planned:

- publishing to the VS Code Marketplace and Open VSX from the release workflow (needs a token for each, stored as repository secrets)

## Session-level meta-characters

The design reserves longer-window rollups for three virtues and their failure modes:

- laziness
- impatience
- hubris

These rollups should evaluate sessions, days, or PRs instead of the short event windows used by the live heuristics engine.

## Planned tasks

Finished work is in the [changelog](../CHANGELOG.md).

- **Architecture refactor (in progress).** Move the engine out of the VS Code extension into one local core that VS Code, the Claude Code CLI and a browser tab share. Steps 1 and 2 are done and step 3 is partly done, on the `refactor` branch. See the [architecture RFC](design/architecture-rfc.md) and [the next steps](design/handoff-3c.md).
- **Model-fit heuristic (planned, not started; enabled by prompt text).** Flags expensive models doing simple work, such as a top-tier model running a one-line `git push` or `npm test`. Signals, per turn:
  - **the ask:** a short prompt that reads as an instruction to run something ("commit and push", "run the tests"), from `promptText`;
  - **the work:** few model calls, little output, and tool calls that are mostly shell, version control, or tests and builds (finer shell categories, once the advisor discovers them, would sharpen this);
  - **the model:** its tier, from a small table of model families (for example Opus above Sonnet above Haiku) that you can override, since Snagboat has no price data.

  It would report info-level, per session over a window ("9 simple turns on opus-5-5 today; a smaller model or a direct command would do"), with the tokens those turns cost. To calibrate by replay like the other heuristics, once enough history has prompt text. A candidate for the advisor's rule format later; prompt classification may need the advisor's model rather than keywords.
- **Trusted advisor: phases 7 and 8.** Phases 1 to 6 and the periodic review are built: rules, discovery, Explain, Ask the advisor, installed advisors, notifications, and the weekly review. See [design/trusted-advisor.md](design/trusted-advisor.md). Two phases are left:

  **Phase 7: presentation, UX optimization, and telemetry.** Rendered screenshots for vision models, the optional local interaction counts, measures of whether findings get seen, consolidating how insights are presented, and the visualization and preference prototypes (the two entries below).

  **Phase 8: heartbeat and quiet gaps.** A heartbeat from the poll timer sorts each quiet gap into `stalled`, `asleep`, `unobserved`, or `unknown`, so `stalled`, replay, and effectiveness stop counting a sleeping laptop as a stuck agent or an ignored finding, and advisors get the state as a label instead of guessing from timestamps. See [phase 8](design/trusted-advisor.md#phases).
- **More nuance for `stalled` (noted 2026-10-28, not started; planned as [phase 8](design/trusted-advisor.md#phases)).** A quiet, unfinished turn is read as the session stalling out, but often the agent is waiting on you: a permission prompt, a question, or a turn you walked away from. Those need telling apart from an agent that's actually stuck, so findings, Explain, and proposals stop blaming the agent for your attention. The signals to look at are the last event before the gap (a tool request waiting for approval, a reply ending in a question), whether VS Code had focus, and how the gap ended (your prompt or the agent resuming).
- **Nudge refinements (noted 2026-10-29, not started).** Gaps found in the live nudges after phase 6:
  - The nudger is skipped while `snagboat.nudges.notify` is off, so it never sees episodes already under way, and turning notifications on nudges them as if new.
  - Its state is in memory only, so after a window reload every finding still active is nudged again, and a turn can get a second nudge.
  - The advisor's tooltip line is pruned only while notifications are on, so a stale line can reappear under a later episode of the same heuristic.
  - Nothing limits concurrent advisor asks for nudges; with a slow local model, several turns in a row can queue requests (the load that wedged Ollama during testing).

  Likely fixes: always run the nudger and prune advice, treat the first update after activation or a log reload as already seen, and allow one nudge ask at a time. The "none while you're typing a prompt" rule is also unbuilt, since Snagboat can't see the agent's input box.
- **A README GIF (optional, not started).** 10 to 20 seconds showing a finding firing and a click through to its session.
- **HypAware integration (noted 2026-10-30, not started).** Use HypAware in two roles:
  - **as a trusted advisor:** asking HypAware for insights specific to a workspace, alongside the other installed advisors, with its answers labeled as advice and held to the same egress controls (see [installed advisors](design/trusted-advisor.md#installed-advisors)). This starts with a spike on how it's queried and authenticated and what workspace data its insights need from Snagboat; the advisor is built only if the spike warrants it;
  - **as a source of events:** HypAware configured as a queryable event source in place of Snagboat's built-in hooks, feeding the same normalized events, so heuristics, discovery, sessions, and the review work unchanged. This is an adapter ([architecture.md](architecture.md#adapter-contract)), after the advisor role. Open: how its events map onto Snagboat's schema, and what happens to the built-in hooks and adapters when it's the source (switched off, or used as a fallback).
- **Recommendations from the agents (noted 2026-10-30, not started).** Claude Code and Copilot already give advice about how you work with them, in their replies and in reports such as Claude Code's `/insights`. This starts with a spike over real history: how many recommendations there are, and whether they say anything the heuristics don't. An `agent` advisor is built only if the spike finds enough (see [installed advisors](design/trusted-advisor.md#installed-advisors)).
- **Consolidate how insights, reports, and reviews are presented (noted 2026-10-30, not started).** Each feature found its own place to show its output, and together they're scattered:
  - findings appear in the status bar and its tooltip, in notifications, and in the detail view (the Overview, and a session's findings in the Sessions tab);
  - Explain answers open as untitled Markdown documents beside the editor;
  - discovery's and the advisor's suggestions are in the Suggestions tab;
  - the weekly review is a Markdown file in `~/.snagboat/reviews/`, opened from a notification;
  - the advisor's nudge line is in the tooltip, and payload previews open as separate JSON documents.

  Reconsider them as one design: where each kind of insight belongs, how they link to each other (a finding to its Explain, a review to the sessions it cites), and whether reviews and Explain answers belong in the detail view rather than loose documents. The presentation review's checks and recommendations should cover whatever surfaces result. This is part of phase 7 of the [advisor design](design/trusted-advisor.md#phases), which also decides where phase 5's new abilities (session headlines, daily digests, annotated session maps) appear.
- **Prototype session visualizations and ways to specify preferences (noted 2026-10-30; phase 7 of the [advisor design](design/trusted-advisor.md#phases)).** Two explorations, as prototypes before anything is built in:
  - **Visualizing sessions (the Explore tab and the web demo are built; see [design/visualization-explorer.md](design/visualization-explorer.md)).** What remains: the rest of the [visualization proposal](design/agent_conversation_visualization_design_proposal.docx), as a catalog to draw from rather than a plan; the web demo's example traces from real sessions, built but waiting for the owner's review before they're committed; and what the [hero views](design/visualization-explorer.md#hero-visualizations) leave for later: 3D, nested subagents and task or outcome filters (no data yet), semantic proximity and board summaries (need the advisor), and telling waiting from working (phase 8).
  - **Specifying preferences (not started):** ways to say what you care about, beyond today's per-heuristic settings, mutes, and JSON rules. That covers what to see and be told about, and what counts as a problem for you. Could still be throwaway pages over the redacted fixture or exported history, compared side by side before choosing.

  This overlaps with consolidating how insights are presented (above).
- **An improvements bot for dependencies (noted 2026-10-30, not started).** Dependabot already opens version bumps for npm and GitHub Actions. A bot would also track changes and upgrades that need a decision or code, not only a version bump:
  - workarounds waiting on upstream, such as the `@azure/msal-node` override (dropped once `@azure/identity` allows 7);
  - pinned versions that move with Snagboat's minimum VS Code (`@types/vscode`, `@types/node`, and the 1.145 CI job and ruleset);
  - release notes that change behavior or deprecate something Snagboat uses;
  - possibly the formats Snagboat reads, which are dependencies too: Claude Code's transcripts and hooks, and Copilot's session logs and telemetry.

  It would open issues or pull requests with what changed and what to do, on a schedule.
- **Terminal and git signals.** Complete the generic file-system adapter: terminal shell-integration exit codes as `test_run` events, and `git status`/`git diff` polling to tell real edits from no-op saves (rows already in [schema.md](schema.md)).
- **Cross-workspace token budget.** A global budget across all workspaces, plus a treemap of where tokens go. Needs storage shared between workspaces; today each workspace's storage is isolated. The advisor's all-projects review needs the same storage (see [design/trusted-advisor.md](design/trusted-advisor.md)).
- **Extension points.** `snagboat.adapters` and `snagboat.heuristics` contribution points so other extensions can add sources and heuristics without forking.
- **Log export.** A `snagboat.exportLog` command writing CSV or SQLite, with an optional SQLite side index rebuilt from the JSONL log.
- **Copilot OTel per-window routing.** Copilot still exports every window's telemetry to one fixed port (4318), so the first window to bind it collects all of it. It can't use the per-window routing Claude Code hooks use, since Copilot's exporter takes a single endpoint URL; revisit once live traffic shows whether spans identify the workspace.
- **Windows on a real machine.** Claude Code hooks run on Windows through Git Bash and pass the unit tests there in CI, but haven't been tried with Claude Code on a real Windows machine, and the VS Code integration tests don't run on Windows yet.

## Open questions

- When longer-horizon rollups arrive, should explanation-oriented turns and verification runs become explicit schema annotations or remain derived signals?
