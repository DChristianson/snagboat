import * as fs from 'fs';
import * as vscode from 'vscode';
import { WORKSPACE_NO_FOLDER } from '@snagboat/schema';
import { migrate } from '../core/migrate';
import { openWorkspaceStore, snagboatHome, userDataDir, WorkspaceInfo, workspaceOfVsCodeStore } from '../core/userStore';

/** Where this window keeps its data. */
export interface StorageLocations {
  /** This workspace's events, aggregates, checkpoints and finding responses. */
  storageDir: string;
  /** Shared by every workspace: context limits, the advisor audit log, Copilot structure captures. */
  sharedDir: string;
  /** Where rules.json is. */
  rulesDir: string;
  /** Set with the per-user store: the NormalizedEvent.workspace this window's events get. */
  workspace?: string;
  perUser: boolean;
}

export const PER_USER_STORE_SETTING = 'snagboat.storage.perUserStore';

function thisWorkspace(legacyDir: string, global: boolean): WorkspaceInfo {
  const fromStorage = workspaceOfVsCodeStore(legacyDir, global);
  if (fromStorage) return fromStorage;
  const file = vscode.workspace.workspaceFile;
  if (file?.scheme === 'file') return { workspace: file.fsPath, workspaceFile: file.fsPath };
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ? { workspace: folder, folder } : { workspace: WORKSPACE_NO_FOLDER };
}

/**
 * VS Code's per-window storage, or with snagboat.storage.perUserStore on, this
 * workspace's folder in the per-user store (~/.snagboat/data). Turning it on
 * first copies this window's existing storage there (core/migrate.ts: copy
 * only, so turning it off again finds the old storage as it was). If that copy
 * fails, the window stays on its old storage and says so.
 */
export async function resolveStorage(context: vscode.ExtensionContext): Promise<StorageLocations> {
  const legacyUri = context.storageUri ?? context.globalStorageUri;
  await vscode.workspace.fs.createDirectory(legacyUri);
  const legacy: StorageLocations = {
    storageDir: legacyUri.fsPath,
    sharedDir: context.globalStorageUri.fsPath,
    rulesDir: context.globalStorageUri.fsPath,
    perUser: false,
  };
  if (!vscode.workspace.getConfiguration('snagboat').get<boolean>('storage.perUserStore', false)) return legacy;

  const home = snagboatHome();
  const info = thisWorkspace(legacy.storageDir, !context.storageUri);
  try {
    await fs.promises.mkdir(userDataDir(home), { recursive: true });
    await migrate([{ dir: legacy.storageDir, label: 'this window', info }], [context.globalStorageUri.fsPath], home);
    const storageDir = await openWorkspaceStore(home, info);
    return { storageDir, sharedDir: userDataDir(home), rulesDir: home, workspace: info.workspace, perUser: true };
  } catch (err) {
    console.error('snagboat: per-user store unavailable', err);
    void vscode.window.showWarningMessage(
      `Snagboat: couldn't set up the per-user store in ${home}, so this window keeps using VS Code's storage: ${err instanceof Error ? err.message : String(err)}`
    );
    return legacy;
  }
}

/** The setting takes effect on reload: offers one when it changes. */
export function watchPerUserStoreSetting(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(PER_USER_STORE_SETTING)) return;
    void vscode.window
      .showInformationMessage('Snagboat: the storage setting changes when the window reloads.', 'Reload Window')
      .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
  });
}
