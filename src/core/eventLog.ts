import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from './types';

const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function todayFileName(date = new Date()): string {
  return `${date.toISOString().slice(0, 10)}.jsonl`;
}

export class EventLog {
  private readonly eventsDir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storageDir: string) {
    this.eventsDir = path.join(storageDir, 'events');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.eventsDir, { recursive: true });
  }

  append(event: NormalizedEvent): void {
    const line = JSON.stringify(event) + '\n';
    const filePath = path.join(this.eventsDir, todayFileName());
    this.enqueue(() => fs.promises.appendFile(filePath, line, 'utf8'), 'failed to append event log line');
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
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as NormalizedEvent);
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

  /**
   * Deletes one past day's file. Callers must never pass today's key: appends
   * always target today's file, so only past days are safe to remove without
   * going through the write queue.
   */
  async deleteDay(day: string): Promise<void> {
    await fs.promises.rm(path.join(this.eventsDir, `${day}.jsonl`), { force: true });
  }

  /** Removes every daily file, ordered after any appends already queued. */
  clear(): Promise<void> {
    this.enqueue(async () => {
      for (const day of await this.listDays()) {
        await fs.promises.rm(path.join(this.eventsDir, `${day}.jsonl`), { force: true });
      }
    }, 'failed to clear event log');
    return this.writeQueue;
  }

  private enqueue(op: () => Promise<void>, failureMessage: string): void {
    this.writeQueue = this.writeQueue.then(op).catch((err) => {
      console.error(`snagboat: ${failureMessage}`, err);
    });
  }
}
