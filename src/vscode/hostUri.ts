import * as vscode from 'vscode';
import { hostFileRef } from './hostFiles';

/** VS Code's scheme for the host's own disk in a remote window. */
const HOST_SCHEME = 'vscode-local';

/** A URI that opens this host path in the current window, local or remote (see hostFiles.ts). */
export function hostFileUri(file: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const ref = hostFileRef(file, vscode.env.remoteName !== undefined, folders.map((f) => f.uri.fsPath));
  if (ref.kind === 'folder') return vscode.Uri.joinPath(folders[ref.folder].uri, ...ref.relative);
  if (ref.kind === 'host') return vscode.Uri.file(file).with({ scheme: HOST_SCHEME });
  return vscode.Uri.file(file);
}
