import { host, HostDisposable } from '../../core/host';

/** Every workspace folder in this window (hooks are routed to each). */
export function resolveWorkspaceFolders(): string[] {
  if (process.env.SNAGBOAT_CLAUDE_PROJECT_DIR) {
    return [process.env.SNAGBOAT_CLAUDE_PROJECT_DIR];
  }
  return host().workspaceFolders();
}

/** Calls back when workspace folders are added or removed. Never under the test override, whose folder is fixed. */
export function onWorkspaceFoldersChanged(listener: () => void): HostDisposable {
  if (process.env.SNAGBOAT_CLAUDE_PROJECT_DIR) return { dispose: () => undefined };
  return host().onWorkspaceFoldersChanged(listener);
}

/** Calls back when snagboat.claudeCode.configureHooks changes for any folder. */
export function onHooksSettingChanged(listener: () => void): HostDisposable {
  return host().onSettingChanged('snagboat.claudeCode.configureHooks', listener);
}

/** Whether Snagboat should add its hooks to this folder's .claude/settings.json (snagboat.claudeCode.configureHooks). */
export function hooksEnabledFor(folder: string): boolean {
  if (process.env.SNAGBOAT_CLAUDE_PROJECT_DIR) return true;
  return host().get<boolean>('snagboat', 'claudeCode.configureHooks', true, folder);
}

export function sanitizeCwd(cwd: string): string {
  // Claude Code names a project's transcript folder after its path, separators (and a Windows drive's colon) as dashes.
  return cwd.replace(/[\\/:]/g, '-');
}
