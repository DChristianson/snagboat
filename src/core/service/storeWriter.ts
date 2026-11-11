import * as fs from 'fs';
import * as path from 'path';
import { eventDay, NormalizedEvent } from '@snagboat/schema';
import { effectiveSettings } from '../config';
import { EventLog } from '../eventLog';
import { AggregateStore, applyRetention, EventSink, oldestTextDay, RetentionPolicy } from '../retention';
import { withoutCapturedText } from '../excerpt';
import { listUserStores, openWorkspaceStore, userDataDir, workspaceInfoOf, workspaceKey, workspaceStoreDir } from '../userStore';
import { Claim, claimedBy, claimOf } from './claims';
import { isProcessAlive } from '../processes';

/**
 * How the core writes into the per-user store (3c-2, 3c-3b). Each workspace the
 * core owns is written the way a VS Code window writes its own: every eventId
 * once, through EventSink (a day already rolled up merges into its aggregate,
 * and text past its retention isn't stored), with the workspace's retention
 * run by the core (runRetention), using that workspace's settings
 * (config.json, .snagboat.json).
 *
 * A workspace a VS Code window has claimed (claims.ts) is the window's: the
 * core neither writes nor prunes it. Its events wait in the spool,
 * data/spool/events/<workspace key>.jsonl, until ingestSpool() finds the claim
 * gone, unless the caller says to drop them (the window records them itself).
 */

export interface WriteResult {
  written: number;
  duplicates: number;
  spooled: number;
  dropped: number;
}

/** For an event whose workspace a window has claimed: keep it for later, or drop it because the window has it. */
export type ClaimedPolicy = (event: NormalizedEvent, claim: Claim) => 'spool' | 'drop';

/** Told of each batch written to a workspace's store (stored raw or merged into an aggregate): the live feed (GET /events/stream). */
export type WrittenListener = (workspace: string, events: NormalizedEvent[]) => void;

export function spoolDir(home: string): string {
  return path.join(userDataDir(home), 'spool', 'events');
}

const todayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** A workspace's retention, from its settings, with the built-in defaults. */
export function retentionPolicyFor(home: string, workspace: string): RetentionPolicy {
  const values = effectiveSettings(home, workspaceInfoOf(workspace).folder ?? workspace).values;
  const num = (key: string, fallback: number) => (typeof values[key] === 'number' ? (values[key] as number) : fallback);
  return { rawDays: num('retention.rawDays', 90), aggregateDays: num('retention.aggregateDays', -1), textDays: num('retention.textDays', 30) };
}

interface OpenStore {
  dir: string;
  log: EventLog;
  aggregates: AggregateStore;
  sink: EventSink;
  /** Aggregate merges EventSink queued, awaited at the end of each write. */
  merges: Array<Promise<void>>;
  /** Event ids already in each day, read from disk the first time a day is written. */
  known: Map<string, Set<string>>;
}

export class StoreWriter {
  private readonly stores = new Map<string, OpenStore>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<WrittenListener>();

  constructor(private readonly home: string, private readonly now: () => number = Date.now) {}

  /** Writes events (each must have its workspace set); serialized with every other write, ingest and retention run. */
  write(events: NormalizedEvent[], onClaimed: ClaimedPolicy = () => 'spool'): Promise<WriteResult> {
    return this.serial(() => this.writeNow(events, onClaimed));
  }

