import * as vscode from 'vscode';
import * as fs from 'fs';
import { externalChanges, loadConfig, saveConfig, SnagboatConfig, withVsCodeSettings } from '../core/config';
import { snagboatHome } from '../core/userStore';

/**
 * With the per-user store on, VS Code's Snagboat settings are copied into
 * ~/.snagboat/config.json (core/config.ts), where the core and the CLI read
 * them: User settings become its defaults, and this window's workspace and
 * folder settings become its folders' project entries. Copied on activation
 * and whenever a Snagboat setting changes. Only settings someone set are
 * copied, so a built-in default isn't frozen into the file. Changes made to
 * config.json elsewhere come back into VS Code's settings (pull, below).
 */
export function syncSettingsToConfig(context: vscode.ExtensionContext): vscode.Disposable {
  const keys = settingKeys(context);
  const home = snagboatHome();
  // What this window last wrote, to tell its own writes from changes made elsewhere.
  let lastWritten: SnagboatConfig | undefined;
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
      const next = withVsCodeSettings(loadConfig(home).config, keys, user, projects);
      saveConfig(home, next);
      lastWritten = next;
    } catch (err) {
      console.error('snagboat: failed to copy settings to ~/.snagboat/config.json', err);
    }
  };

  /**
   * config.json changed: settings someone changed elsewhere (a threshold applied in the advisor UI, RFC
   * step 5c-2, or an edit) are taken into this window's settings, so its next sync keeps them rather than
   * undoing them. Its own writes compare equal to what it last wrote and change nothing.
   */
  let pulling = false;
  const pull = async () => {
    if (!lastWritten || pulling) return;
    pulling = true;
    try {
      const now = loadConfig(home).config;
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const changes = externalChanges(lastWritten, now, keys, folders);
      lastWritten = now;
      for (const c of changes) {
        if (c.scope === 'user') await vscode.workspace.getConfiguration('snagboat').update(c.key, c.value, vscode.ConfigurationTarget.Global);
        else {
          const folder = c.scope.folder;
          const uri = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === folder)?.uri;
          if (uri) await vscode.workspace.getConfiguration('snagboat', uri).update(c.key, c.value, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      }
    } catch (err) {
      console.error('snagboat: failed to read ~/.snagboat/config.json', err);
    } finally {
      pulling = false;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    // The folder, not the file: config.json is replaced (written to a temp file and renamed) on each save.
    watcher = fs.watch(home, (_event, name) => {
      if (name && name !== 'config.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => void pull(), 200);
    });
  } catch {
    // No folder to watch yet: changes made elsewhere are taken at the next reload.
  }

  sync();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('snagboat') && sync()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sync()),
    { dispose: () => { clearTimeout(timer); watcher?.close(); } }
  );
}

/** Every Snagboat setting this extension declares, without the `snagboat.` prefix. */
function settingKeys(context: vscode.ExtensionContext): string[] {
  const configuration = (context.extension.packageJSON as { contributes?: { configuration?: unknown } }).contributes?.configuration;
  const sections = (Array.isArray(configuration) ? configuration : [configuration]) as Array<{ properties?: Record<string, unknown> }>;
  return sections.flatMap((s) => Object.keys(s?.properties ?? {})).filter((k) => k.startsWith('snagboat.')).map((k) => k.slice('snagboat.'.length));
}
