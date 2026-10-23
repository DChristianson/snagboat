import * as fs from 'fs';
import * as path from 'path';
import { AdapterCheckpoint } from './types';

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Per-adapter checkpoints (read positions and the like). Adapters save after
 * every chunk they read, so writes are serialized per adapter, coalesced to the
 * latest, and atomic (temp file, then rename). Overlapping plain writes could
 * leave a corrupt file, which reads as no checkpoint and makes the adapter
 * re-read, and re-log, everything from the start.
 */
export class CheckpointStore {
  private readonly checkpointsDir: string;
  private readonly writing = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, AdapterCheckpoint>();

  constructor(storageDir: string) {
    this.checkpointsDir = path.join(storageDir, 'checkpoints');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.checkpointsDir, { recursive: true });
  }

  private filePath(adapterId: string): string {
    return path.join(this.checkpointsDir, `${sanitize(adapterId)}.json`);
  }

  async read(adapterId: string): Promise<AdapterCheckpoint | undefined> {
    try {
      const contents = await fs.promises.readFile(this.filePath(adapterId), 'utf8');
      return JSON.parse(contents) as AdapterCheckpoint;
    } catch {
      return undefined;
    }
  }

  /** Resolves once this checkpoint, or a later one for the same adapter, is on disk. */
  write(adapterId: string, checkpoint: AdapterCheckpoint): Promise<void> {
    const queued = this.pending.has(adapterId);
    this.pending.set(adapterId, checkpoint);
    if (queued) return this.writing.get(adapterId)!;
    const previous = this.writing.get(adapterId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = this.pending.get(adapterId)!;
        this.pending.delete(adapterId);
        const target = this.filePath(adapterId);
        const temp = `${target}.${process.pid}.tmp`;
        await fs.promises.writeFile(temp, JSON.stringify(latest, null, 2), 'utf8');
        await fs.promises.rename(temp, target);
      });
    this.writing.set(adapterId, next);
    return next;
  }
}
