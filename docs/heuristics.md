# Heuristics

## Contract

```ts
interface Heuristic {
  readonly id: string;
  readonly appliesTo: NormalizedEvent['kind'][];
  evaluate(window: NormalizedEvent[]): Finding[];
}

interface Finding {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
  suggestedAction?: string;
}
```

Heuristics operate only on normalized events. They never reach back into adapter-specific raw payloads.

## Planned built-ins

### `backtracking`

Flags when the same target file is edited repeatedly in a short rolling window or when an edit/tool call returns to a target that recently failed.

Design notes:

- should distinguish expected iteration from unproductive looping
- should rely on a tunable event-count or wall-clock window
- should only escalate when no intervening success breaks the loop

### `tool-churn`

Flags unusually high tool-call volume against a shrinking set of targets. This catches spinning behavior even when an adapter can only report `unknown` status values.

### `verbal-hedge`

Looks for hedge or self-correction language in `textExcerpt` captured on normalized turn events. This is a post-processing heuristic rather than an adapter-emitted event type, and it should stay informational unless paired with a behavioral signal such as backtracking or tool churn.

### `token-budget`

Compares cumulative token counts against configurable session or daily budgets.

### `stalled`

Marks an active session as stalled when no new events arrive within a configurable time window.

## Plugin model

Third-party heuristics should register via `snagboat.heuristics` and document:

- which `NormalizedEvent.kind` values they inspect
- which findings they emit
- any settings they introduce
- whether they require optional data such as `textExcerpt`

## Session-level rollups

The design reserves separate, slower rollups for evaluating longer-running virtues and failure modes over a session, day, or PR. Those rollups should remain distinct from short-window heuristics so the status bar can stay responsive.
