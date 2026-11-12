import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdapterContext, NormalizedEvent } from '@snagboat/schema';
import { TranscriptGuard, TranscriptTailer } from '../../adapters/claude-code/transcriptTail';
import { readCheckpointState, CheckpointStateV2 } from '../../adapters/claude-code/checkpointState';
import { sanitizeCwd } from '../../adapters/claude-code/workspace';
import { CheckpointStore } from '../checkpointStore';
import { keepCheckpointEntry } from '../paths';

/**
 * Claude Code transcripts for every project on the machine, read by the core
 * (3c-3b): each folder under ~/.claude/projects is one project, tailed with the
 * same TranscriptTailer a VS Code window uses, with its own checkpoint in
 * data/core/checkpoints/ (separate from any window's, so the two never fight
 * over read positions; the same events read twice share their eventIds).
 *
 * A transcript folder is named after the folder the session started in, with
 * separators as dashes, which can't be reversed; the project is the `cwd` a
 * transcript's own lines report whose name matches the folder's. Until a line
 * with a cwd appears the folder is left alone and looked at again later.
 */

/** How often new project folders, and folders with no cwd yet, are looked for; folders already read are skipped cheaply. */
export const PROJECTS_DISCOVERY_INTERVAL_MS = 5_000;

export interface ClaudeCollectorOptions {
  /** ~/.claude/projects, or SNAGBOAT_CLAUDE_PROJECTS_DIR. */
  projectsDir: string;
  checkpoints: CheckpointStore;
  /** The workspace to record a project's events under; undefined to not record them (core/service/workspaces.ts). */
  workspaceFor: (projectDir: string) => string | undefined;
  /** Whether to keep captured text for a project (its captureContent setting). */
  captureContent: (projectDir: string) => boolean;
  /** Receives each batch of events, each with its workspace set, plus the project folder they came from. */
  deliver: (events: NormalizedEvent[], projectDir: string) => Promise<unknown>;
  log?: (line: string) => void;
  discoveryIntervalMs?: number;
  /**
   * For a projects folder that can't be trusted (a dev container's,
   * core/containerTranscripts.ts): every folder and transcript is checked and
   * opened through this, and the lines read are capped.
   */
  guard?: TranscriptGuard;
  /** Maps the cwd a transcript folder's lines report to the project it's filed under (default: itself). */
  projectFor?: (cwd: string) => string;
  /** Prefix of each project's checkpoint id; default "claude-code-". */
  checkpointPrefix?: string;
}

export function defaultProjectsDir(): string {
  return process.env.SNAGBOAT_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The folder a transcript folder belongs to: a cwd from its lines whose sanitized name is the folder's; else the first cwd seen.
 * open: how to open a transcript (TranscriptGuard.open for an untrusted folder; undefined refuses it).
 */
export function projectDirOf(transcriptsDir: string, open?: (file: string) => number | undefined): string | undefined {
  const name = path.basename(transcriptsDir);
  let first: string | undefined;
  let files: string[];
  try {
    const stat = open ? fs.lstatSync : fs.statSync;
    files = fs
      .readdirSync(transcriptsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(transcriptsDir, f))
      .sort((a, b) => stat(b).mtimeMs - stat(a).mtimeMs);
  } catch {
    return undefined;
  }
  for (const file of files.slice(0, 5)) {
    let text: string;
    try {
      // The first 64 KB is plenty: cwd appears within the first few lines.
      const fd = open ? open(file) : fs.openSync(file, 'r');
      if (fd === undefined) continue;
      const buffer = Buffer.alloc(64 * 1024);
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      text = buffer.subarray(0, read).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(0, 200)) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd !== 'string' || !cwd) continue;
        if (sanitizeCwd(cwd) === name) return cwd;
        first ??= cwd;
      } catch {
        // a partial last line of the 64 KB read
      }
    }
  }
  return first;
}

interface Project {
  projectDir: string;
  tailer: TranscriptTailer;
}

