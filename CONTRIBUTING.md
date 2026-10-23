# Contributing

Thanks for helping out. This guide covers how the code is organized, how to run and test it, and the rules that keep Snagboat's design and privacy promises intact.

## Ground rules

- **Adapters are agent-specific; everything else is schema-driven.** All parsing of a particular agent's data lives in its adapter, which emits `NormalizedEvent`s ([docs/schema.md](docs/schema.md)). Heuristics and UI must never branch on which agent produced an event.
- **Heuristics read events only through `ReadonlyEventStore`** (`ctx.store`), never the event log or aggregates directly, and take the time from `ctx.now`, never `Date.now()`, so they stay deterministic in tests.
- **Privacy is a feature.** Nothing leaves the machine. Never log payload contents (tool inputs and outputs, prompts, replies): log sizes and names instead. Anything new that an adapter records, or any new place data is stored, gets a row in [PRIVACY.md](PRIVACY.md). Token tracking must never depend on content capture.
- **Report problems through health, not the console.** `console.*` output from the extension isn't visible to users or written to VS Code's log files. Use `ctx.reportHealth(key, message)` for anything a user would need to know, and clear it with `undefined` when it resolves.

## Setup

Requires Node.js 22 or later (packaging with `@vscode/vsce` needs it) and VS Code 1.119 or later.

The minimum VS Code version (`engines.vscode`) also pins two dev dependencies, which Dependabot is told not to move on its own: `@types/vscode` must not be newer than that minimum (so code can't use APIs older VS Code lacks), and `@types/node` should match the Node major that version ships (Node 22 for 1.119). Raise all three together, deliberately.

```bash
npm install
npm run watch      # rebuilds dist/extension.js on change
```

Press F5 in VS Code to launch an Extension Development Host. The **Run Extension (snagboat-test)** launch configuration opens a sibling `../snagboat-test` folder; create it, or point the configuration at any project you want to watch.

## Layout

| Path | What's there |
| --- | --- |
| `src/extension.ts` | Activation: wires adapters, storage, heuristics, and UI together |
| `src/core/` | Event bus, daily event log, retention and rollups, `EventStore`, aggregates, health, file tailing |
| `src/adapters/<agent>/` | One folder per source (`claude-code`, `copilot`, `edit-tracker`). Parsing lives in `normalize.ts`, free of the `vscode` module so it can be unit tested |
| `src/heuristics/` | The engine, the findings registry (acknowledge/mute), and one file per heuristic |
| `src/ui/` | Status bar text, the detail view's panel and model; the page itself is `media/detail.js` and `media/detail.css` |
| `src/scripts/transcripts.ts` | Dev tooling for Claude Code transcripts (`verify:transcripts`, fixture redaction) |
| `scripts/licenses.js` | Generates `THIRD_PARTY_LICENSES.md` from what's actually bundled |
| `src/test/unit/` | Unit tests |
| `src/test/suite/` | Integration tests that run inside VS Code |

## Tests

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | Every unit test file, no VS Code needed. This is what CI runs. |
| `npm test` | The integration suite in a real VS Code instance (`@vscode/test-electron`, mocha TDD style). Uses a private `SNAGBOAT_HOME`, transcripts folder, and Copilot port, so it doesn't disturb your own windows. |
| `npm run replay:heuristics` | Replays your own Claude Code transcripts for this project through every heuristic and reports what would have fired, and when. For calibrating thresholds; `--settings '<json>'` overrides them. Prints counts and times only. |
| `npm run verify:transcripts` | Replays your own Claude Code transcripts for this project through the adapter and checks token totals. Prints totals only. |

Unit tests are plain Node scripts: each file collects `test(name, fn)` cases, runs them, prints `PASS`/`FAIL`, and exits non-zero on failure. No test framework is involved. A new test file must be added to the `test:unit` script in `package.json`. Keep code under test free of the `vscode` module; if something needs VS Code, pass the value in (as `TranscriptTailer` takes its folder) rather than importing it.

Some unit tests deliberately use real file watching, real HTTP servers, and the real hook shell script. When a test talks to a server running in the same process, spawn child processes asynchronously: a synchronous spawn blocks the event loop the server needs.

**Fixtures from real data must be redacted.** Hand-build fixtures shaped like real data where you can. If you need real structure, derive it with an allowlist (see `redact` in `src/scripts/transcripts.ts`) and check the result for text, paths, branch names, and real IDs before committing.

## Adding an adapter

1. Create `src/adapters/<name>/` implementing `AgentAdapter` (`init`, `start`, `stop`). Use a namespaced `custom:<name>` agent id unless it's a built-in.
2. Keep parsing in a `vscode`-free module and unit test it against data shaped like the real thing. Verify field names against the source's own documentation or a live capture rather than guessing.
3. Add it to the adapter list in `src/extension.ts`. (A `snagboat.adapters` contribution point for third-party adapters is planned but not built.)
4. Add a row per raw signal to the transformation matrix in [docs/schema.md](docs/schema.md), and document what it records in [PRIVACY.md](PRIVACY.md).

## Adding a heuristic

1. Create `src/heuristics/<name>.ts` implementing `Heuristic`, with `appliesTo` listing the event kinds that can change its verdict.
2. Add it to `builtInHeuristics()` in `src/heuristics/index.ts`. Settings go under `snagboat.heuristics.<id>` in `package.json`; if the section name differs from the id (camelCase, for example), add it to `SETTINGS_SECTION`.
3. Give it a status bar glyph in `FINDING_GLYPHS` (`src/ui/format.ts`).
4. Document it in [docs/heuristics.md](docs/heuristics.md) and the README's findings and settings tables, including whether it needs optional data such as `textExcerpt`.

## Dependencies and licenses

Runtime dependencies are bundled into `dist/extension.js` and shipped in the `.vsix`. There currently are none, and new ones need a good reason: file watching, HTTP, and charts are all done with Node and VS Code built-ins. Bundled packages must be licensed MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, or 0BSD. After changing runtime dependencies, run `npm run licenses` to regenerate `THIRD_PARTY_LICENSES.md` and commit it; CI fails if it's out of date or a license is outside the allowlist. Development-only tools aren't shipped and aren't subject to this.

## Before opening a pull request

- `npm run test:unit` and `npm test` pass, and `npm run build` is clean.
- `npm run licenses -- --check` passes.
- Docs are updated when you change adapter behavior, schema fields, heuristic semantics, settings, retention or privacy guarantees, or dependencies.
