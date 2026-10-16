import * as fs from 'fs';
import * as path from 'path';
import { AgentAggregate, Aggregate } from './aggregate';
import { EventLog } from './eventLog';
import { NormalizedEvent } from './types';

const AGGREGATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Days of raw events kept, counting today. Clamped to at least 1 so today's live file is never touched. */
  rawDays: number;
  /** Days of daily aggregates kept, counting today. -1 keeps them forever; 0 keeps none. */
  aggregateDays: number;
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

export class AggregateStore {
  private readonly aggregatesDir: string;

  constructor(storageDir: string) {
    this.aggregatesDir = path.join(storageDir, 'aggregates');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.aggregatesDir, { recursive: true });
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
  }

  async delete(day: string): Promise<void> {
    await fs.promises.rm(this.filePath(day), { force: true });
  }

  async clear(): Promise<void> {
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
  const result: RetentionResult = { rolledUp: [], dropped: [] };
  const rawCutoff = oldestKeptDay(today, Math.max(1, Math.floor(policy.rawDays)));
  const keepAggregates = policy.aggregateDays !== 0;
  const aggregateCutoff = policy.aggregateDays > 0 ? oldestKeptDay(today, Math.floor(policy.aggregateDays)) : undefined;
  const aggregateInWindow = (day: string) => keepAggregates && (aggregateCutoff === undefined || day >= aggregateCutoff);

  for (const day of await eventLog.listDays()) {
    if (day >= rawCutoff) break;
    const daily = summarizeDay(day, await eventLog.readDay(day));
    if (aggregateInWindow(day)) {
      await aggregates.write(daily);
    } else {
      result.dropped.push(daily);
    }
    await eventLog.deleteDay(day);
    result.rolledUp.push(day);
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
