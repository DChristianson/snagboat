import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exportProject, findProjectRoot } from '../core/exportProject';
import { snagboatHome } from '../core/userStore';

/**
 * Snagboat: Export Project... (docs/design/export.md, "The command"): `snagboat export` for a
 * workspace folder, in-process (core/exportProject.ts, the same function the CLI calls). It asks
 * for the folder to export into and opens the review file when anything was flagged. Everything
 * else (selection, privacy rules, the final check, where --out may be) is the core's.
 */
export function registerExportProject(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('snagboat.exportProject', async () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('Snagboat: open a folder on this machine to export its project.');
      return;
    }
    const folder =
      folders.length === 1
        ? folders[0]
        : (await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), { placeHolder: 'Export which project?' }))?.f;
    if (!folder) return;
    const project = findProjectRoot(folder.uri.fsPath);
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Export Here',
      title: `Export ${path.basename(project)}: choose a folder outside the project`,
    });
    if (!picked || picked.length === 0) return;
    // An empty folder or an earlier export is the export; any other folder gets a new one inside it.
    const chosen = picked[0].fsPath;
    const usable = fs.readdirSync(chosen).length === 0 || fs.existsSync(path.join(chosen, 'manifest.json'));
    const out = usable ? chosen : path.join(chosen, `${path.basename(project)}-snagboat-export`);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Snagboat: exporting ${path.basename(project)}...` }, () =>
      exportProject({ home: snagboatHome(), project, out, version: String(context.extension.packageJSON.version ?? 'dev') }).catch((err: unknown) => ({
        ok: false as const,
        reason: 'refused' as const,
        message: err instanceof Error ? err.message : String(err),
        notes: [],
      }))
    );
    if (!result.ok) {
      void vscode.window.showErrorMessage(`Snagboat: nothing exported. ${result.message}`, { modal: result.reason === 'final-check' });
      return;
    }
    const c = result.manifest.counts;
    const summary = `Snagboat: exported ${c.sessions} sessions, ${c.events} events, ${c.commits} commits and ${c.planItems} plan items to ${out}.`;
    if (result.reviewFile && result.manifest.flags > 0) {
      await vscode.window.showTextDocument(vscode.Uri.file(result.reviewFile), { preview: false });
      void vscode.window.showWarningMessage(
        `${summary} ${result.manifest.flags} value${result.manifest.flags === 1 ? ' was' : 's were'} flagged and replaced with [flagged-N]; the review file beside the export lists them. \`snagboat export --allow flagged-N\` puts one back.`
      );
      return;
    }
    const reveal = await vscode.window.showInformationMessage(summary, 'Reveal');
    if (reveal) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
  });
}
