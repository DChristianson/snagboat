import * as fs from 'fs';
import * as path from 'path';
import { AdapterContext } from '../../core/types';
import { LineTailer } from '../../core/lineTailer';
import { normalizeTranscriptChunk, SeenMessages, TurnTracker } from './normalize';

/**
 * How often to look for a transcripts folder that doesn't exist yet (a project
 * with no Claude Code session so far). File watching can't be relied on to
 * notice the folder appearing later, and a first session in a new project is
 * rare enough that a slow check is fine: once found, tailing starts from the
 * top of each transcript, so nothing is missed.
 */
export const FOLDER_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** How often to look for new or newly active subagent folders. */
export const SUBAGENT_DISCOVERY_INTERVAL_MS = 60_000;

/**
 * A session's subagent folder is watched only while it has been written to
 * recently; older ones are read once to catch up and then left alone, so
 * months of finished sessions don't each hold a file watcher.
 */
export const SUBAGENT_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Newest modification time among a folder's .jsonl files, or 0 if none. */
function newestJsonlMtime(dir: string): number {
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    }
  } catch {
    // folder vanished mid-scan
  }
  return newest;
}

export class TranscriptTailer {
  private tailer?: LineTailer;
  private folderCheck?: NodeJS.Timeout;
  private subagentDiscovery?: NodeJS.Timeout;
  // Watched subagent folders, keyed by path.
  private subagentTailers = new Map<string, LineTailer>();
  private readonly turns: TurnTracker;
  // Inactive folders already caught up, with the newest file time at that point.
  private caughtUp = new Map<string, number>();

  constructor(
    private readonly ctx: AdapterContext,
    private readonly dir: string | undefined,
    private readonly offsets: Map<string, number>,
    private readonly seen: SeenMessages,
    private readonly persistCheckpoint: () => void,
    private readonly folderCheckIntervalMs = FOLDER_CHECK_INTERVAL_MS,
    private readonly subagentOpts: { discoveryIntervalMs?: number; activeWindowMs?: number; rescanIntervalMs?: number; turns?: TurnTracker } = {}
  ) {
    this.turns = subagentOpts.turns ?? new TurnTracker();
  }

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
    clearInterval(this.subagentDiscovery);
    this.subagentDiscovery = undefined;
    this.tailer?.stop();
    for (const tailer of this.subagentTailers.values()) tailer.stop();
    this.subagentTailers.clear();
  }

  private startTailing(dir: string): void {
    this.tailer = this.newLineTailer(dir);
    this.tailer.start();
    this.discoverSubagents(dir);
    this.subagentDiscovery = setInterval(() => this.discoverSubagents(dir), this.subagentOpts.discoveryIntervalMs ?? SUBAGENT_DISCOVERY_INTERVAL_MS);
  }

  /**
   * Subagent transcripts live at <transcripts>/<session>/subagents/*.jsonl,
   * one file per subagent run. Watches recently active folders; reads any
   * other folder once (its offsets make later reads no-ops) without keeping
   * a watcher on it.
   */
  private discoverSubagents(dir: string): void {
    let sessions: string[];
    try {
      sessions = fs.readdirSync(dir);
    } catch {
      return;
    }
    const activeSince = Date.now() - (this.subagentOpts.activeWindowMs ?? SUBAGENT_ACTIVE_WINDOW_MS);
    for (const session of sessions) {
      const subDir = path.join(dir, session, 'subagents');
      if (!fs.existsSync(subDir)) continue;
      const newest = newestJsonlMtime(subDir);
      const active = newest >= activeSince;
      const watching = this.subagentTailers.get(subDir);
      if (active && !watching) {
        const tailer = this.newLineTailer(subDir);
        this.subagentTailers.set(subDir, tailer);
        tailer.start();
      } else if (!active && watching) {
        watching.stop();
        this.subagentTailers.delete(subDir);
      } else if (!active && !watching && this.caughtUp.get(subDir) !== newest) {
        // Catch up once per change; a no-op read when offsets are already at the end.
        this.caughtUp.set(subDir, newest);
        const tailer = this.newLineTailer(subDir);
        tailer.start();
        tailer.stopAfterCatchUp();
      }
    }
  }

  private newLineTailer(dir: string): LineTailer {
    return new LineTailer({
      dir,
      rescanIntervalMs: this.subagentOpts.rescanIntervalMs,
      includeFile: (filePath) => filePath.endsWith('.jsonl'),
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
            turns: this.turns,
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
  }
}
