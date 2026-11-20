import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { migrate } from '../core/migrate';
import { CoreClient } from '../core/service/client';
import { chooseWorkspace, openWorkspaceStore, snagboatHome, userDataDir, WORKSPACE_MARKER, WorkspaceInfo, WorkspaceMarker, workspaceOfVsCodeStore } from '../core/userStore';

/**
 * Where this window's data is: its workspace's folder in the per-user store
 * (~/.snagboat/data), which the core collects and writes, and the core it
 * follows. The window keeps no store of its own.
 */
export interface StorageLocations {
  /** This workspace's events, aggregates, checkpoints and finding responses. */
  storageDir: string;
  /** Shared by every workspace: context limits, the advisor audit log, Copilot structure captures. */
  sharedDir: string;
  /** Where rules.json is. */
  rulesDir: string;
  /** The NormalizedEvent.workspace this window's events get. */
  workspace: string;
  /** The core collects and writes this workspace's folder, and this window follows it (3c-3c). */
  core: CoreClient;
  /** Why the core couldn't be reached at the start (the client keeps trying). */
  coreError?: string;
}

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
 * Writes snagboat-workspace.json (core/userStore.ts) in this window's old VS
 * Code storage folder, so the CLI (`snagboat migrate`, `--store vscode`) knows
 * whose store it is even where VS Code writes no workspace.json (its server).
 * Only for a store an earlier Snagboat left there, and only when missing or
 * different; temp file then rename, so a reader never sees half of it.
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
 * This workspace's folder in the per-user store, and the core that writes it.
 * Each start copies what an earlier Snagboat left in this window's VS Code
 * storage there (core/migrate.ts: copy only, the original is untouched, and
 * nothing new is copied once it's up to date). Throws if the per-user store
 * can't be set up; if the core can't start, the window says so and keeps
 * trying to reach one.
 */
export async function resolveStorage(context: vscode.ExtensionContext): Promise<StorageLocations> {
  // Where Snagboat kept this window's data before the per-user store; never written to now.
  const oldStore = (context.storageUri ?? context.globalStorageUri).fsPath;
  const hasOldStore = fs.existsSync(oldStore);
  if (hasOldStore && context.storageUri) await writeWorkspaceMarker(oldStore);

  const home = snagboatHome();
  const info = thisWorkspace(oldStore, !context.storageUri);
  await fs.promises.mkdir(userDataDir(home), { recursive: true });
  try {
    await migrate(hasOldStore ? [{ dir: oldStore, label: 'this window', info }] : [], [context.globalStorageUri.fsPath], home);
  } catch (err) {
    console.error("snagboat: couldn't copy this window's old data", err);
    void vscode.window.showWarningMessage(
      `Snagboat: couldn't copy this window's earlier data from VS Code's storage into ${userDataDir(home)} (the original is untouched; \`snagboat migrate\` copies it too): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const storageDir = await openWorkspaceStore(home, info);
  // A saved multi-root workspace is named by its .code-workspace file; the core finds its projects by its folders.
  const folders = info.workspaceFile ? (vscode.workspace.workspaceFolders ?? []).flatMap((f) => onThisDisk(f.uri) ?? []) : undefined;
  const { client: core, error } = await CoreClient.connectOrRetry({
    home,
    cliPath: path.join(context.extensionPath, 'dist', 'snagboat.js'),
    workspace: info.workspace,
    folders,
    log: (line) => console.log(`snagboat: ${line}`),
  });
  const coreError = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
  if (coreError !== undefined) {
    console.error('snagboat: the core service could not start', error);
    void vscode.window.showWarningMessage(`Snagboat: the core service could not start, so nothing new is recorded until it does (this window keeps trying): ${coreError}`);
  }
  return { storageDir, sharedDir: userDataDir(home), rulesDir: home, workspace: info.workspace, core, ...(coreError !== undefined ? { coreError } : {}) };
}

const DEFAULT_NOTICE_KEY = 'snagboat.perUserStoreDefaultNoticeShown';

/**
 * Says once, the first time a window starts on the per-user store, what that
 * means: data in ~/.snagboat/data, and the core recording every project on
 * this machine.
 */
export function noticePerUserStore(context: vscode.ExtensionContext): void {
  if (context.globalState.get<boolean>(DEFAULT_NOTICE_KEY)) return;
  void context.globalState.update(DEFAULT_NOTICE_KEY, true);
  void vscode.window
    .showInformationMessage(
      `Snagboat keeps its data in one per-user store, ${userDataDir(snagboatHome())}, and runs a core service that records Claude Code and Copilot CLI sessions in every project on this machine, not only folders open in VS Code. Any data already in VS Code's storage was copied there, and the originals are untouched. To record only projects VS Code knows, set "collect.unopened": false in ~/.snagboat/config.json.`,
      'Privacy'
    )
    .then((choice) => {
      if (choice === 'Privacy') void vscode.env.openExternal(vscode.Uri.parse('https://github.com/DChristianson/snagboat/blob/main/PRIVACY.md'));
    });
}
