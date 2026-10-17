# Heuristics

## Contract

```ts
interface HeuristicContext {
  readonly now: string;               // injected, not Date.now(), for deterministic tests
  readonly store: ReadonlyEventStore; // the only way a heuristic may access event data
  readonly settings: Record<string, unknown>;
}

interface Heuristic {
  readonly id: string;
  readonly appliesTo: NormalizedEvent['kind'][]; // push-trigger prefilter; the timer tick always runs everything
  evaluate(ctx: HeuristicContext): Finding[];
}

interface Finding {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
  suggestedAction?: string;
  detectedAt: string; // when this finding was produced; breaks ties when picking the "worst" active finding
}
```

**Deviation from the original design, implemented in v1's first increment**: `evaluate` originally took a single precomputed `window: NormalizedEvent[]`. That doesn't hold up in practice — `stalled` needs only "time since the last event" (an array is the wrong shape and wasted work to build), and `token-budget` needs cumulative token sums, not raw events at all. There is no single window size that serves both of those honestly alongside `backtracking`/`tool-churn`, so `evaluate` now receives a `HeuristicContext` instead, giving each heuristic exactly the query it needs via `store` (a `ReadonlyEventStore`, see [architecture.md](architecture.md) for `EventStore`'s design — the single well-defined query interface heuristics are allowed to use; direct access to `EventLog` or `Aggregate` is not permitted).

Heuristics operate only on normalized events, reached exclusively through `ctx.store`. They never reach back into adapter-specific raw payloads.

## Built-ins

### `backtracking` — implemented

Flags when the same target is touched repeatedly (`edit` or `tool_call`) within a rolling window with no intervening success. Settings: `snagboat.heuristics.backtracking.window` (minutes, default `10` — resolved as wall-clock time, not an event count) and `snagboat.heuristics.backtracking.minRepeats` (default `3`). A `status: 'success'` event on the same target strictly between the first and last touch suppresses the finding as legitimate iteration rather than looping; a success only at either endpoint does not suppress it.

### `tool-churn` — implemented

Flags high tool-call volume (`snagboat.heuristics.toolChurn.minCalls`, default `8`) within a rolling window (`.window`, minutes, default `5`) landing on very few distinct targets (`.maxDistinctTargets`, default `2`). Catches spinning behavior even when an adapter can only report `unknown` status values.

### `verbal-hedge` — implemented

Looks for hedge or self-correction phrases ("I think", "should work", "let me try", "actually,", "my mistake", "that didn't work", …) in the `textExcerpt` of `turn_stop` events. It fires per session when at least `snagboat.heuristics.verbalHedge.minTurns` (default `2`) replies hedge within `.window` minutes (default `10`). It is `info` on its own and escalates to `warn` only when the same session shows a behavioral signal in the window: a target touched 3 or more times, or a failed tool call. Hedging alone never escalates. It is silent unless `snagboat.captureContent` is on, since no other path populates `textExcerpt`. Phrases favor multi-word or punctuated forms ("actually," rather than "actually") to avoid matching ordinary prose.

### `token-budget` — implemented, local and project levels only

Compares cumulative token counts against `snagboat.tokenBudget.session` (per active session) and `snagboat.tokenBudget.day` (per workspace, i.e. project-wide for the current day) — both settings predate this engine and intentionally aren't namespaced under `snagboat.heuristics.*`. A global, cross-workspace rollup and a treemap visualization were explicitly requested during design but deferred to a separate increment: today every workspace's storage is isolated from every other workspace, so "global" needs new shared cross-workspace storage, and the treemap needs a webview.

### `stalled` — implemented

Marks the workspace as stalled when no new events arrive within `snagboat.heuristics.stalled.minutes` (default `15`). Triggered on every event kind (not a narrow subset) specifically so a new event promptly clears an active finding via the push path, rather than waiting for the next timer tick; it also runs on a timer regardless of events, since detecting *absence* of events can't be purely event-triggered.

## Acknowledging and muting

Heuristics don't need to do anything to support either: both are applied by `FindingsRegistry` on top of whatever a heuristic reports, keyed by heuristic id. See [architecture.md](architecture.md#heuristics-engine).

## Plugin model

Third-party heuristics should register via `snagboat.heuristics` and document:

- which `NormalizedEvent.kind` values they inspect
- which findings they emit
- any settings they introduce
- whether they require optional data such as `textExcerpt`

## Session-level rollups

The design reserves separate, slower rollups for evaluating longer-running virtues and failure modes over a session, day, or PR. Those rollups should remain distinct from short-window heuristics so the status bar can stay responsive.
