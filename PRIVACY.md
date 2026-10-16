# Privacy

Snagboat is designed to keep observation local to the developer's machine.

## What is captured

### Structural events

By default the extension is expected to retain only structural events such as:

- tool calls
- edits
- test runs
- turn boundaries
- token usage totals

These records are sufficient for most heuristics and for daily aggregate reporting.

### Optional captured text

`textExcerpt` is the only normalized field expected to contain user or code content. It exists solely to support hedge-language detection and should remain:

- opt-in
- truncated
- retained separately from structural events
- disabled by default

## Storage model

- Event logs are append-only JSONL files under the extension storage URI.
- Logs remain local-only by default.
- No telemetry is sent off-machine.
- Any future shared aggregate feature must be a separate, clearly labeled opt-in.

## Retention defaults

| Data | Default retention | Setting |
| --- | --- | --- |
| Structural events | 90 days before rolling into daily aggregates | `snagboat.retention.rawDays` |
| `textExcerpt` content | 3 days | `snagboat.retention.textDays` |
| Daily aggregates | `-1` keeps them indefinitely; `0` disables retention | `snagboat.retention.aggregateDays` |

Raw and aggregate retention are implemented: on activation, hourly, and whenever these settings change, raw daily files older than `rawDays` (counting today) are rolled up into `aggregates/<date>.json` and deleted, and aggregates older than `aggregateDays` are removed. `textDays` is not yet implemented because no adapter captures `textExcerpt` yet.

## User controls

- `Snagboat: Clear Event Log` (`snagboat.clearLog`) wipes raw logs and daily aggregates on demand, after a confirmation prompt. Adapter checkpoints are kept so already-seen transcript history is not re-imported.
- Content capture and text retention should be explained together in settings so the privacy tradeoff is visible at enable time.

## Design guardrails

- Adapters should prefer pointers back to raw source data over copying large payloads into normalized events.
- Heuristics and UI code should tolerate missing `textExcerpt` values.
- Token tracking should not require content capture.
