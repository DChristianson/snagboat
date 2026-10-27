import { AgentAdapter, AdapterContext } from '../../core/types';
import { TranscriptTailer } from './transcriptTail';
import { HooksReceiver } from './hooksReceiver';
import { buildHookCommand, ensureHooksConfigured } from './hooksConfig';
import { withRealPaths } from '../../core/paths';
import { onWorkspaceFoldersChanged, resolveTranscriptsDir, resolveWorkspaceFolders } from './workspace';
import { installHookScript, newToken, pruneStaleRoutes, removeRoutes, Route, snagboatHome, updateRoutes, writeRoutes } from './hookRoutes';
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
  /** Set once hooks are routed: what a folder added later needs to be routed and configured. */
  private hookSetup?: { home: string; route: Route; command: string };
  private hookFolders: string[] = [];
  private folderWatch?: { dispose(): void };
  private folderUpdates: Promise<void> = Promise.resolve();

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
    this.folderWatch = onWorkspaceFoldersChanged(() => {
      this.folderUpdates = this.folderUpdates.then(() => this.updateHookFolders());
    });
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
      const route = { port, token, pid: process.pid };
      writeRoutes(home, folders, route);
      this.routedFolders = folders;
      const command = buildHookCommand(scriptPath);
      this.hookSetup = { home, route, command };
      this.hookFolders = workspaceFolders;
      for (const folder of workspaceFolders) await ensureHooksConfigured(folder, command);
      ctx.reportHealth('hooks', undefined);
    } catch (err) {
      ctx.reportHealth('hooks', `hook routing not set up: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Re-routes hooks when workspace folders are added or removed, so a folder
   * added to an open window gets its hooks without a reload. A removed
   * folder's .claude/settings.json keeps its hook entry, which another window
   * may still be using.
   */
  private async updateHookFolders(): Promise<void> {
    if (!this.ctx) return;
    if (!this.hookSetup) {
      // No folder was open at activation, so hooks were never set up.
      if (!this.hooksReceiver) await this.startHooks(this.ctx);
      return;
    }
    const { home, route, command } = this.hookSetup;
    const workspaceFolders = resolveWorkspaceFolders();
    const folders = withRealPaths(workspaceFolders);
    try {
      this.hooksReceiver?.setWorkspaceFolders(folders);
      updateRoutes(home, this.routedFolders, folders, route);
      this.routedFolders = folders;
      const added = workspaceFolders.filter((f) => !this.hookFolders.includes(f));
      this.hookFolders = workspaceFolders;
      for (const folder of added) await ensureHooksConfigured(folder, command);
      this.ctx.reportHealth('hooks', undefined);
    } catch (err) {
      this.ctx.reportHealth('hooks', `hook routing not updated for changed folders: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    this.folderWatch?.dispose();
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
