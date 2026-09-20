import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from './types';

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
    this.writeQueue = this.writeQueue
      .then(() => fs.promises.appendFile(filePath, line, 'utf8'))
      .catch((err) => {
        console.error('snagboat: failed to append event log line', err);
      });
  }

  async readAll(): Promise<NormalizedEvent[]> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.eventsDir);
    } catch {
      return [];
    }

    const events: NormalizedEvent[] = [];
    for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
      const contents = await fs.promises.readFile(path.join(this.eventsDir, file), 'utf8');
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as NormalizedEvent);
        } catch {
          console.warn(`snagboat: skipping malformed event log line in ${file}`);
        }
      }
    }
    return events;
  }
}
