import { AgentAdapter, AdapterContext } from '@snagboat/schema';
import { buildHookCommand, ensureHooksConfigured } from './hooksConfig';
import { hooksEnabledFor, onHooksSettingChanged, onWorkspaceFoldersChanged, resolveWorkspaceFolders } from './workspace';
import { installHookScript, snagboatHome } from './hookRoutes';

/**
 * Claude Code in a VS Code window. The core reads every project's transcripts
 * and receives the hooks (core/service/claudeCollector.ts, hooks.ts); the
 * window only installs the hook script and adds its hook entries to its
 * folders' .claude/settings.json, so the script sends them to the core
 * (core.route). It publishes no events of its own.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId = 'claude-code' as const;

  private ctx?: AdapterContext;
  private hookCommand?: string;
  private hookFolders: string[] = [];
  private folderWatch?: { dispose(): void };
  private settingWatch?: { dispose(): void };
  private folderUpdates: Promise<void> = Promise.resolve();

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    if (!this.ctx) throw new Error('ClaudeCodeAdapter.start() called before init()');
    await this.configureHooks();
    // A folder added to an open window gets its hooks without a reload.
    this.folderWatch = onWorkspaceFoldersChanged(() => {
      this.folderUpdates = this.folderUpdates.then(() => this.configureHooks());
    });
    this.settingWatch = onHooksSettingChanged(() => {
      this.folderUpdates = this.folderUpdates.then(() => this.configureEnabledFolders());
    });
  }

  /** The hook script and settings.json entries for each folder that wants them. A removed folder's entries stay. */
  private async configureHooks(): Promise<void> {
    try {
      const command = buildHookCommand(installHookScript(snagboatHome()));
      this.hookCommand = command;
      this.hookFolders = resolveWorkspaceFolders();
      for (const folder of this.hookFolders) if (hooksEnabledFor(folder)) await ensureHooksConfigured(folder, command);
      this.ctx?.reportHealth('hooks', undefined);
    } catch (err) {
      this.ctx?.reportHealth('hooks', `hooks not configured: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Adds hooks to folders where snagboat.claudeCode.configureHooks was turned back on. */
  private async configureEnabledFolders(): Promise<void> {
    const command = this.hookCommand;
    if (!command) return;
    try {
      for (const folder of this.hookFolders) if (hooksEnabledFor(folder)) await ensureHooksConfigured(folder, command);
    } catch (err) {
      this.ctx?.reportHealth('hooks', `hooks not added after a settings change: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    this.folderWatch?.dispose();
    this.settingWatch?.dispose();
  }
}
