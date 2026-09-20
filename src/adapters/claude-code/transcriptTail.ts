import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AdapterContext } from '../../core/types';
import { LineTailer } from '../../core/lineTailer';
import { normalizeTranscriptLine } from './normalize';

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-');
}

/** Test/CI seam: override where transcripts are read from instead of the real ~/.claude. */
export function resolveTranscriptsDir(): string | undefined {
  if (process.env.SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR) {
    return process.env.SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR;
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return undefined;
  return path.join(os.homedir(), '.claude', 'projects', sanitizeCwd(cwd));
}

export class TranscriptTailer {
  private tailer?: LineTailer;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly offsets: Map<string, number>,
    private readonly persistCheckpoint: () => void
  ) {}

  start(): void {
    const dir = resolveTranscriptsDir();
    if (!dir) {
      console.warn('snagboat: no workspace folder open, claude-code transcript tailing disabled');
      return;
    }
    if (!fs.existsSync(dir)) {
      console.warn(
        `snagboat: no Claude Code transcripts directory found at ${dir} yet (no session recorded for this workspace path) — will pick up files if one appears`
      );
    }
    this.tailer = new LineTailer({
      glob: path.join(dir, '*.jsonl'),
      getOffset: (filePath) => this.offsets.get(filePath) ?? 0,
      setOffset: (filePath, offset) => {
        this.offsets.set(filePath, offset);
        this.persistCheckpoint();
      },
      onLines: (filePath, lines, chunkStartOffset) => {
        for (const line of lines) {
          const event = normalizeTranscriptLine(line, filePath, chunkStartOffset);
          if (event) this.ctx.publish(event);
        }
      },
    });
    this.tailer.start();
  }

  stop(): void {
    this.tailer?.stop();
  }
}
