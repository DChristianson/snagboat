# Third-party license plan

The Snagboat design currently targets a permissive runtime dependency tree.

## Planned runtime dependency licenses

| Purpose | Dependency | Expected license |
| --- | --- | --- |
| Extension host APIs | VS Code Extension API | MIT |
| Language | TypeScript | Apache-2.0 |
| Bundling | esbuild | MIT |
| File watching | chokidar | MIT |
| Schema validation | zod | MIT |
| Copilot OTel receiver | `@opentelemetry/*` | Apache-2.0 |
| Optional SQLite index | `better-sqlite3` or `sql.js` | MIT |
| Testing | Vitest, `@vscode/test-electron` | MIT |
| Packaging | `@vscode/vsce` | MIT |
| Date handling | date-fns | MIT |

## Notice handling

Apache-2.0 dependencies require notice preservation even when the project itself remains MIT licensed, so the eventual implementation should generate and maintain a machine-derived notice file from the actual dependency tree.

## CI expectation

The planned CI pipeline should fail when bundled runtime dependencies fall outside this allowlist:

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC

`ovsx` is expected to remain a publish-time CLI rather than a bundled dependency, so its EPL-2.0 license should not affect the extension's shipped license.
