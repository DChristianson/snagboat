import * as vscode from 'vscode';

/** Test/CI seam: override the project root instead of using the open VS Code workspace folder. */
export function resolveProjectDir(): string | undefined {
  if (process.env.SNAGBOAT_CLAUDE_PROJECT_DIR) {
    return process.env.SNAGBOAT_CLAUDE_PROJECT_DIR;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-');
}
