# Handoff: RFC step 3c and setting up Beads

For a Claude Code session on Dave's machine, picking up `docs/design/architecture-rfc.md` where the cloud session stopped. Read the RFC first; this file only adds what that session learned and what to do next.

## Rules that apply to every commit

- **Identity.** Commit as `DChristianson <2652188+DChristianson@users.noreply.github.com>`. Never use any other email, in commits, trailers, PR text or files. Set it in this repo: `git config user.name DChristianson` and `git config user.email 2652188+DChristianson@users.noreply.github.com`. Before every push, check `git log --format='%an <%ae> | %cn <%ce>' origin/refactor..HEAD`.
- **Branches.** One step per branch, cut from `refactor`; one PR per step into `refactor`. `main` gets `refactor` only when Dave says so.
- **"No behavior change" means it.** Where a step claims it, existing tests and fixtures stay unchanged. If a test has to change, the step did more than claimed: say so in the PR.
- **Ask before anything irreversible.** Deleting or moving Dave's existing data, force-pushing a shared branch, or editing `~/.claude/settings.json` by hand.

## Where things stand (2026-11-10)

All merged into `refactor`:

| Step | What | PR |
| --- | --- | --- |
| RFC 1 | `@snagboat/schema` workspace package (`packages/schema`): `NormalizedEvent`, its JSON Schema, the session-view builder; npm workspaces | #81 |
| RFC 2 | Engine is vscode-free; settings and folders come through `src/core/host.ts`; VS Code glue lives in `src/vscode/` | #80 |
| RFC 3a | Claude Code hooks on Windows through Git Bash; Windows in unit CI (Windows later unsupported, decided 2026-11-12; its CI job no longer blocks) | #82 |
| RFC 3b | Read-only `snagboat` CLI (`src/cli`, `dist/snagboat.js`) | #84 |
| Factory Clock 2 | Visualization kit split out of `media/shared.js` into `media/vizkit.js` | #83 |

Things the cloud session decided or found, which the RFC text may not reflect yet:

