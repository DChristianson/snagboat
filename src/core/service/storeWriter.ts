import * as fs from 'fs';
import * as path from 'path';
import { eventDay, NormalizedEvent } from '@snagboat/schema';
import { EventLog } from '../eventLog';
import { openWorkspaceStore, userDataDir, workspaceInfoOf, workspaceKey, workspaceStoreDir } from '../userStore';
import { claimedBy } from './claims';
import { isProcessAlive } from '../processes';

/**
 * How the core writes events into the per-user store (3c-2): appended to the
 * day file of the event's workspace, each eventId once. A workspace a VS Code
 * window has claimed (claims.ts) isn't written; its events wait in the spool,
 * data/spool/events/<workspace key>.jsonl, until ingestSpool() finds the claim
 * gone. The core never rewrites or deletes event files: retention stays with
 * whoever owns the workspace (the window today, the core from 3c-3).
 */

export interface WriteResult {
  written: number;
  duplicates: number;
  spooled: number;
}

export function spoolDir(home: string): string {
  return path.join(userDataDir(home), 'spool', 'events');
}

export class StoreWriter {
  /** Event ids already in each day file the core has written, read from disk the first time. */
  private readonly known = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly home: string) {}

  /** Writes events (each must have its workspace set); serialized, so two requests never interleave. */
  write(events: NormalizedEvent[]): Promise<WriteResult> {
    const run = this.queue.then(() => this.writeNow(events));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Moves spooled events of workspaces no longer claimed into their stores. Returns how many were written. */
  ingestSpool(): Promise<number> {
    const run = this.queue.then(() => this.ingestNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeNow(events: NormalizedEvent[]): Promise<WriteResult> {
    const result: WriteResult = { written: 0, duplicates: 0, spooled: 0 };
    const byWorkspace = new Map<string, NormalizedEvent[]>();
    for (const e of events) byWorkspace.set(e.workspace!, [...(byWorkspace.get(e.workspace!) ?? []), e]);
    for (const [workspace, list] of byWorkspace) {
      const dir = workspaceStoreDir(this.home, workspace);
      if (claimedBy(dir) !== undefined) {
        // A window writes this folder: drop what we know of it (the window adds to it) and spool.
        for (const key of [...this.known.keys()]) if (key.startsWith(dir + path.sep)) this.known.delete(key);
        await this.spool(workspace, list);
        result.spooled += list.length;
        continue;
      }
      const { written, duplicates } = await this.append(workspace, list);
      result.written += written;
      result.duplicates += duplicates;
    }
    return result;
  }

  private async append(workspace: string, events: NormalizedEvent[]): Promise<{ written: number; duplicates: number }> {
    const dir = await openWorkspaceStore(this.home, workspaceInfoOf(workspace));
    const log = new EventLog(dir, { workspace });
    await log.init();
    let written = 0;
    let duplicates = 0;
    for (const event of events) {
      const day = eventDay(event);
      const file = path.join(log.dir, `${day}.jsonl`);
      let ids = this.known.get(file);
      if (!ids) {
        ids = new Set((await log.readDay(day)).map((e) => e.eventId));
        this.known.set(file, ids);
      }
      if (ids.has(event.eventId)) {
        duplicates += 1;
        continue;
      }
      ids.add(event.eventId);
      log.append(event);
      written += 1;
    }
    await log.flush();
    return { written, duplicates };
  }

  private async spool(workspace: string, events: NormalizedEvent[]): Promise<void> {
    const dir = spoolDir(this.home);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(path.join(dir, `${workspaceKey(workspace)}.jsonl`), events.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  }

  private async ingestNow(): Promise<number> {
    const dir = spoolDir(this.home);
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl') || leftOver(n)).sort();
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      const events = readEvents(file);
      if (events.length === 0) {
        await fs.promises.rm(file, { force: true });
        continue;
      }
      const workspace = events[0].workspace!;
      if (claimedBy(workspaceStoreDir(this.home, workspace)) !== undefined) continue;
      // Take the file before reading it again, so events spooled meanwhile start
      // a new one. One left by a core that stopped mid-ingest is already taken;
      // appending dedupes, so whatever it wrote before stopping isn't doubled.
      const taken = leftOver(name) ? file : `${file}.${process.pid}.ingesting`;
      if (taken !== file) await fs.promises.rename(file, taken);
      const { written } = await this.append(workspace, readEvents(taken));
      await fs.promises.rm(taken, { force: true });
      total += written;
    }
    return total;
  }
}

/** A spool file a core took for ingesting and didn't finish (it exited). */
function leftOver(name: string): boolean {
  const m = /\.jsonl\.(\d+)\.ingesting$/.exec(name);
  return !!m && !isProcessAlive(Number(m[1]));
}

function readEvents(file: string): NormalizedEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: NormalizedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as NormalizedEvent;
      if (typeof e.workspace === 'string') out.push(e);
    } catch {
      // a torn line from a crash; skip it
    }
  }
  return out;
}
