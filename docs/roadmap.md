# Implementation roadmap

## Dependencies

Kept deliberately small: everything at runtime is bundled into one file and shipped in the `.vsix`.

| Purpose | Dependency | License | Shipped |
| --- | --- | --- | --- |
| File watching | chokidar 4 (and its one dependency, readdirp) | MIT | Yes |
| Language | TypeScript | Apache-2.0 | No |
| Bundling | esbuild | MIT | No |
| Integration tests | `@vscode/test-electron`, mocha | MIT | No |
| Packaging | `@vscode/vsce` | MIT | No |

The OTLP receiver, HTTP servers, charts (inline SVG), and unit tests (plain Node scripts) use no libraries. [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) is generated from what's actually bundled. Likely future additions: `ovsx` for publishing to Open VSX (publish-time only), and a SQLite library if log export needs one.

## CI/CD

In place ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), on pushes to `main` and pull requests, on Ubuntu and macOS:

- `npm ci`
- unit tests (`npm run test:unit`, which also type-checks via `tsc`)
- production bundle
- third-party license check (`npm run licenses -- --check`)
- `.vsix` packaging
- Dependabot updates for npm and GitHub Actions

Planned:

- the integration suite (`npm test`) in CI, which needs a virtual display on Linux
- on `v*` tags: build the `.vsix`, attach it to a GitHub release, and publish to the VS Code Marketplace and Open VSX
- a weekly replay of the redacted transcript fixture against the heuristics engine

## Session-level meta-characters

The design reserves longer-window rollups for three virtues and their failure modes:

- laziness
- impatience
- hubris

These rollups should evaluate sessions, days, or PRs instead of the short event windows used by the live heuristics engine.

## Planned tasks

- **Per-field retention policy.** Today every field in an event shares the `rawDays` clock. Once content capture is in use, decide which fields (command-string `target`, `textExcerpt`, possibly file paths) need a shorter retention, and implement it by scrubbing those fields from older events in place, keeping one event store. See [PRIVACY.md](../PRIVACY.md#retention).
- **Per-window hook routing with discovery files and auth tokens — done.** Hooks previously all went to fixed port 45679, so the first VS Code window to bind it logged every project's hook events and the rest got none. Each window now listens on its own port and publishes per-folder route files with an auth token; a stable sh script routes each hook by `CLAUDE_PROJECT_DIR` (see [architecture.md](architecture.md#claude-code-adapter)). Existing projects' old `curl` hook entries are rewritten in place the next time a window opens them. Not handled: workspace folders added or removed after activation get routes only on the next reload, and the script needs a POSIX shell, so Windows is unsupported (as before).

  Separately, zero Claude tokens in a window had a different cause, now fixed: a window opened before its project's first Claude session never noticed the transcripts folder appearing. The tailer now checks for a missing folder every 15 minutes.

- **Terminal and git signals.** Complete the generic file-system adapter: terminal shell-integration exit codes as `test_run` events, and `git status`/`git diff` polling to tell real edits from no-op saves (rows already in [schema.md](schema.md)).
- **Cross-workspace token budget.** A global budget across all workspaces, plus a treemap of where tokens go. Needs storage shared between workspaces; today each workspace's storage is isolated.
- **Extension points.** `snagboat.adapters` and `snagboat.heuristics` contribution points so other extensions can add sources and heuristics without forking.
- **Log export.** A `snagboat.exportLog` command writing CSV or SQLite, with an optional SQLite side index rebuilt from the JSONL log.
- **Housekeeping.** Prune checkpoint entries for transcripts that no longer exist, and offer a command to remove Snagboat's hook entries from a project's `.claude/settings.json`.
- **Copilot OTel per-window routing.** Copilot still exports every window's telemetry to one fixed port (4318), so the first window to bind it collects all of it. It can't use the hook routing above, since Copilot's exporter takes a single endpoint URL; revisit once live traffic shows whether spans identify the workspace.

## Open questions

- When longer-horizon rollups arrive, should explanation-oriented turns and verification runs become explicit schema annotations or remain derived signals?
