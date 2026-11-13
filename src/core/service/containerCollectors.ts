import * as fs from 'fs';
import { NormalizedEvent } from '@snagboat/schema';
import { CheckpointStore } from '../checkpointStore';
import { containersAllowed, loadConfig } from '../config';
import {
  containerCheckpointPrefix,
  containerGuard,
  containerProjectFor,
  containerProjectsDir,
  ContainerFolderStatus,
  containerStatusPath,
  readContainerStatus,
  saveContainerStatus,
} from '../containerTranscripts';
import { ClaudeCollector } from './claudeCollector';

/**
 * One ClaudeCollector per folder in config.json's containers.allow, reading
 * <folder>/.snagboat/claude-projects (core/containerTranscripts.ts) through a
 * guard, with checkpoints of its own. refresh() runs on the core's ingest tick:
 * it starts collectors for newly allowed folders and stops those no longer
 * allowed, so the list takes effect without restarting the core, and saves
 * when each folder was last read.
 */

export interface ContainerCollectorsOptions {
  home: string;
  checkpoints: CheckpointStore;
  /** The host's own projects folder (~/.claude/projects): never read again as a container's. */
  hostProjectsDir: string;
  workspaceFor: (projectDir: string) => string | undefined;
  captureContent: (projectDir: string) => boolean;
  deliver: (events: NormalizedEvent[], projectDir: string) => Promise<unknown>;
  log: (line: string) => void;
  discoveryIntervalMs?: number;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export class ContainerCollectors {
  private readonly collectors = new Map<string, ClaudeCollector>();
  /** Events read per folder since the last refresh, and when. */
  private readonly unsaved = new Map<string, { at: number; events: number }>();
  private refreshing?: Promise<void>;
  private stopped = false;

  constructor(private readonly opts: ContainerCollectorsOptions) {}

  /** Folders being read. */
  folders(): string[] {
    return [...this.collectors.keys()];
  }

  /** Brings the collectors in line with containers.allow, and saves the status of what was read since last time. */
  refresh(): Promise<void> {
    // One at a time: a tick that finds the last still starting collectors waits for it.
    this.refreshing = (this.refreshing ?? Promise.resolve()).then(() => this.doRefresh()).catch((err) => this.opts.log(`containers: ${err instanceof Error ? err.message : String(err)}`));
    return this.refreshing;
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.collectors.values()) c.stop();
    this.collectors.clear();
    this.saveStatus();
  }

  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    const allowed = new Set(containersAllowed(loadConfig(this.opts.home).config));
    for (const [folder, collector] of this.collectors) {
      if (allowed.has(folder)) continue;
      collector.stop();
      this.collectors.delete(folder);
      this.opts.log(`containers: stopped reading ${containerProjectsDir(folder)} (no longer allowed)`);
    }
    const host = realOrSelf(this.opts.hostProjectsDir);
    for (const folder of allowed) {
      if (this.collectors.has(folder) || this.stopped) continue;
      const projectsDir = containerProjectsDir(folder);
      if (realOrSelf(projectsDir) === host) {
        this.opts.log(`containers: ${projectsDir} is this machine's own Claude Code projects folder; not read twice`);
        continue;
      }
      const collector = new ClaudeCollector({
        projectsDir,
        checkpoints: this.opts.checkpoints,
        checkpointPrefix: containerCheckpointPrefix(folder),
        guard: containerGuard(folder, this.opts.log),
        projectFor: (cwd) => containerProjectFor(folder, cwd),
        workspaceFor: (projectDir) => this.opts.workspaceFor(projectDir),
        captureContent: (projectDir) => this.opts.captureContent(projectDir),
        deliver: (events, projectDir) => {
          const seen = this.unsaved.get(folder) ?? { at: 0, events: 0 };
          this.unsaved.set(folder, { at: Date.now(), events: seen.events + events.length });
          return this.opts.deliver(events, projectDir);
        },
        log: (line) => this.opts.log(`containers: ${line}`),
        discoveryIntervalMs: this.opts.discoveryIntervalMs,
      });
      this.collectors.set(folder, collector);
      this.opts.log(`containers: reading ${projectsDir}`);
      await collector.start();
    }
    this.saveStatus();
  }

  private saveStatus(): void {
    if (this.unsaved.size === 0) return;
    try {
      const status: Record<string, ContainerFolderStatus> = readContainerStatus(this.opts.home);
      for (const [folder, { at, events }] of this.unsaved) {
        status[folder] = { lastReadAt: new Date(at).toISOString(), events: (status[folder]?.events ?? 0) + events };
      }
      saveContainerStatus(this.opts.home, status);
      this.unsaved.clear();
    } catch (err) {
      this.opts.log(`containers: couldn't save ${containerStatusPath(this.opts.home)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
