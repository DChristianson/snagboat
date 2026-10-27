import * as fs from 'fs';
import * as path from 'path';
import { AdapterContext } from '../../core/types';
import { LineTailer } from '../../core/lineTailer';
import { isWithinFolders } from '../../core/paths';
import { CopilotCliState, copilotSessionNameEvent, normalizeCopilotCliChunk, readSessionCwd, readSessionName } from './cliSessions';

export const DISCOVERY_INTERVAL_MS = 60_000;
/** Sessions written to within this window are watched; older ones are read once to catch up. */
export const ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface CopilotCliCheckpoint {
  version: 1;
  offsets: Record<string, number>;
  lastTurnByFile: Record<string, string>;
}

/** keep drops entries for session logs that no longer exist (see keepCheckpointEntry); by default everything is kept. */
export function readCliCheckpoint(
  state: Record<string, unknown> | undefined,
  keep: (file: string) => boolean = () => true
): { offsets: Map<string, number>; lastTurns: Map<string, string> } {
  const offsets = new Map<string, number>();
  const lastTurns = new Map<string, string>();
  if (state?.version === 1) {
    for (const [f, o] of Object.entries((state.offsets as Record<string, unknown>) ?? {})) if (typeof o === 'number' && keep(f)) offsets.set(f, o);
    for (const [f, t] of Object.entries((state.lastTurnByFile as Record<string, unknown>) ?? {})) if (typeof t === 'string' && keep(f)) lastTurns.set(f, t);
  }
  return { offsets, lastTurns };
}

/**
 * Follows Copilot CLI sessions (~/.copilot/session-state/<id>/events.jsonl)
 * whose working directory is inside this window's workspace, the same way
 * the Claude Code tailer follows transcripts.
 */
export class CopilotCliTailer {
  private discovery?: NodeJS.Timeout;
  private watched = new Map<string, LineTailer>();
  private caughtUp = new Map<string, number>();
  private cwdBySession = new Map<string, string | null>();
  private states = new Map<string, CopilotCliState>();

  constructor(
    private readonly ctx: AdapterContext,
    private readonly baseDir: string,
    private readonly workspaceFolders: string[],
    private readonly offsets: Map<string, number>,
    private readonly lastTurns: Map<string, string>,
    private readonly persistCheckpoint: () => void,
    private readonly opts: { discoveryIntervalMs?: number; activeWindowMs?: number; rescanIntervalMs?: number } = {}
  ) {}

  start(): void {
    this.discover();
    this.discovery = setInterval(() => this.discover(), this.opts.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.discovery);
    this.discovery = undefined;
    for (const t of this.watched.values()) t.stop();
    this.watched.clear();
  }

  checkpoint(): CopilotCliCheckpoint {
    const lastTurnByFile: Record<string, string> = {};
    for (const [file, state] of this.states) if (state.lastTurn) lastTurnByFile[file] = state.lastTurn;
    for (const [file, turn] of this.lastTurns) lastTurnByFile[file] ??= turn;
    return { version: 1, offsets: Object.fromEntries(this.offsets), lastTurnByFile };
  }

  private discover(): void {
    let sessions: string[];
    try {
      sessions = fs.readdirSync(this.baseDir);
    } catch {
      return; // no Copilot CLI sessions on this machine (yet)
    }
    const activeSince = Date.now() - (this.opts.activeWindowMs ?? ACTIVE_WINDOW_MS);
    for (const session of sessions) {
      const dir = path.join(this.baseDir, session);
      const file = path.join(dir, 'events.jsonl');
      let mtime: number;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!this.belongsHere(dir, file)) continue;
      const active = mtime >= activeSince;
      const watching = this.watched.get(dir);
      if (active && !watching) {
        const tailer = this.newLineTailer(dir);
        this.watched.set(dir, tailer);
        tailer.start();
      } else if (!active && watching) {
        watching.stop();
        this.watched.delete(dir);
      } else if (!active && !watching && this.caughtUp.get(dir) !== mtime) {
        this.caughtUp.set(dir, mtime);
        const tailer = this.newLineTailer(dir);
        tailer.start();
        tailer.stopAfterCatchUp();
      }
    }
  }

  /** Only sessions started inside this window's workspace (cached; a session's cwd doesn't change). */
  private belongsHere(dir: string, file: string): boolean {
    let cwd = this.cwdBySession.get(dir);
    if (cwd === undefined) {
      cwd = readSessionCwd(file) ?? null;
      // A brand-new session may not have written session.start yet; ask again next time.
      if (cwd !== null) this.cwdBySession.set(dir, cwd);
    }
    return cwd !== null && isWithinFolders(cwd, this.workspaceFolders);
  }

  private stateFor(file: string): CopilotCliState {
    let state = this.states.get(file);
    if (!state) {
      state = new CopilotCliState(this.lastTurns.get(file));
      this.states.set(file, state);
    }
    return state;
  }

  private newLineTailer(dir: string): LineTailer {
    return new LineTailer({
      dir,
      includeFile: (f) => path.basename(f) === 'events.jsonl',
      rescanIntervalMs: this.opts.rescanIntervalMs,
      getOffset: (f) => this.offsets.get(f) ?? 0,
      setOffset: (f, o) => {
        this.offsets.set(f, o);
        this.persistCheckpoint();
      },
      onLines: (f, lines, offset) => {
        const state = this.stateFor(f);
        const captureContent = this.ctx.captureContent();
        for (const event of normalizeCopilotCliChunk(lines, f, offset, state, { captureContent })) this.ctx.publish(event);
        if (!captureContent) return;
        // The session's name lives in workspace.yaml beside the log; check it whenever the log grows.
        const named = readSessionName(f);
        if (named && named.name !== state.lastName) {
          state.lastName = named.name;
          this.ctx.publish(copilotSessionNameEvent(state.sessionId ?? path.basename(path.dirname(f)), named.name, f, named.updatedAt));
        }
      },
      onReadResult: (f, err) =>
        this.ctx.reportHealth(`copilot-session:${path.basename(path.dirname(f))}`, err ? `failed reading a Copilot session: ${err instanceof Error ? err.message : String(err)}` : undefined),
      onWatchError: (err) => this.ctx.reportHealth('copilotSessionWatcher', `Copilot session watcher error: ${err.message}`),
    });
  }
}
