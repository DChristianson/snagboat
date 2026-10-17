# Implementation roadmap

## Planned libraries

| Purpose | Library | Planned license |
| --- | --- | --- |
| Extension host APIs | VS Code Extension API | MIT |
| Language | TypeScript | Apache-2.0 |
| Bundling | esbuild | MIT |
| File watching | chokidar | MIT |
| Schema validation | zod | MIT |
| Copilot OTel receiver | `@opentelemetry/sdk-node`, related exporters | Apache-2.0 |
| Optional SQLite side index | `better-sqlite3` or `sql.js` | MIT |
| Testing | Vitest and `@vscode/test-electron` | MIT |
| Packaging | `@vscode/vsce` | MIT |
| Open VSX publishing | `ovsx` (publish-time only) | EPL-2.0 |
| Charts | Chart.js or inline SVG | MIT |
| Icons | Codicons plus custom SVGs | MIT |
| Date handling | date-fns | MIT |

## Planned CI/CD

### Pull requests

- `npm ci`
- ESLint and `tsc --noEmit`
- Vitest
- license allowlist checks
- headless VS Code smoke test via `@vscode/test-electron`

### Tags (`v*`)

- full test suite
- production bundle via esbuild
- `.vsix` artifact generation with `vsce`
- publish to the VS Code Marketplace and Open VSX
- release notes generated from Changesets

### Scheduled automation

- dependency update automation through Dependabot or Renovate
- weekly fixture-log replay against the heuristics engine

## Session-level meta-characters

The design reserves longer-window rollups for three virtues and their failure modes:

- laziness
- impatience
- hubris

These rollups should evaluate sessions, days, or PRs instead of the short event windows used by the live heuristics engine.

## Planned tasks

- **Per-field retention policy.** Today every field in an event shares the `rawDays` clock. Once content capture is in use, decide which fields (command-string `target`, `textExcerpt`, possibly file paths) need a shorter retention, and implement it by scrubbing those fields from older events in place, keeping one event store. See [PRIVACY.md](../PRIVACY.md#retention).

## Open questions before v0.1

- Should backtracking use an event-count window, a time window, or a user-selectable combination?
- Should Copilot log-scrape mode be the default because it has lower setup friction than OTel mode?
- When longer-horizon rollups arrive, should explanation-oriented turns and verification runs become explicit schema annotations or remain derived signals?
