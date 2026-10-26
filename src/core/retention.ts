import * as fs from 'fs';
import * as path from 'path';
import { AgentAggregate, Aggregate } from './aggregate';
import { EventLog, eventDay } from './eventLog';
import { hasCapturedText, withoutCapturedText } from './excerpt';
import { NormalizedEvent } from './types';

const AGGREGATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Days of raw events kept, counting today. Clamped to at least 1 so today's live file is never touched. */
  rawDays: number;
  /** Days of daily aggregates kept, counting today. -1 keeps them forever; 0 keeps none. */
  aggregateDays: number;
  /**
   * Days captured text (reply excerpts, prompt text) is kept, counting today.
   * Older raw days keep their events with the text removed. Never longer
   * than rawDays; at least 1.
   */
  textDays: number;
}

/** The oldest day whose raw events may still carry captured text. */
export function oldestTextDay(today: string, policy: RetentionPolicy): string {
  return oldestKeptDay(today, Math.max(1, Math.min(Math.floor(policy.textDays), Math.floor(policy.rawDays))));
}

/** One day's worth of raw events, rolled up into the same per-agent shape Aggregate exposes. */
export interface DailyAggregate {
  version: 1;
  date: string;
  perAgent: Record<string, AgentAggregate>;
  localEditCount: number;
  totalTokens: number;
}

export interface RetentionResult {
  /** Days whose raw file was rolled up and deleted. */
  rolledUp: string[];
  /** Raw days whose captured text was removed. */
  textRemoved: string[];
  /**
   * Totals that left on-disk history entirely this run (aggregates pruned, or
   * raw days dropped without an aggregate because aggregateDays excluded them),
   * so the live all-time Aggregate can subtract them without a full rebuild.
   */
  dropped: DailyAggregate[];
}

export function summarizeDay(date: string, events: NormalizedEvent[]): DailyAggregate {
  const agg = new Aggregate();
  for (const event of events) agg.apply(event);
  const snapshot = agg.snapshot();
  return { version: 1, date, ...snapshot };
}

/** The oldest YYYY-MM-DD day still inside a window of `days` days ending on (and including) `today`. */
export function oldestKeptDay(today: string, days: number): string {
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  return new Date(todayMs - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** Sums two rolled-up days (same date) into one. */
export function combineDaily(a: DailyAggregate, b: DailyAggregate): DailyAggregate {
  const agg = new Aggregate();
  agg.applyDaily(a);
  agg.applyDaily(b);
  return { version: 1, date: a.date, ...agg.snapshot() };
}

export class AggregateStore {
  private readonly aggregatesDir: string;
  // Days with an aggregate file, kept in sync with writes and deletes so
  // EventSink can route synchronously.
  private knownDays = new Set<string>();

  constructor(storageDir: string) {
    this.aggregatesDir = path.join(storageDir, 'aggregates');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.aggregatesDir, { recursive: true });
    this.knownDays = new Set(await this.listDays());
  }

  hasDay(day: string): boolean {
    return this.knownDays.has(day);
  }

  /** Adds a day's events into its existing aggregate (or creates one). */
  async mergeInto(daily: DailyAggregate): Promise<void> {
    const existing = await this.read(daily.date);
    await this.write(existing ? combineDaily(existing, daily) : daily);
  }

  async listDays(): Promise<string[]> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.aggregatesDir);
    } catch {
      return [];
    }
    return files
      .map((f) => AGGREGATE_FILE_PATTERN.exec(f)?.[1])
      .filter((d): d is string => d !== undefined)
      .sort();
  }

  async read(day: string): Promise<DailyAggregate | undefined> {
    try {
      const contents = await fs.promises.readFile(this.filePath(day), 'utf8');
      return JSON.parse(contents) as DailyAggregate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`snagboat: skipping unreadable daily aggregate ${day}`, err);
      }
      return undefined;
    }
  }

  /** Written via temp file + rename so a crash mid-write never leaves a truncated aggregate behind. */
  async write(daily: DailyAggregate): Promise<void> {
    const target = this.filePath(daily.date);
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(daily, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
    this.knownDays.add(daily.date);
  }

  async delete(day: string): Promise<void> {
    this.knownDays.delete(day);
    await fs.promises.rm(this.filePath(day), { force: true });
  }

  async clear(): Promise<void> {
    this.knownDays.clear();
    for (const day of await this.listDays()) {
      await this.delete(day);
    }
  }

  private filePath(day: string): string {
    return path.join(this.aggregatesDir, `${day}.json`);
  }
}

/**
 * Rolls raw days older than rawDays into daily aggregates, then prunes
 * aggregates older than aggregateDays. Idempotent and crash-safe: each
 * aggregate is fully written before its raw file is deleted, and readers
 * (Aggregate.rehydrateFrom) prefer a raw file over an aggregate for the same
 * day, so a crash between the two steps never double counts.
 */