  /** Calls the listener with each batch written from now on; returns a function that stops it. */
  onWritten(listener: WrittenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Waits for every write already started, then moves spooled events of
   * workspaces no longer claimed into their stores. A client window calls it
   * after holding its folder (nothing is written there once it returns) and
   * after letting go (what was spooled meanwhile is in). What the core knew of
   * each folder (its days, its event ids) is read again, since the window may
   * have rewritten days.
   */
  flush(): Promise<number> {
    return this.serial(() => {
      this.stores.clear();
      return this.ingestNow();
    });
  }

  /** Moves spooled events of workspaces no longer claimed into their stores. Returns how many were written. */
  ingestSpool(): Promise<number> {
    return this.serial(() => this.ingestNow());
  }

  /** Applies each unclaimed workspace's retention: rolls up old days and removes captured text past textDays. */
  runRetention(): Promise<number> {
    return this.serial(() => this.retentionNow());
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async open(workspace: string): Promise<OpenStore> {
    const existing = this.stores.get(workspace);
    if (existing) return existing;
    const dir = await openWorkspaceStore(this.home, workspaceInfoOf(workspace));
    const log = new EventLog(dir, { workspace });
    await log.init();
    const aggregates = new AggregateStore(dir);
    await aggregates.init();
    const merges: Array<Promise<void>> = [];
    const sink = new EventSink(log, aggregates, () => retentionPolicyFor(this.home, workspace), () => todayKey(this.now()), (op) => merges.push(op()));
    const store: OpenStore = { dir, log, aggregates, sink, merges, known: new Map() };
    this.stores.set(workspace, store);
    return store;
  }

  private async writeNow(events: NormalizedEvent[], onClaimed: ClaimedPolicy): Promise<WriteResult> {
    const result: WriteResult = { written: 0, duplicates: 0, spooled: 0, dropped: 0 };
    const byWorkspace = new Map<string, NormalizedEvent[]>();
    for (const e of events) byWorkspace.set(e.workspace!, [...(byWorkspace.get(e.workspace!) ?? []), e]);
    for (const [workspace, list] of byWorkspace) {
      const claim = claimOf(workspaceStoreDir(this.home, workspace));
      if (claim) {
        // A window writes this folder: forget what we knew of it (the window changes it), and spool or drop.
        this.stores.delete(workspace);
        const spool = list.filter((e) => onClaimed(e, claim) === 'spool');
        if (spool.length > 0) await this.spool(workspace, spool);
        result.spooled += spool.length;
        result.dropped += list.length - spool.length;
        continue;
      }
      const { written, duplicates, dropped } = await this.append(workspace, list);
      result.written += written;
      result.duplicates += duplicates;
      result.dropped += dropped;
    }
    return result;
  }

  private async append(workspace: string, events: NormalizedEvent[]): Promise<{ written: number; duplicates: number; dropped: number }> {
    const store = await this.open(workspace);
    let written = 0;
    let duplicates = 0;
    let dropped = 0;
    const kept: NormalizedEvent[] = [];
    // As EventSink stores them: text past its retention removed.
    const textFrom = oldestTextDay(todayKey(this.now()), retentionPolicyFor(this.home, workspace));
    for (const event of events) {
      const day = eventDay(event);
      let ids = store.known.get(day);
      if (!ids) {
        ids = new Set((await store.log.readDay(day)).map((e) => e.eventId));
        store.known.set(day, ids);
      }
      if (ids.has(event.eventId)) {
        duplicates += 1;
        continue;
      }
      ids.add(event.eventId);
      if (store.sink.write(event)) {
        written += 1;
        kept.push({ ...(eventDay(event) < textFrom ? withoutCapturedText(event) : event), workspace });
      } else dropped += 1; // older than all retention
    }
    await store.log.flush();
    await Promise.all(store.merges.splice(0));
    if (kept.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(workspace, kept);
        } catch {
          // a listener's failure is its own
        }
      }
    }
    return { written, duplicates, dropped };
  }

  private async retentionNow(): Promise<number> {
    let changed = 0;
    for (const s of listUserStores(this.home)) {
      if (claimedBy(s.dir) !== undefined) {
        this.stores.delete(s.workspace);
        continue;
      }
      const store = await this.open(s.workspace);
      const result = await applyRetention(store.log, store.aggregates, retentionPolicyFor(this.home, s.workspace), todayKey(this.now()));
      // Days rolled up or rewritten: their ids are re-read the next time they're written.
      for (const day of [...result.rolledUp, ...result.textRemoved]) store.known.delete(day);
      changed += result.rolledUp.length + result.textRemoved.length;
    }
    return changed;
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

/** Every retention run's interval: a day's text or raw events expire at most this late. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
