import * as fs from 'fs';
import * as path from 'path';
import { AdapterContext } from '../../core/types';
import { LineTailer } from '../../core/lineTailer';
import { normalizeTranscriptChunk, SeenMessages } from './normalize';

/**
 * How often to look for a transcripts folder that doesn't exist yet (a project
 * with no Claude Code session so far). File watching can't be relied on to
 * notice the folder appearing later, and a first session in a new project is
 * rare enough that a slow check is fine: once found, tailing starts from the
 * top of each transcript, so nothing is missed.
 */
export const FOLDER_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export class TranscriptTailer {
  private tailer?: LineTailer;
  private folderCheck?: NodeJS.Timeout;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly dir: string | undefined,
    private readonly offsets: Map<string, number>,
    private readonly seen: SeenMessages,
    private readonly persistCheckpoint: () => void,
    private readonly folderCheckIntervalMs = FOLDER_CHECK_INTERVAL_MS
  ) {}

  start(): void {
    const dir = this.dir;
    if (!dir) {
      this.ctx.reportHealth('transcripts', 'no workspace folder open, transcript tailing disabled');
      return;
    }
    this.ctx.reportHealth('transcripts', undefined);
    if (fs.existsSync(dir)) {
      this.startTailing(dir);
      return;
    }
    console.warn(`snagboat: no Claude Code transcripts at ${dir} yet; checking again every ${Math.round(this.folderCheckIntervalMs / 60_000)} minutes`);
    this.folderCheck = setInterval(() => {
      if (!fs.existsSync(dir)) return;
      clearInterval(this.folderCheck);
      this.folderCheck = undefined;
      this.startTailing(dir);
    }, this.folderCheckIntervalMs);
  }

  stop(): void {
    clearInterval(this.folderCheck);
    this.folderCheck = undefined;
    this.tailer?.stop();
  }

  private startTailing(dir: string): void {
    this.tailer = new LineTailer({
      glob: path.join(dir, '*.jsonl'),
      getOffset: (filePath) => this.offsets.get(filePath) ?? 0,
      setOffset: (filePath, offset) => {
        this.offsets.set(filePath, offset);
        this.persistCheckpoint();
      },
      onLines: (filePath, lines, chunkStartOffset) => {
        // A failure leaves the offset unadvanced so these lines are re-read;
        // the message ids they recorded must be undone too, or the retry
        // would treat the messages as already counted and drop them.
        const before = this.seen.snapshot();
        try {
          const events = normalizeTranscriptChunk(lines, filePath, chunkStartOffset, {
            captureContent: this.ctx.captureContent(),
            seen: this.seen,
          });
          for (const event of events) this.ctx.publish(event);
        } catch (err) {
          this.seen.restore(before);
          throw err;
        }
      },
      // Per file, so one unreadable transcript doesn't hide (or get cleared by) another.
      onReadResult: (filePath, err) =>
        this.ctx.reportHealth(
          `transcript:${path.basename(filePath)}`,
          err ? `failed reading ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}` : undefined
        ),
      onWatchError: (err) => this.ctx.reportHealth('transcriptWatcher', `transcript watcher error: ${err.message}`),
    });
    this.tailer.start();
  }
}