export async function applyRetention(
  eventLog: EventLog,
  aggregates: AggregateStore,
  policy: RetentionPolicy,
  today: string
): Promise<RetentionResult> {
  const result: RetentionResult = { rolledUp: [], textRemoved: [], dropped: [] };
  const rawCutoff = oldestKeptDay(today, Math.max(1, Math.floor(policy.rawDays)));
  const aggregateInWindow = (day: string) => aggregateWindowIncludes(day, policy, today);

  for (const day of await eventLog.listDays()) {
    if (day >= rawCutoff) break;
    // From here on, new events for this day go to its aggregate (EventSink),
    // and any appends already queued land before it's read.
    await eventLog.releaseDay(day);
    const daily = summarizeDay(day, await eventLog.readDay(day));
    if (aggregateInWindow(day)) {
      await aggregates.write(daily);
    } else {
      result.dropped.push(daily);
    }
    await eventLog.deleteDay(day);
    result.rolledUp.push(day);
  }

  // Captured text has its own, shorter retention: older raw days keep their events without it.
  const textCutoff = oldestTextDay(today, policy);
  for (const day of await eventLog.listDays()) {
    if (day >= textCutoff) break;
    if (!(await eventLog.readDay(day)).some(hasCapturedText)) continue;
    await eventLog.rewriteDay(day, (events) => events.map(withoutCapturedText));
    result.textRemoved.push(day);
  }

  const rawDays = new Set(await eventLog.listDays());
  for (const day of await aggregates.listDays()) {
    if (aggregateInWindow(day)) continue;
    const daily = await aggregates.read(day);
    // An aggregate shadowed by a surviving raw file was never counted, so it isn't "dropped".
    if (daily && !rawDays.has(day)) result.dropped.push(daily);
    await aggregates.delete(day);
  }

  return result;
}

/**
 * Decides where each incoming event is stored, keeping every day in exactly
 * one place: its raw file while inside the raw window, its daily aggregate
 * once rolled up. Events usually belong to today, but a transcript catch-up
 * (or a fresh install reading old transcripts) can deliver events for any past
 * day, including days already rolled up or older than retention:
 *
 *   - day already has an aggregate            -> merged into it
 *   - day has a raw file, or is inside the raw window -> appended raw
 *   - older than the raw window, within aggregate retention -> merged into a (new) aggregate
 *   - older than aggregate retention          -> not stored
 *
 * Aggregate merges are batched per day and run on `enqueue`, the same queue
 * retention runs on, so they never interleave with a rollup.
 */
export class EventSink {
  private pending = new Map<string, NormalizedEvent[]>();
  private flushScheduled = false;

  constructor(
    private readonly eventLog: EventLog,
    private readonly aggregates: AggregateStore,
    private readonly policy: () => RetentionPolicy,
    private readonly today: () => string,
    private readonly enqueue: (op: () => Promise<void>) => void
  ) {}

  /** Stores the event; returns false if it's older than all retention and so wasn't kept. */
  write(incoming: NormalizedEvent): boolean {
    const day = eventDay(incoming);
    const policy = this.policy();
    const today = this.today();
    // Catching up on an old transcript: text already past its retention isn't stored at all.
    const event = day < oldestTextDay(today, policy) ? withoutCapturedText(incoming) : incoming;
    if (this.aggregates.hasDay(day)) {
      this.queueMerge(day, event);
      return true;
    }
    if (this.eventLog.hasDay(day) || day >= oldestKeptDay(today, Math.max(1, Math.floor(policy.rawDays)))) {
      this.eventLog.append(event);
      return true;
    }
    if (!aggregateWindowIncludes(day, policy, today)) return false;
    this.queueMerge(day, event);
    return true;
  }

  private queueMerge(day: string, event: NormalizedEvent): void {
    const events = this.pending.get(day) ?? [];
    events.push(event);
    this.pending.set(day, events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.enqueue(async () => {
      this.flushScheduled = false;
      const batch = this.pending;
      this.pending = new Map();
      for (const [batchDay, events] of batch) {
        // Re-checked at flush time: retention may have pruned the window since.
        if (!aggregateWindowIncludes(batchDay, this.policy(), this.today())) continue;
        await this.aggregates.mergeInto(summarizeDay(batchDay, events));
      }
    });
  }
}

function aggregateWindowIncludes(day: string, policy: RetentionPolicy, today: string): boolean {
  if (policy.aggregateDays === 0) return false;
  return policy.aggregateDays < 0 || day >= oldestKeptDay(today, Math.floor(policy.aggregateDays));
}
