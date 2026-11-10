import * as vscode from 'vscode';
import { Host } from '../core/host';

/** The engine's Host, backed by the VS Code API. Each method makes the same call the engine made directly before step 2. */
export const vscodeHost: Host = {
  section: (section) => ({ ...vscode.workspace.getConfiguration(section) }),
  get: <T>(section: string, key: string, fallback: T, scope?: string): T =>
    vscode.workspace.getConfiguration(section, scope === undefined ? undefined : vscode.Uri.file(scope)).get<T>(key, fallback),
  workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  onWorkspaceFoldersChanged: (listener) => vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
  onSettingChanged: (fullKey, listener) =>
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(fullKey)) listener();
    }),
};
