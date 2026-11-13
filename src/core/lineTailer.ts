import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const readFd = promisify(fs.read);
const fstatFd = promisify(fs.fstat);
const closeFd = promisify(fs.close);

/**
 * Backup scan interval. fs.watch is fast but can occasionally miss or coalesce
 * events (and dies if the folder is removed), so every file is also re-checked
 * on this schedule. A re-check of an unchanged file is one stat call.
 */
export const RESCAN_INTERVAL_MS = 60_000;

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
  /** Override for tests. */
  rescanIntervalMs?: number;
  /**
   * For a folder whose contents can't be trusted (a dev container's transcripts):
   * opens a file in place of a plain open, returning its descriptor, or undefined
   * to leave it unread. The file is then read at most maxLineBytes at a time, and
   * a line longer than that is skipped (onSkippedLine), never held in memory whole.
   */
  open?(filePath: string): number | undefined;
  /** With open: the longest line read (default 8 MB). */
  maxLineBytes?: number;
  onSkippedLine?(filePath: string): void;
}

/** The longest line read from an untrusted folder, by default. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Watches a folder of growing text files and delivers newly appended,
 * complete lines. Uses Node's fs.watch on the folder plus a periodic rescan,
 * rather than a watcher library: reads always resume from the saved offset and
 * only take complete lines (readNewLines), so duplicate or spurious events are
 * harmless and half-written lines are simply picked up next time.
 */
export class LineTailer {
  private watcher?: fs.FSWatcher;
  private rescanTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly inFlight = new Set<string>();
  // Files that changed again while being read; read once more when that read finishes.
  private readonly rerun = new Set<string>();
  // Files whose read position is inside a line too long to read (open mode): skipped to its end.
  private readonly skipping = new Set<string>();

  constructor(private readonly options: LineTailerOptions) {}

  start(): void {
    this.stopped = false;
    this.ensureWatching();
    this.rescan();
    this.rescanTimer = setInterval(() => {
      this.ensureWatching();
      this.rescan();
    }, this.options.rescanIntervalMs ?? RESCAN_INTERVAL_MS);
  }

  /**
   * Stops watching once every file present now has been read through. For
   * folders that only need catching up: call right after start().
   */
  stopAfterCatchUp(): void {
    clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    // start() already queued a read of every file; mark stopped once they finish.
    const waitIdle = () => (this.inFlight.size === 0 && this.rerun.size === 0 ? (this.stopped = true) : setTimeout(waitIdle, 50));
    setTimeout(waitIdle, 0);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** (Re)creates the folder watcher if it isn't running, e.g. after the folder was removed and recreated. */
  private ensureWatching(): void {
    if (this.watcher || this.stopped) return;
    try {
      this.watcher = fs.watch(this.options.dir, { persistent: true }, (_event, filename) => {
        // Some platforms omit the name; fall back to checking every file.
        if (!filename) return this.rescan();
        const filePath = path.join(this.options.dir, filename.toString());
        if (this.options.includeFile(filePath)) void this.processFile(filePath);
      });
      this.watcher.on('error', (err) => {
        this.watcher?.close();
        this.watcher = undefined;
        this.options.onWatchError?.(err);
      });
    } catch (err) {
      // Folder missing or unreadable; the rescan timer retries.
      this.options.onWatchError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private rescan(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.options.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const filePath = path.join(this.options.dir, name);
      if (this.options.includeFile(filePath)) void this.processFile(filePath);
    }
  }

  private async processFile(filePath: string): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight.has(filePath)) {
      this.rerun.add(filePath);
      return;
    }
    this.inFlight.add(filePath);
    try {
      if (this.options.open) {
        await this.processGuarded(filePath, this.options.open);
        return;
      }
      const stat = await fs.promises.stat(filePath).catch(() => undefined);
      if (stat?.isFile()) {
        const fromOffset = this.options.getOffset(filePath);
        const { lines, newOffset } = await readNewLines(filePath, fromOffset);
        if (lines.length > 0) {
          this.options.onLines(filePath, lines, fromOffset);
          this.options.setOffset(filePath, newOffset);
        }
        this.options.onReadResult?.(filePath, undefined);
      }
    } catch (err) {
      console.error(`snagboat: failed tailing ${filePath}`, err);
      this.options.onReadResult?.(filePath, err);
    } finally {
      this.inFlight.delete(filePath);
      if (this.rerun.delete(filePath)) void this.processFile(filePath);
    }
  }

  /** processFile for an untrusted folder: the file as opened by open(), read in bounded chunks. */
  private async processGuarded(filePath: string, open: (filePath: string) => number | undefined): Promise<void> {
    const fd = open(filePath);
    if (fd === undefined) return; // refused or gone; open() said why
    const max = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    try {
      for (;;) {
        if (this.stopped) return;
        const { size } = await fstatFd(fd);
        const from = this.options.getOffset(filePath);
        if (size <= from) break;
        const want = Math.min(size - from, max);
        const data = Buffer.alloc(want);
        const { bytesRead } = await readFd(fd, data, 0, want, from);
        if (bytesRead === 0) break;
        const chunk = data.subarray(0, bytesRead);
        const full = bytesRead === max;
        let start = 0;
        if (this.skipping.has(filePath)) {
          // The rest of a line too long to read.
          const newline = chunk.indexOf(10);
          if (newline === -1) {
            if (!full) break; // still being written
            this.options.setOffset(filePath, from + bytesRead);
            continue;
          }
          start = newline + 1;
          this.skipping.delete(filePath);
          this.options.onSkippedLine?.(filePath);
        }
        const last = chunk.lastIndexOf(10);
        if (last < start) {
          if (start > 0) {
            this.options.setOffset(filePath, from + start);
            continue;
          }
          if (!full) break; // no complete line yet
          // A line longer than max: skip to its end, which a later chunk holds.
          this.skipping.add(filePath);
          this.options.setOffset(filePath, from + bytesRead);
          continue;
        }
        const lines = chunk.subarray(start, last + 1).toString('utf8').split('\n').filter((line) => line.length > 0);
        if (lines.length > 0) this.options.onLines(filePath, lines, from + start);
        this.options.setOffset(filePath, from + last + 1);
      }
      this.options.onReadResult?.(filePath, undefined);
    } finally {
      await closeFd(fd).catch(() => undefined);
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
