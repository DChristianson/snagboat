import { watch, FSWatcher } from 'chokidar';
import * as fs from 'fs';

export interface LineTailerOptions {
  /** Folder whose direct children are watched (not recursive). */
  dir: string;
  /** Which files in it to tail. */
  includeFile(filePath: string): boolean;
  getOffset(filePath: string): number;
  setOffset(filePath: string, offset: number): void;
  onLines(filePath: string, lines: string[], chunkStartOffset: number): void;
  /** Called after every read attempt: the error if it failed, undefined if it succeeded. */
  onReadResult?(filePath: string, err: unknown): void;
  onWatchError?(err: Error): void;
}

/** Watches a folder of growing text files and delivers newly appended, complete lines. */
export class LineTailer {
  private watcher?: FSWatcher;
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: LineTailerOptions) {}

  start(): void {
    // chokidar 4 has no glob support (and no fsevents: it always uses
    // fs.watch), so watch the folder itself and filter its files.
    this.watcher = watch(this.options.dir, {
      depth: 0,
      ignored: (filePath, stats) => stats?.isFile() === true && !this.options.includeFile(filePath),
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher.on('add', (path) => this.processFile(path));
    this.watcher.on('change', (path) => this.processFile(path));
    this.watcher.on('error', (err) => this.options.onWatchError?.(err instanceof Error ? err : new Error(String(err))));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async processFile(filePath: string): Promise<void> {
    if (this.inFlight.has(filePath)) return;
    this.inFlight.add(filePath);
    try {
      const fromOffset = this.options.getOffset(filePath);
      const { lines, newOffset } = await readNewLines(filePath, fromOffset);
      if (lines.length > 0) {
        this.options.onLines(filePath, lines, fromOffset);
        this.options.setOffset(filePath, newOffset);
      }
      this.options.onReadResult?.(filePath, undefined);
    } catch (err) {
      console.error(`snagboat: failed tailing ${filePath}`, err);
      this.options.onReadResult?.(filePath, err);
    } finally {
      this.inFlight.delete(filePath);
    }
  }
}

export async function readNewLines(
  filePath: string,
  fromOffset: number
): Promise<{ lines: string[]; newOffset: number }> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= fromOffset) {
    return { lines: [], newOffset: fromOffset };
  }

  const fd = await fs.promises.open(filePath, 'r');
  try {
    const length = stat.size - fromOffset;
    const buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, length, fromOffset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      // No complete line yet; wait for more data before advancing the offset.
      return { lines: [], newOffset: fromOffset };
    }
    const consumedText = text.slice(0, lastNewline + 1);
    const lines = consumedText.split('\n').filter((line) => line.length > 0);
    const newOffset = fromOffset + Buffer.byteLength(consumedText, 'utf8');
    return { lines, newOffset };
  } finally {
    await fd.close();
  }
}
