import { EventStore } from '../core/eventStore';
import { NormalizedEvent } from '../core/types';
import { HeuristicsEngine } from './engine';
import { Finding, Heuristic } from './types';

/** One stretch of time a heuristic kept reporting findings. */
export interface ReplayEpisode {
  heuristicId: string;
  severity: 'info' | 'warn';
  /** The latest finding's summary. */
  summary: string;
  startTs: string;
  endTs: string;
  /** Events behind it, across every finding in the episode. */
  eventRefs: string[];
  /** Still reporting after the last event replayed. */
  open: boolean;
}

const TICK_MS = 30_000; // the extension's poll interval
/** Deeper into a quiet gap, tick less often: findings starting or ending there only need rough times. */
const SLOW_TICK_AFTER_MS = 30 * 60_000;
const SLOW_TICK_MS = 5 * 60_000;
/** Ticks continue this long into a quiet gap, past stalled's longest window, then skip to the next event. */
const MAX_IDLE_TICKS_MS = 4 * 60 * 60_000;
const MAX_REFS = 500;
/** A heuristic reporting again this soon after clearing continues its last episode instead of starting a new one. */
const REOPEN_WITHIN_MS = 2 * 60_000;

/**
 * Replays events through heuristics in time order, as the live extension
 * would see them: push-triggered evaluation per event, plus timer ticks in
 * between. Records when each heuristic started and stopped reporting, so past
 * findings can be shown for any stored session. Events arriving out of time
 * order are added to the store without ticking.
 */
export class FindingReplay {
  private readonly store = new EventStore({ windowMs: 24 * 60 * 60_000, maxEvents: 100_000 });
  private readonly engine: HeuristicsEngine;
  /** Only the heuristics whose verdict can change with time alone, for ticks between events. */
  private readonly tickEngine: HeuristicsEngine;
  private readonly openEpisodes = new Map<string, ReplayEpisode>();
  private readonly lastClosed = new Map<string, ReplayEpisode>();
  private readonly all: ReplayEpisode[] = [];
  private lastMs?: number;

  constructor(
    heuristics: Heuristic[],
    settingsFor: (id: string) => Record<string, unknown>,
    contextLimit?: (model: string | undefined) => number | undefined
  ) {
    this.engine = new HeuristicsEngine(heuristics, this.store, settingsFor, contextLimit);
    this.tickEngine = new HeuristicsEngine(heuristics.filter((h) => !h.onlyChangesWithEvents), this.store, settingsFor, contextLimit);
  }

  ingest(event: NormalizedEvent): void {
    const t = Date.parse(event.ts);
    if (Number.isNaN(t)) return;
    if (this.lastMs !== undefined && t >= this.lastMs) {
      const stopTicking = Math.min(t, this.lastMs + MAX_IDLE_TICKS_MS);
      for (let tick = this.lastMs + TICK_MS; tick < stopTicking; tick += tick - this.lastMs < SLOW_TICK_AFTER_MS ? TICK_MS : SLOW_TICK_MS) {
        this.apply(this.tickEngine.tick(new Date(tick).toISOString()), tick);
      }
    }
    this.store.ingest(event);
    if (this.lastMs === undefined || t >= this.lastMs) {
      this.lastMs = t;
      this.apply(this.engine.tickFor(event.kind, event.ts), t);
    }
  }

  episodes(): ReplayEpisode[] {
    return this.all.map((e) => ({ ...e, eventRefs: [...e.eventRefs] }));
  }

  private apply(results: Map<string, Finding[]>, ms: number): void {
    const ts = new Date(ms).toISOString();
    for (const [id, findings] of results) {
      let episode = this.openEpisodes.get(id);
      if (findings.length === 0) {
        if (episode) {
          episode.open = false;
          this.openEpisodes.delete(id);
          this.lastClosed.set(id, episode);
        }
        continue;
      }
      const recent = this.lastClosed.get(id);
      if (!episode && recent && ms - Date.parse(recent.endTs) <= REOPEN_WITHIN_MS) {
        episode = recent;
        episode.open = true;
        this.openEpisodes.set(id, episode);
      }
      if (!episode) {
        episode = { heuristicId: id, severity: 'info', summary: '', startTs: ts, endTs: ts, eventRefs: [], open: true };
        this.openEpisodes.set(id, episode);
        this.all.push(episode);
      }
      episode.endTs = ts;
      const worst = findings.find((f) => f.severity === 'warn') ?? findings[0];
      if (worst.severity === 'warn') episode.severity = 'warn';
      episode.summary = worst.summary;
      const refs = new Set(episode.eventRefs);
      for (const f of findings) for (const r of f.eventRefs) if (refs.size < MAX_REFS) refs.add(r);
      episode.eventRefs = [...refs];
    }
  }
}
