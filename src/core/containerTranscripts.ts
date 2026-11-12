import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptGuard } from '../adapters/claude-code/transcriptTail';
import { isWithinFolders } from './paths';
import { userDataDir } from './userStore';

/**
 * Dev container transcripts (bead snagboat-xe5). A dev container bind-mounts
 * its ~/.claude/projects to <project folder>/.snagboat/claude-projects/ on the
 * host, and mounts the project at the same path as on the host, so its
 * transcripts' cwd is already a host path. Nothing Snagboat runs in the
 * container: the core here reads that folder as it reads ~/.claude/projects,
 * only for folders allowed in ~/.snagboat/config.json ("containers": {"allow": [...]}).
 *
 * The folder is written by agents in the container, possibly with their
 * permissions off, so it's untrusted:
 *   - no symlinks from the allowed folder down to each project folder, session
 *     folder, subagents folder and transcript (each is lstat'ed; a transcript is
 *     opened with O_NOFOLLOW, must be a regular file, and the path is checked
 *     again after opening);
 *   - lines over CONTAINER_MAX_LINE_BYTES are skipped; only Claude Code's
 *     transcript layout is read (memory/ and the like are ignored);
 *   - a transcript's project is its cwd only when that's inside the allowed
 *     folder; any other cwd is the allowed folder itself (containerProjectFor);
 *   - counts and paths are logged, never contents.
 */

/** Where a container's ~/.claude/projects is mounted inside an allowed folder, one segment each. */
export const CONTAINER_PROJECTS_SEGMENTS: readonly string[] = ['.snagboat', 'claude-projects'];
/** The longest transcript line read from a container; longer ones are skipped. */
export const CONTAINER_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** <folder>/.snagboat/claude-projects */
export function containerProjectsDir(folder: string): string {
  return path.join(folder, ...CONTAINER_PROJECTS_SEGMENTS);
}

/** The checkpoint id prefix for an allowed folder's projects: its own, apart from ~/.claude/projects' "claude-code-". */
export function containerCheckpointPrefix(folder: string): string {
  return `container-${crypto.createHash('sha256').update(folder).digest('hex').slice(0, 12)}-`;
}

/**
 * The project folder a container transcript is filed under: its cwd when that's
 * the allowed folder or inside it (then resolved like any project); anything
 * else (a /workspaces/<name> path from before the same-path mount, say) is the
 * allowed folder itself.
 */
export function containerProjectFor(folder: string, cwd: string): string {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) return folder;
  const resolved = path.resolve(cwd);
  return isWithinFolders(resolved, [folder]) ? resolved : folder;
}

export type ChainResult = { ok: true; stat: fs.Stats } | { ok: false; missing: boolean; problem: string };

/**
 * lstat's the allowed folder and each folder below it on the way to target:
 * every one must be a real directory, and target itself a directory or (last:
 * 'file') a regular file. target must be the folder or inside it.
 */
export function lstatChain(folder: string, target: string, last: 'dir' | 'file'): ChainResult {
  const rel = path.relative(folder, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, missing: false, problem: `${target} isn't inside ${folder}` };
  const parts = rel === '' ? [] : rel.split(path.sep);
  let current = folder;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? { ok: false, missing: true, problem: `${current} doesn't exist` } : { ok: false, missing: false, problem: `${current} can't be read (${code ?? 'error'})` };
    }
    if (st.isSymbolicLink()) return { ok: false, missing: false, problem: `${current} is a symlink` };
    const isLast = i === parts.length - 1;
    if (isLast && last === 'file') {
      if (!st.isFile()) return { ok: false, missing: false, problem: `${current} isn't a regular file` };
    } else if (!st.isDirectory()) return { ok: false, missing: false, problem: `${current} isn't a directory` };
    if (isLast) return { ok: true, stat: st };
  }
  throw new Error('unreachable');
}

const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;

/**
 * Opens a file below an allowed folder without following symlinks: the path is
 * lstat'ed down from the folder, the file opened with O_NOFOLLOW (and
 * O_NONBLOCK, so a FIFO can't hang it), and both checked again after: the same
 * regular file, still reached without symlinks.
 */
