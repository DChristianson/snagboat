import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from './types';

const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * The UTC day an event belongs to, from its own timestamp: events are filed
 * under the day they happened, not the day they were written, so catching up
 * on an old transcript doesn't pile history into today's file. Falls back to
 * today for a missing or unparseable timestamp.
 */
export function eventDay(event: NormalizedEvent): string {
  const ms = Date.parse(event.ts);
  return new Date(Number.isNaN(ms) ? Date.now() : ms).toISOString().slice(0, 10);
}

/** What rehydrating from the raw log needs: an EventLog, or a snapshot of one read once. */
export interface EventLogReader {
  listDays(): Promise<string[]>;
  readDay(day: string): Promise<NormalizedEvent[]>;
  readAll(): Promise<NormalizedEvent[]>;
}

export class EventLog implements EventLogReader {
  private readonly eventsDir: string;
  private writeQueue: Promise<void> = Promise.resolve();
  // Days with a raw file on disk or queued to be written, kept in sync with
  // every append and delete so routing decisions (EventSink) can be made
  // synchronously as events arrive.
  private knownDays = new Set<string>();

  constructor(storageDir: string) {
    this.eventsDir = path.join(storageDir, 'events');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.eventsDir, { recursive: true });
    this.knownDays = new Set(await this.listDays());
  }

  /** Appends to the file for the event's own day (see eventDay). */
  append(event: NormalizedEvent): void {
    const day = eventDay(event);
    this.knownDays.add(day);
    const line = JSON.stringify(event) + '\n';
    const filePath = path.join(this.eventsDir, `${day}.jsonl`);
    this.enqueue(() => fs.promises.appendFile(filePath, line, 'utf8'), 'failed to append event log line');
  }

  /** Whether the day has a raw file (or one queued to be written). */
  hasDay(day: string): boolean {
    return this.knownDays.has(day);
  }

  /**
   * Stops routing new events to this day's raw file, then waits for appends
   * already queued to land. Retention calls this before rolling a day up, so
   * no event can be appended after the day has been read and before it is
   * deleted; later events for the day go to its daily aggregate instead.
   */
  releaseDay(day: string): Promise<void> {
    this.knownDays.delete(day);
    return this.flush();
  }

  /** Resolves once every append/clear queued so far has hit disk. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  /** YYYY-MM-DD keys of every daily file on disk, oldest first. */
  async listDays(): Promise<string[]> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.eventsDir);
    } catch {
      return [];
    }
    return files
      .map((f) => DAY_FILE_PATTERN.exec(f)?.[1])
      .filter((d): d is string => d !== undefined)
      .sort();
  }

  async readDay(day: string): Promise<NormalizedEvent[]> {
    const file = `${day}.jsonl`;
    let contents: string;
    try {
      contents = await fs.promises.readFile(path.join(this.eventsDir, file), 'utf8');
    } catch {
      return [];
    }
    const events: NormalizedEvent[] = [];
    // An event logged twice (a source re-read after a lost checkpoint) counts once.
    const ids = new Set<string>();
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as NormalizedEvent;
        if (ids.has(event.eventId)) continue;
        ids.add(event.eventId);
        events.push(event);
      } catch {
        console.warn(`snagboat: skipping malformed event log line in ${file}`);
      }
    }
    return events;
  }

  async readAll(): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];
    for (const day of await this.listDays()) {
      events.push(...(await this.readDay(day)));
    }
    return events;
  }

  /** Deletes a day's file. Call releaseDay first, so nothing is still being appended to it. */
  async deleteDay(day: string): Promise<void> {
    this.knownDays.delete(day);
    await fs.promises.rm(path.join(this.eventsDir, `${day}.jsonl`), { force: true });
  }

  /**
   * Replaces a day's events with transform(current events), ordered after any
   * appends already queued, so none can land between the read and the write.
   * The file is replaced atomically (temp file, then rename). A day with no
   * file is left alone unless create is set. Rejects if the rewrite fails;
   * the day is then unchanged.
   */
  rewriteDay(day: string, transform: (events: NormalizedEvent[]) => NormalizedEvent[], opts: { create?: boolean } = {}): Promise<void> {
    const file = path.join(this.eventsDir, `${day}.jsonl`);
    const op = this.writeQueue.then(async () => {
      if (!fs.existsSync(file) && !opts.create) return;
      const events = transform(await this.readDay(day));
      if (events.length === 0 && !fs.existsSync(file)) return;
      this.knownDays.add(day);
      const temp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, events.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
      await fs.promises.rename(temp, file);
    });
    this.writeQueue = op.catch((err) => console.error(`snagboat: failed to rewrite ${day}`, err));
    return op;
  }

  /** Removes every daily file, ordered after any appends already queued. */
  clear(): Promise<void> {
    this.knownDays.clear();
    this.enqueue(async () => {
      for (const day of await this.listDays()) {
        await fs.promises.rm(path.join(this.eventsDir, `${day}.jsonl`), { force: true });
      }
    }, 'failed to clear event log');
    return this.writeQueue;
  }

  /**
   * Every raw day read once into memory, for rehydrating several consumers
   * (totals, history, sessions, the event store) without re-parsing the log
   * for each. Waits for queued writes first; later appends aren't included.
   */
  async snapshot(): Promise<EventLogSnapshot> {
    await this.flush();
    const days = new Map<string, NormalizedEvent[]>();
    for (const day of await this.listDays()) days.set(day, await this.readDay(day));
    return new EventLogSnapshot(days);
  }

  private enqueue(op: () => Promise<void>, failureMessage: string): void {
    this.writeQueue = this.writeQueue.then(op).catch((err) => {
      console.error(`snagboat: ${failureMessage}`, err);
    });
  }
}

/** The raw log as read at one moment (EventLog.snapshot). Readers share its event objects, so they must not modify them. */
export class EventLogSnapshot implements EventLogReader {
  constructor(private readonly days: Map<string, NormalizedEvent[]>) {}

  async listDays(): Promise<string[]> {
    return [...this.days.keys()];
  }

  async readDay(day: string): Promise<NormalizedEvent[]> {
    return this.days.get(day) ?? [];
  }

  async readAll(): Promise<NormalizedEvent[]> {
    return [...this.days.values()].flat();
  }
}
