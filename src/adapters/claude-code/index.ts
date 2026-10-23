import { AgentAdapter, AdapterContext } from '../../core/types';
import { TranscriptTailer } from './transcriptTail';
import { HooksReceiver } from './hooksReceiver';
import { buildHookCommand, ensureHooksConfigured } from './hooksConfig';
import { withRealPaths } from '../../core/paths';
import { resolveTranscriptsDir, resolveWorkspaceFolders } from './workspace';
import { installHookScript, newToken, pruneStaleRoutes, removeRoutes, snagboatHome, writeRoutes } from './hookRoutes';
import { SeenMessages, TurnTracker } from './normalize';
import { CheckpointStateV2, readCheckpointState } from './checkpointState';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId = 'claude-code' as const;

  private ctx?: AdapterContext;
  private offsets = new Map<string, number>();
  private seen = new SeenMessages();
  private turns = new TurnTracker();
  private transcriptTailer?: TranscriptTailer;
  private hooksReceiver?: HooksReceiver;
  private routedFolders: string[] = [];

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const checkpoint = await ctx.readCheckpoint();
    const { offsets, seen, turns } = readCheckpointState(checkpoint?.state);
    this.offsets = offsets;
    this.seen = seen;
    this.turns = turns;
  }

  async start(): Promise<void> {
    if (!this.ctx) throw new Error('ClaudeCodeAdapter.start() called before init()');

    this.transcriptTailer = new TranscriptTailer(this.ctx, resolveTranscriptsDir(), this.offsets, this.seen, () => this.persistCheckpoint(), undefined, { turns: this.turns });
    this.transcriptTailer.start();

    await this.startHooks(this.ctx);
  }

  /**
   * Starts this window's hook receiver on a free port and publishes routes for
   * its workspace folders, so the shared hook script delivers each Claude Code
   * project's hooks here and nowhere else (see hookRoutes.ts).
   */
  private async startHooks(ctx: AdapterContext): Promise<void> {
    const workspaceFolders = resolveWorkspaceFolders();
    if (workspaceFolders.length === 0) {
      ctx.reportHealth('hooks', 'no workspace folder open, hooks were not configured');
      return;
    }
    const folders = withRealPaths(workspaceFolders);
    try {
      const home = snagboatHome();
      pruneStaleRoutes(home);
      const scriptPath = installHookScript(home);
      const token = newToken();
      this.hooksReceiver = new HooksReceiver(ctx, { token, workspaceFolders: folders, turnFallback: (sessionId) => this.turns.latestTurnForSession(sessionId) });
      const port = await this.hooksReceiver.start();
      writeRoutes(home, folders, { port, token, pid: process.pid });
      this.routedFolders = folders;
      const command = buildHookCommand(scriptPath);
      for (const folder of workspaceFolders) await ensureHooksConfigured(folder, command);
      ctx.reportHealth('hooks', undefined);
    } catch (err) {
      ctx.reportHealth('hooks', `hook routing not set up: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    this.transcriptTailer?.stop();
    removeRoutes(snagboatHome(), this.routedFolders, process.pid);
    this.routedFolders = [];
    this.hooksReceiver?.stop();
  }

  private persistCheckpoint(): void {
    const state: CheckpointStateV2 = {
      version: 2,
      offsets: Object.fromEntries(this.offsets),
      recentMessageIds: this.seen.snapshot(),
      lastTurnByFile: this.turns.snapshot(),
    };
    void this.ctx?.writeCheckpoint({ updatedAt: new Date().toISOString(), state: { ...state } });
  }
}