export function openBelow(folder: string, file: string): { fd: number } | { missing: boolean; problem: string } {
  const before = lstatChain(folder, file, 'file');
  if (!before.ok) return before;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { missing: code === 'ENOENT', problem: `${file} can't be opened (${code ?? 'error'})` };
  }
  try {
    const opened = fs.fstatSync(fd);
    const after = lstatChain(folder, file, 'file');
    if (opened.isFile() && sameFile(opened, before.stat) && after.ok && sameFile(after.stat, opened)) return { fd };
  } catch {
    // fall through: refused
  }
  fs.closeSync(fd);
  return { missing: false, problem: `${file} changed while it was opened` };
}

/**
 * The guard a collector reads an allowed folder's container transcripts
 * through. Each refused path is logged once (and again if it comes back after
 * being fixed); a missing one is not logged.
 */
export function containerGuard(folder: string, log: (line: string) => void): TranscriptGuard & { skippedLines(): number } {
  const refused = new Set<string>();
  let skipped = 0;
  const note = (p: string, result: { ok: true } | { ok?: false; missing: boolean; problem: string }) => {
    if ('problem' in result && !result.missing) {
      if (!refused.has(p)) log(`containers: refused ${result.problem}`);
      refused.add(p);
    } else refused.delete(p);
  };
  return {
    isDir(dir) {
      const result = lstatChain(folder, dir, 'dir');
      note(dir, result);
      return result.ok;
    },
    open(file) {
      const result = openBelow(folder, file);
      if ('fd' in result) {
        note(file, { ok: true });
        return result.fd;
      }
      note(file, result);
      return undefined;
    },
    maxLineBytes: CONTAINER_MAX_LINE_BYTES,
    onSkippedLine(file) {
      skipped += 1;
      log(`containers: skipped a line longer than ${CONTAINER_MAX_LINE_BYTES} bytes in ${file} (${skipped} so far)`);
    },
    skippedLines: () => skipped,
  };
}

export interface ContainerProjectsScan {
  /** <folder>/.snagboat/claude-projects */
  projectsDir: string;
  /** Whether it's there (as a real folder, reached without symlinks). */
  exists: boolean;
  /** Project folders in it. */
  projects: number;
  /** Session transcripts (<project>/<session>.jsonl) in them; subagents' aren't counted. */
  sessions: number;
  /** Why it can't be read, when it's there but refused. */
  problem?: string;
}

/** What's in an allowed folder's claude-projects, for `snagboat containers status`. Reads names only, never contents. */
export function scanContainerProjects(folder: string): ContainerProjectsScan {
  const projectsDir = containerProjectsDir(folder);
  const scan: ContainerProjectsScan = { projectsDir, exists: false, projects: 0, sessions: 0 };
  const chain = lstatChain(folder, projectsDir, 'dir');
  if (!chain.ok) {
    if (!chain.missing) scan.problem = chain.problem;
    return scan;
  }
  scan.exists = true;
  let names: string[];
  try {
    names = fs.readdirSync(projectsDir);
  } catch (err) {
    scan.problem = `${projectsDir} can't be listed (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
    return scan;
  }
  for (const name of names) {
    const dir = path.join(projectsDir, name);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      scan.projects += 1;
      for (const file of fs.readdirSync(dir)) if (file.endsWith('.jsonl') && fs.lstatSync(path.join(dir, file)).isFile()) scan.sessions += 1;
    } catch {
      // gone mid-scan
    }
  }
  return scan;
}

/** When the core last read events from each allowed folder: ~/.snagboat/data/core/container-status.json. */
export interface ContainerFolderStatus {
  lastReadAt: string;
  /** Events read since this file was started. */
  events: number;
}

export function containerStatusPath(home: string): string {
  return path.join(userDataDir(home), 'core', 'container-status.json');
}

export function readContainerStatus(home: string): Record<string, ContainerFolderStatus> {
  try {
    const raw = JSON.parse(fs.readFileSync(containerStatusPath(home), 'utf8')) as { folders?: Record<string, ContainerFolderStatus> };
    return raw.folders && typeof raw.folders === 'object' ? raw.folders : {};
  } catch {
    return {};
  }
}

export function saveContainerStatus(home: string, folders: Record<string, ContainerFolderStatus>): void {
  const file = containerStatusPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, folders }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
