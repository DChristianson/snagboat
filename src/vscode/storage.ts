import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WORKSPACE_NO_FOLDER } from '@snagboat/schema';
import { migrate } from '../core/migrate';
import { claimWorkspace, releaseClaim } from '../core/service/claims';
import { CoreClient } from '../core/service/client';
import { chooseWorkspace, openWorkspaceStore, snagboatHome, userDataDir, WORKSPACE_MARKER, WorkspaceInfo, WorkspaceMarker, workspaceOfVsCodeStore } from '../core/userStore';

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
  /** Per-user store: gives up this window's claim on its workspace's folder (core/service/claims.ts). */
  release?: () => void;
  /**
   * Per-user store with the core running (3c-3c): the core collects and writes
   * this workspace's folder, and this window follows it. Unset when the window
   * writes the folder itself (the setting off, or the core couldn't start).
   */
  core?: CoreClient;
}

export const PER_USER_STORE_SETTING = 'snagboat.storage.perUserStore';

function thisWorkspace(legacyDir: string, global: boolean): WorkspaceInfo {
  const fromStorage = workspaceOfVsCodeStore(legacyDir, global);
  // A remote window's storage names it by a URI: then only paths on this disk count (chooseWorkspace).
  return chooseWorkspace(fromStorage, windowWorkspace(fromStorage !== undefined));
}

/** A folder or file URI as a path on this disk: a file: URI, or in a remote window one whose path exists here too. */
function onThisDisk(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') return uri.fsPath;
  return vscode.env.remoteName !== undefined && fs.existsSync(uri.fsPath) ? uri.fsPath : undefined;
}

/**
 * This window's workspace as plain paths: its saved .code-workspace file, else
 * its first folder. With onThisDiskOnly, only paths that name files on this
 * disk (see onThisDisk).
 */
function windowWorkspace(onThisDiskOnly = false): WorkspaceMarker | undefined {
  const file = vscode.workspace.workspaceFile;
  const workspaceFile = file && (onThisDiskOnly ? onThisDisk(file) : file.scheme === 'file' ? file.fsPath : undefined);
  if (workspaceFile) return { workspaceFile };
  const first = vscode.workspace.workspaceFolders?.[0]?.uri;
  const folder = first && (onThisDiskOnly ? onThisDisk(first) : first.fsPath);
  return folder ? { folder } : undefined;
}

/**
 * Writes snagboat-workspace.json (core/userStore.ts) in this window's VS Code
 * storage folder, so the CLI knows whose store it is even where VS Code writes
 * no workspace.json (its server). Only when missing or different; temp file
 * then rename, so a reader never sees half of it.
 */
async function writeWorkspaceMarker(storageDir: string): Promise<void> {
  const marker = windowWorkspace();
  if (!marker) return;
  const file = path.join(storageDir, WORKSPACE_MARKER);
  const text = JSON.stringify(marker, null, 2) + '\n';
  try {
    if ((await fs.promises.readFile(file, 'utf8').catch(() => undefined)) === text) return;
    const temp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, text, 'utf8');
    await fs.promises.rename(temp, file);
  } catch (err) {
    console.error("snagboat: couldn't write the workspace marker", err);
  }
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
  // In both modes: the CLI reads VS Code's stores either way.
  if (context.storageUri) await writeWorkspaceMarker(context.storageUri.fsPath);
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
    const perUser = { storageDir, sharedDir: userDataDir(home), rulesDir: home, workspace: info.workspace, perUser: true };
    try {
      // A saved multi-root workspace is named by its .code-workspace file; the core finds its projects by its folders.
      const folders = info.workspaceFile ? (vscode.workspace.workspaceFolders ?? []).flatMap((f) => onThisDisk(f.uri) ?? []) : undefined;
      const core = await CoreClient.connect({
        home,
        cliPath: path.join(context.extensionPath, 'dist', 'snagboat.js'),
        workspace: info.workspace,
        folders,
        log: (line) => console.log(`snagboat: ${line}`),
      });
      return { ...perUser, core };
    } catch (err) {
      console.error('snagboat: the core service could not start', err);
      void vscode.window.showWarningMessage(
        `Snagboat: the core service could not start, so this window collects and writes its own workspace for now: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // This window writes the folder itself, so the core leaves it alone (it spools instead) until released.
    claimWorkspace(storageDir);
    return { ...perUser, release: () => releaseClaim(storageDir) };
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
