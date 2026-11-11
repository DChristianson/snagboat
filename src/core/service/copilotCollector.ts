import { AdapterContext, NormalizedEvent } from '@snagboat/schema';
import { CopilotCliTailer, readCliCheckpoint } from '../../adapters/copilot/cliTailer';
import { resolveCopilotSessionsDir } from '../../adapters/copilot/cliSessions';
import { CheckpointStore } from '../checkpointStore';
import { keepCheckpointEntry } from '../paths';

/**
 * Copilot CLI sessions (agent mode) for every project on the machine, read by
 * the core (3c-3d), as ClaudeCollector does for Claude Code: each session's
 * log (~/.copilot/session-state/<id>/events.jsonl) names the folder it started
 * in, which decides its workspace and capture setting. One checkpoint,
 * "copilot-cli", in data/core/checkpoints.
 *
 * Copilot's OpenTelemetry export (editor features) stays with the VS Code
 * window: its spans don't say which workspace they're from.
 */

export interface CopilotCollectorOptions {
  checkpoints: CheckpointStore;
  /** The workspace to record a session started in cwd under; undefined to not record it. */
  workspaceFor: (cwd: string) => string | undefined;
  captureContent: (cwd: string) => boolean;
  deliver: (events: NormalizedEvent[], cwd: string) => Promise<unknown>;
  log?: (line: string) => void;
  sessionsDir?: string;
  discoveryIntervalMs?: number;
}

const CHECKPOINT_ID = 'copilot-cli';

export class CopilotCollector {
  private tailer?: CopilotCliTailer;
  private readonly contexts = new Map<string, AdapterContext>();

  constructor(private readonly opts: CopilotCollectorOptions) {}

  async start(): Promise<void> {
    const sessionsDir = this.opts.sessionsDir ?? resolveCopilotSessionsDir();
    const checkpoint = await this.opts.checkpoints.read(CHECKPOINT_ID);
    const { offsets, lastTurns } = readCliCheckpoint(checkpoint?.state, keepCheckpointEntry(sessionsDir));
    const base = this.context('');
    this.tailer = new CopilotCliTailer(
      base,
      sessionsDir,
      undefined,
      offsets,
      lastTurns,
      () => void base.writeCheckpoint({ updatedAt: new Date().toISOString(), state: { ...this.tailer!.checkpoint() } }),
      {
        discoveryIntervalMs: this.opts.discoveryIntervalMs ?? (process.env.SNAGBOAT_COPILOT_DISCOVERY_MS ? Number(process.env.SNAGBOAT_COPILOT_DISCOVERY_MS) : 5_000),
        // Asked per chunk, so a project's settings (collect, captureContent) apply as they change.
        contextFor: (cwd) => (this.opts.workspaceFor(cwd) ? this.context(cwd) : undefined),
      }
    );
    this.tailer.start();
  }

  stop(): void {
    this.tailer?.stop();
  }

  /** One context per session folder: its events are batched and delivered with its workspace. */
  private context(cwd: string): AdapterContext {
    const existing = this.contexts.get(cwd);
    if (existing) return existing;
    const pending: NormalizedEvent[] = [];
    let scheduled = false;
    const ctx: AdapterContext = {
      publish: (event) => {
        pending.push(event);
        if (scheduled) return;
        scheduled = true;
        setImmediate(() => {
          scheduled = false;
          const batch = pending.splice(0);
          const workspace = this.opts.workspaceFor(cwd);
          if (!workspace || batch.length === 0) return;
          this.opts
            .deliver(batch.map((e) => ({ ...e, workspace })), cwd)
            .catch((err) => this.opts.log?.(`couldn't record Copilot events from ${cwd}: ${err instanceof Error ? err.message : String(err)}`));
        });
      },
      readCheckpoint: () => this.opts.checkpoints.read(CHECKPOINT_ID),
      // A failed write is logged, never thrown: an unhandled rejection would stop the whole core.
      writeCheckpoint: (cp) =>
        this.opts.checkpoints.write(CHECKPOINT_ID, cp).catch((err) => this.opts.log?.(`couldn't save the Copilot read position: ${err instanceof Error ? err.message : String(err)}`)),
      reportHealth: (_key, message) => message && this.opts.log?.(`Copilot${cwd ? ` (${cwd})` : ''}: ${message}`),
      captureContent: () => this.opts.captureContent(cwd),
    };
    this.contexts.set(cwd, ctx);
    return ctx;
  }
}
