# snagboat

Snagboat is a planned VS Code extension that watches AI coding agents, normalizes their activity into a shared event schema, mines the resulting log for signs of trouble, and surfaces the result in a status bar indicator plus a detail view.

## Project status

This repository currently captures the v0.1 design plan for the extension. The core idea is to keep adapters agent-specific, keep everything downstream schema-driven, and keep all captured data local by default.

## Quickstart

1. Read the [architecture overview](docs/architecture.md).
2. Review the [normalized event schema and transformation matrix](docs/schema.md).
3. Read the [heuristics design](docs/heuristics.md).
4. Review the [privacy and retention model](PRIVACY.md).
5. Follow the [contribution guide](CONTRIBUTING.md) before proposing adapter or heuristic changes.

## Architecture overview

```mermaid
flowchart LR
  subgraph Sources
    Claude[Claude Code hooks + JSONL transcript]
    Copilot[Copilot Chat OTel spans + session log]
    Workspace[Workspace saves + terminal exit codes + git]
  end

  subgraph Adapters
    ClaudeAdapter[claude-code-adapter]
    CopilotAdapter[copilot-adapter]
    GenericAdapter[generic-fs-adapter]
  end

  subgraph Core
    Normalization[Normalization layer]
    EventLog[Append-only event log JSONL]
    Heuristics[Pluggable heuristics engine]
  end

  subgraph UI
    Status[Status bar item]
    Detail[Detail webview]
  end

  External[External tools: jq, DuckDB, notebooks]

  Claude --> ClaudeAdapter --> Normalization
  Copilot --> CopilotAdapter --> Normalization
  Workspace --> GenericAdapter --> Normalization
  Normalization --> EventLog --> Heuristics --> Status
  Heuristics --> Detail
  EventLog --> External
```

Adapters own all agent-specific parsing. The normalization layer is the only place that understands the common schema, so heuristics and UI code never need agent-specific branches.

## Planned settings reference

| Setting | Default | Purpose |
| --- | --- | --- |
| `snagboat.retention.rawDays` | `90` | Retain structural events before rolling them into daily aggregates. |
| `snagboat.retention.textDays` | `3` | Retain captured text excerpts when content capture is enabled. |
| `snagboat.captureContent` | `false` | Opt into storing truncated text excerpts used by the verbal-hedge heuristic. |
| `snagboat.tokenBudget.session` | unset | Warn when a single session crosses a configured token budget. |
| `snagboat.tokenBudget.day` | unset | Warn when the current day crosses a configured token budget. |
| `snagboat.heuristics.backtracking.window` | TBD | Tune the short rolling window used to distinguish iteration from looping. |
| `snagboat.heuristics.stalled.minutes` | TBD | Define when an active session is considered stalled. |

## Planned status indicators

| Character | Meaning | Planned accessible label / icon text |
| --- | --- | --- |
| 🚗 **Cruisin' Clyde** | No open findings in the active window | `On track` with a steady-dot or check-style codicon-weight glyph |
| 🪃 **Boomerang Bea** | Backtracking detected | `Backtracking detected` with a loop or history-style glyph |
| 🔁 **Loopy Lou** | Tool churn detected | `Tool churn detected` with a sync/spin-style glyph |
| 🤔 **Wobbly Walt** | Hedge language paired with behavioral trouble | `Low-confidence language detected` with a question or pulse-style glyph |
| ⛽ **Meter Mo** | Token budget warning | `Token budget warning` with a dashboard or meter-style glyph |
| 💤 **Snoozy Sam** | An active session has stalled | `Session stalled` with a clock or mute-style glyph |

The final extension should use simple SVG or codicon-weight icons in the actual status bar, keep text labels available to screen readers, and reserve the character names for tooltips and detail views.

## Repository docs

- [Architecture](docs/architecture.md)
- [Schema and transformation matrix](docs/schema.md)
- [Heuristics](docs/heuristics.md)
- [Implementation roadmap](docs/roadmap.md)
- [Privacy](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party license plan](THIRD_PARTY_LICENSES.md)