- **The hook script stays POSIX `sh` + `curl`**, not Node (RFC said Node). Claude Code runs hooks through Git Bash on Windows, and Node isn't reliably on `PATH` where hooks run. Keep it that way in 3c.
- **Workspace isolation is a decision**: a VS Code window's token is scoped to its workspace and sees only that workspace's events, findings and mutes. Cross-workspace views are a separate, explicit scope. The CLI already behaves this way (`--all` is the explicit scope).
- **JSONL stays the source of truth**, SQLite a side index (decided: start with SQLite; DuckDB later for analysis; Dolt only through Beads).
- **Target** VS Code 1.145 and Node 24 (raise `engines` from 1.119 / Node 22 in its own small PR, with CI's minimum-version job).
- `npm run test:unit` runs `scripts/runUnit.js`: every `out/test/unit/*.unit.test.js`, each in its own process, reporting all failures. New test files are picked up by name.
- Windows is not supported (decided 2026-11-12): there is no Windows machine to test on. The Git Bash routing stays, untested.

## Before starting 3c

1. `git checkout refactor && git pull && npm install` (commit `package-lock.json` if npm changes it: the workspace entries were written by hand in #81).
2. `npm run test:unit && npm run build && npm test` must pass on `refactor` before any change.
3. **Back up the stores.** `node dist/snagboat.js stores` lists every store; copy each listed directory somewhere outside VS Code's folders, plus `~/.snagboat/`.
4. **Baseline.** `node dist/snagboat.js sessions --all --json > ~/snagboat-baseline.json`. The migration's correctness check compares against this, and it is the "before" for the Purser and Navigator measures.

## Step 3c: the core service, `core.json`, per-user storage, the extension as a client

Split into PRs in this order. Each must leave the extension working on its own.

### 3c-1. Per-user store and the copy-only migration (behind a setting, default off)

What lives where today (from `src/extension.ts`):

| Data | Today | After |
| --- | --- | --- |
| Event log `events/<day>.jsonl` | `context.storageUri` (per window's workspace), else `globalStorageUri` | `~/.snagboat/data/events/<day>.jsonl`, each event gaining a `workspace` field |
| Tail checkpoints `checkpoints/` | same `storageDir` | `~/.snagboat/data/checkpoints/`, keyed so two workspaces don't collide |
| Aggregates, response log | same `storageDir` | `~/.snagboat/data/`, per workspace |
| `rules.json`, context limits, advisor audit, Copilot structure | `globalStorageUri` | `~/.snagboat/` (rules), `~/.snagboat/data/` (the rest) |
| Mutes, headlines, responding-since | `workspaceState` | the core, keyed by workspace |
| Dismissed suggestions, advisor state | `globalState` | the core |
| Advisor API keys | VS Code `SecretStorage` | stay there until the CLI needs them; then the OS keychain (separate PR) |

- Adding `workspace` to `NormalizedEvent` is a schema change: bump the JSON Schema to v2 (keep v1 readable), update `jsonSchema.ts`'s check, `docs/schema.md`, and the CLI's store reader.
- **Migration copies, never moves or deletes.** For each store `snagboat stores` finds: copy its events into the per-user store, tagging `workspace` from `workspace.json`; dedupe on `eventId` (the log already dedupes on ingest); write a marker per source store so a rerun is a no-op. Leave the originals in place. Give it a dry run (`snagboat migrate --dry-run`) that prints counts per store.
- **Correctness check**: after migrating, `snagboat sessions --all --json` from the new store must list the same session ids, with the same prompt, tool-call and token counts, as the baseline. Make this a command (`snagboat migrate --verify <baseline.json>`) and a unit test with fixture stores.
- **Rollback**: turning the setting off sends the extension back to its old per-window storage, which the migration never touched. Write that in the PR.

### 3c-2. The core service and `core.json`

- `snagboat serve` runs the core in the foreground; the first front door that needs it starts it in the background. It listens on `127.0.0.1` only, on a free port, and writes `~/.snagboat/core.json` with `{ port, token, pid, version }`, mode 0600. A stale file (pid gone) is replaced on the next start. It exits after an idle period with no clients.
- **Tokens are per workspace** (the isolation decision): a client asks for a token for its workspace folder(s); requests with it see only that workspace's data. `--all` / cross-workspace reads use a separate token the CLI and advisor UI ask for explicitly.
- First endpoints, as in the RFC: `POST /events`, `GET /sessions`, `GET /sessions/:id`, `GET /findings`, `POST /findings/:id/response`, `GET /personas`, `GET /experiments`, `GET /ui`. Start with what the extension needs to stop owning its store; the rest can follow.
- **Hooks**: the routing script keeps working unchanged. Route files can point at the core instead of each window's receiver, with the core checking the project dir against the token's workspace (the receiver's `isWithinFolders` check moves into the core). Keep the `X-Snagboat-Project-Dir-Hex` path for Windows.
- If the core is down, hooks fail silently today (`curl -m 2 … || true`). Add the spool the RFC describes: the script appends to `~/.snagboat/data/spool/` when it can't connect, and the core ingests the spool on start. Keep the script POSIX and fast.

### 3c-3. The extension becomes a client (behind the same setting)

- The extension finds or starts the core, posts edit-tracker events, and reads sessions and findings over the API. Heuristics and nudges run in the core; the extension delivers notifications and the status bar.
- Several windows become clients of one core. Each window's token is scoped to its workspace, so a window still sees only its own data (check this with an integration test that opens two folders).
- When the setting has run on by default for a while without trouble, a later PR flips the default and, later still, removes the old path. Not in 3c.

### Checks for every 3c PR

- `npm run test:unit`, `npm run build`, `npm test` locally; CI green on all six jobs.
- For 3c-1 and 3c-3: run the extension (F5) against your real, backed-up data with the setting on; confirm the Sessions tab and status bar match the baseline; then turn it off and confirm the old view is untouched.

## Setting up Beads

Use Beads for this plan's work items now, while nothing depends on it.

- Read the current Beads docs for how `bd init` sits inside an existing git repo before running it in `snagboat`. Decide with Dave whether `.beads/` is committed, ignored, or kept outside the repo.
- Planning beads hold no session data, so syncing them through a remote is fine. **Experiment beads** (RFC 6), which point at session data, go in a separate Beads store with no remote.
- Create these, with blocking edges so `bd ready` shows the next step:

| Epic | Bead | Blocked by |
| --- | --- | --- |
| RFC | 3c-1 Per-user store and copy-only migration | none |
| RFC | 3c-2 Core service and core.json | 3c-1 |
| RFC | 3c-3 Extension as a client | 3c-2 |
| RFC | Engines: VS Code 1.145, Node 24 | none |
| RFC | 4 Outcomes and advisors (outcome capture, `persona.md` front matter, four default advisors) | 3c-3 |
| RFC | 5 Claude Code plugin and advisor UI (compact VS Code findings panel; full UI in a browser) | 3c-2 |
| RFC | 6 Experiments: design first. Keep it simple; the design isn't settled (decided 2026-11-12). Gas City dropped. Revisit sources (HypAware, Beads events journal) | 4 |
| Factory Clock | 3 Own the theme (`theme.css`) | none |
| Factory Clock | 4 Move files into `packages/viz`; advisor UI loads them; VS Code drops the Explore tab | 3, RFC 5 |
| Factory Clock | 5 Identity: README, contract docs, publish as Factory Clock | 4 |
| Factory Clock | 6 Release `dist/` | 5 |
| Factory Clock | 7 Own repository | 6 |

- Record the refactor itself as the first experiment once RFC 4's measures exist: the baseline from "Before starting 3c" is its "before".