export class ClaudeCollector {
  private readonly projects = new Map<string, Project>();
  private discovery?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly opts: ClaudeCollectorOptions) {}

  async start(): Promise<void> {
    await this.discover();
    this.discovery = setInterval(() => void this.discover(), this.opts.discoveryIntervalMs ?? PROJECTS_DISCOVERY_INTERVAL_MS);
    this.discovery.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.discovery);
    for (const p of this.projects.values()) p.tailer.stop();
    this.projects.clear();
  }

  /** Projects being read, by transcript folder. */
  watched(): Map<string, string> {
    return new Map([...this.projects].map(([dir, p]) => [dir, p.projectDir]));
  }

  private async discover(): Promise<void> {
    const guard = this.opts.guard;
    if (guard && !guard.isDir(this.opts.projectsDir)) return;
    let names: string[];
    try {
      names = fs.readdirSync(this.opts.projectsDir);
    } catch {
      return; // no Claude Code projects yet
    }
    for (const name of names) {
      if (this.stopped) return;
      const transcriptsDir = path.join(this.opts.projectsDir, name);
      if (this.projects.has(transcriptsDir)) continue;
      if (guard) {
        if (!guard.isDir(transcriptsDir)) continue;
      } else {
        try {
          if (!fs.statSync(transcriptsDir).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      const cwd = projectDirOf(transcriptsDir, guard && ((file) => guard.open(file)));
      if (!cwd) continue;
      const projectDir = this.opts.projectFor ? this.opts.projectFor(cwd) : cwd;
      try {
        await this.startProject(transcriptsDir, projectDir);
      } catch (err) {
        this.opts.log?.(`couldn't start reading ${transcriptsDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async startProject(transcriptsDir: string, projectDir: string): Promise<void> {
    const checkpointId = `${this.opts.checkpointPrefix ?? 'claude-code-'}${path.basename(transcriptsDir)}`;
    const checkpoint = await this.opts.checkpoints.read(checkpointId);
    const { offsets, seen, turns } = readCheckpointState(checkpoint?.state, keepCheckpointEntry(transcriptsDir));
    const pending: NormalizedEvent[] = [];
    let flushing = false;
    const flush = () => {
      if (flushing || pending.length === 0) return;
      flushing = true;
      setImmediate(() => {
        const batch = pending.splice(0);
        flushing = false;
        const workspace = this.opts.workspaceFor(projectDir);
        if (!workspace) return; // not recorded (collect: false, or an unopened project with collect.unopened off)
        this.opts.deliver(batch.map((e) => ({ ...e, workspace })), projectDir).catch((err) => this.opts.log?.(`couldn't record events from ${projectDir}: ${err instanceof Error ? err.message : String(err)}`));
      });
    };
    const ctx: AdapterContext = {
      publish: (event) => {
        pending.push(event);
        flush();
      },
      readCheckpoint: async () => checkpoint,
      // A failed write is logged, never thrown: an unhandled rejection would stop the whole core.
      writeCheckpoint: (cp) =>
        this.opts.checkpoints.write(checkpointId, cp).catch((err) => this.opts.log?.(`couldn't save the read position for ${projectDir}: ${err instanceof Error ? err.message : String(err)}`)),
      reportHealth: (key, message) => message && this.opts.log?.(`${projectDir}: ${message}`),
      captureContent: () => this.opts.captureContent(projectDir),
    };
    const persist = () => {
      const state: CheckpointStateV2 = { version: 2, offsets: Object.fromEntries(offsets), recentMessageIds: seen.snapshot(), lastTurnByFile: turns.snapshot() };
      void ctx.writeCheckpoint({ updatedAt: new Date().toISOString(), state: { ...state } });
    };
    const tailer = new TranscriptTailer(ctx, transcriptsDir, offsets, seen, persist, undefined, { turns, guard: this.opts.guard });
    this.projects.set(transcriptsDir, { projectDir, tailer });
    tailer.start();
  }
}
