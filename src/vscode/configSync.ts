import * as vscode from 'vscode';
import { loadConfig, saveConfig, withVsCodeSettings } from '../core/config';
import { snagboatHome } from '../core/userStore';

/**
 * With the per-user store on, VS Code's Snagboat settings are copied into
 * ~/.snagboat/config.json (core/config.ts), where the core and the CLI read
 * them: User settings become its defaults, and this window's workspace and
 * folder settings become its folders' project entries. Copied on activation
 * and whenever a Snagboat setting changes. Only settings someone set are
 * copied, so a built-in default isn't frozen into the file.
 */
export function syncSettingsToConfig(context: vscode.ExtensionContext): vscode.Disposable {
  const keys = settingKeys(context);
  const sync = () => {
    try {
      const user: Record<string, unknown> = {};
      const projects: Record<string, Record<string, unknown>> = {};
      const root = vscode.workspace.getConfiguration('snagboat');
      for (const key of keys) {
        const value = root.inspect(key)?.globalValue;
        if (value !== undefined) user[key] = value;
      }
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const scoped = vscode.workspace.getConfiguration('snagboat', folder.uri);
        const entry: Record<string, unknown> = {};
        for (const key of keys) {
          const info = scoped.inspect(key);
          const value = info?.workspaceFolderValue ?? info?.workspaceValue;
          if (value !== undefined) entry[key] = value;
        }
        projects[folder.uri.fsPath] = entry;
      }
      const home = snagboatHome();
      saveConfig(home, withVsCodeSettings(loadConfig(home).config, keys, user, projects));
    } catch (err) {
      console.error('snagboat: failed to copy settings to ~/.snagboat/config.json', err);
    }
  };
  sync();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('snagboat') && sync()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sync())
  );
}

/** Every Snagboat setting this extension declares, without the `snagboat.` prefix. */
function settingKeys(context: vscode.ExtensionContext): string[] {
  const configuration = (context.extension.packageJSON as { contributes?: { configuration?: unknown } }).contributes?.configuration;
  const sections = (Array.isArray(configuration) ? configuration : [configuration]) as Array<{ properties?: Record<string, unknown> }>;
  return sections.flatMap((s) => Object.keys(s?.properties ?? {})).filter((k) => k.startsWith('snagboat.')).map((k) => k.slice('snagboat.'.length));
}
