import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Test/CI seam: override the project root instead of using the open VS Code workspace folder. */
export function resolveProjectDir(): string | undefined {
  if (process.env.SNAGBOAT_CLAUDE_PROJECT_DIR) {
    return process.env.SNAGBOAT_CLAUDE_PROJECT_DIR;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Every workspace folder in this window (hooks are routed to each). */
export function resolveWorkspaceFolders(): string[] {
  if (process.env.SNAGBOAT_CLAUDE_PROJECT_DIR) {
    return [process.env.SNAGBOAT_CLAUDE_PROJECT_DIR];
  }
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-');
}

/** Test/CI seam: override where transcripts are read from instead of the real ~/.claude. */
export function resolveTranscriptsDir(): string | undefined {
  if (process.env.SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR) {
    return process.env.SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR;
  }
  const cwd = resolveProjectDir();
  if (!cwd) return undefined;
  return path.join(os.homedir(), '.claude', 'projects', sanitizeCwd(cwd));
}
