# Contributing

## Current scope

This repository currently tracks the design for the Snagboat VS Code extension. Contributions should preserve the core design rule that adapters stay agent-specific while the rest of the system stays schema-driven.

## Adding an adapter

1. Implement the shared adapter interface.
2. Keep all agent-specific parsing inside the adapter.
3. Register the adapter via the `snagboat.adapters` contribution point.
4. Add or update the adapter's transformation-matrix rows in [docs/schema.md](docs/schema.md).
5. Document any privacy-sensitive data the adapter can emit.

## Adding a heuristic

1. Implement the shared heuristic contract.
2. Consume only normalized events.
3. Register the heuristic via `snagboat.heuristics`.
4. Document settings, required event kinds, and whether optional fields such as `textExcerpt` are required.

## Proposed validation pipeline

Once the extension scaffold exists, pull requests should run:

- `npm ci`
- ESLint
- `tsc --noEmit`
- Vitest
- license allowlist checks
- a headless `@vscode/test-electron` smoke test

## Licensing expectations

Bundled runtime dependencies should stay within the planned permissive allowlist:

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC

## Review checklist

Before opening a PR, verify that you updated the relevant design docs when changing:

- adapter behavior
- normalized schema fields
- heuristic semantics
- retention or privacy guarantees
- dependency or licensing assumptions
