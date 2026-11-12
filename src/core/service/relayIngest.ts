import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent, normalizedEventSchema } from '@snagboat/schema';
import { loadConfig, relayAllowed } from '../config';
import { withoutCapturedText } from '../excerpt';
import {
  isOutboxFileName,
  parseRelayInfo,
  RELAY_INFO_FILE,
  RELAY_MAX_FILE_BYTES,
  RELAY_MAX_INFO_BYTES,
  RELAY_MAX_LINE_BYTES,
  RELAY_OUTBOX_DIR,
  RELAY_SEGMENTS,
  RelayInfo,
} from '../relay';
import { userDataDir } from '../userStore';
import { StoreWriter } from './storeWriter';

/**
 * The host side of the dev container relay (core/relay.ts, bead snagboat-xe5).
 * On each ingest tick, for each folder in config.json's relay.allow, the core
 * reads <folder>/.snagboat/relay/outbox/*.jsonl, records the events under the
 * host's own workspaces, and deletes each file once its events are written.
 *
 * Everything in the relay folder was written by an agent in the container,
 * possibly with its permissions off, so it's untrusted:
 *   - no symlinks from the allowed folder down to each file (each component is
 *     lstat'ed, before and after opening; the file is opened with O_NOFOLLOW and
 *     must be the same regular file), and only names the writer uses;
 *   - files over RELAY_MAX_FILE_BYTES are deleted unread, lines over
 *     RELAY_MAX_LINE_BYTES and lines that aren't an event are skipped, and only
 *     the schema's fields are kept; counts are logged, never contents;
 *   - an event's workspace is used only to find its project inside the folder:
 *     a path under relay.json's root becomes the same path under the folder,
 *     and anything else is the folder itself. The project is then filed like
 *     any other (workspaces.ts), with its collect and captureContent settings.
 * The writer dedupes by eventId, so a file that fails part-way is read again
 * whole on the next tick without counting anything twice.
 */

export interface RelayIngestOptions {
  home: string;
  writer: StoreWriter;
  /** The workspace a host project folder is recorded under, or undefined when it isn't recorded (CoreService.workspaceFor). */
  workspaceFor: (projectDir: string) => string | undefined;
  /** Whether a host project folder keeps captured text. */
  captureContent: (projectDir: string) => boolean;
  log: (line: string) => void;
  /** Outbox files read per folder per tick; the rest wait for the next. Default 200. */
  maxFilesPerTick?: number;
  now?: () => number;
}

export interface RelayFolderResult {
  folder: string;
  /** Outbox files read and deleted. */
  files: number;
  /** Events read (valid lines). */
  events: number;
  written: number;
  duplicates: number;
  /** Lines that were too long or not an event. */
  skippedLines: number;
  /** Events of projects whose settings say not to record them. */
  notRecorded: number;
  /** Outbox entries refused: symlinks, not regular files, or too big (deleted). */
  refused: number;
  /** Why the folder wasn't read, if it wasn't. */
  problem?: string;
}

/** What `snagboat relay status` shows of the last ingest per folder: ~/.snagboat/data/core/relay-status.json. */
export interface RelayFolderStatus {
  lastIngestAt: string;
  files: number;
  events: number;
  written: number;
}

export function relayStatusPath(home: string): string {
  return path.join(userDataDir(home), 'core', 'relay-status.json');
}

export function readRelayStatus(home: string): Record<string, RelayFolderStatus> {
  try {
    const raw = JSON.parse(fs.readFileSync(relayStatusPath(home), 'utf8')) as { folders?: Record<string, RelayFolderStatus> };
    return raw.folders && typeof raw.folders === 'object' ? raw.folders : {};
  } catch {
    return {};
  }
}

function saveRelayStatus(home: string, folders: Record<string, RelayFolderStatus>): void {
  const file = relayStatusPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, folders }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** A path below an allowed folder that was refused or isn't there. */
type Refusal = { missing: true; problem: string } | { missing: false; problem: string };

const isRefusal = (v: unknown): v is Refusal => !!v && typeof v === 'object' && 'problem' in v;

/**
 * lstat's the allowed folder and each segment below it: every one must be a
 * real directory, and the last a regular file (or a directory, for `last:
 * 'dir'`). Returns the last one's stats.
 */
export async function lstatChain(folder: string, segments: readonly string[], last: 'dir' | 'file'): Promise<fs.Stats | Refusal> {
  let current = folder;
  const parts = ['', ...segments];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '') current = path.join(current, parts[i]);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? { missing: true, problem: `${current} doesn't exist` } : { missing: false, problem: `${current} can't be read (${code ?? 'error'})` };
    }
    if (st.isSymbolicLink()) return { missing: false, problem: `${current} is a symlink` };
    const isLast = i === parts.length - 1;
    if (isLast && last === 'file') {
      if (!st.isFile()) return { missing: false, problem: `${current} isn't a regular file` };
    } else if (!st.isDirectory()) return { missing: false, problem: `${current} isn't a directory` };
    if (isLast) return st;
  }
  throw new Error('unreachable');
}

const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;

/**
 * Reads a file below an allowed folder, refusing symlinks on the way and a
 * file bigger than maxBytes (tooBig). Returns its bytes and its stats (to
 * delete the same file later).
 */
export async function readBelow(folder: string, segments: readonly string[], maxBytes: number): Promise<{ data: Buffer; stat: fs.Stats } | (Refusal & { tooBig?: fs.Stats })> {
  const before = await lstatChain(folder, segments, 'file');
  if (isRefusal(before)) return before;
  const file = path.join(folder, ...segments);
  if (before.size > maxBytes) return { missing: false, problem: `${file} is larger than ${maxBytes} bytes`, tooBig: before };
  let handle: fs.promises.FileHandle;
  try {
    // O_NOFOLLOW: the file itself can't have become a symlink since; O_NONBLOCK: nor a FIFO that would hang the open.
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { missing: code === 'ENOENT', problem: `${file} can't be opened (${code ?? 'error'})` };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(opened, before)) return { missing: false, problem: `${file} changed while it was opened` };
    // The directories on the way are checked again: none became a symlink while the file was opened.
    const after = await lstatChain(folder, segments, 'file');
    if (isRefusal(after) || !sameFile(after, opened)) return { missing: false, problem: `${file} changed while it was opened` };
    if (opened.size > maxBytes) return { missing: false, problem: `${file} is larger than ${maxBytes} bytes`, tooBig: opened };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return { missing: false, problem: `${file} is larger than ${maxBytes} bytes`, tooBig: opened };
    }
    return { data: Buffer.concat(chunks), stat: opened };
  } finally {
    await handle.close();
  }
}

/** Deletes a file below an allowed folder, only if the path still leads, without symlinks, to the same file. */
async function removeBelow(folder: string, segments: readonly string[], stat: fs.Stats): Promise<boolean> {
  const now = await lstatChain(folder, segments, 'file');
  if (isRefusal(now) || !sameFile(now, stat)) return false;
  try {
    await fs.promises.unlink(path.join(folder, ...segments));
    return true;
  } catch {
    return false;
  }
}

/** relay.json of an allowed folder, or why it can't be used. */
export async function readRelayInfo(folder: string): Promise<RelayInfo | Refusal> {
  const read = await readBelow(folder, [...RELAY_SEGMENTS, RELAY_INFO_FILE], RELAY_MAX_INFO_BYTES);
  if (isRefusal(read)) return { missing: read.missing, problem: read.problem };
  try {
    return parseRelayInfo(read.data.toString('utf8'));
  } catch (err) {
    return { missing: false, problem: `${path.join(folder, ...RELAY_SEGMENTS, RELAY_INFO_FILE)} is ignored: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The outbox's complete files, oldest first, or why they can't be listed. */
export async function listOutbox(folder: string): Promise<string[] | Refusal> {
  const segments = [...RELAY_SEGMENTS, RELAY_OUTBOX_DIR];
  const dir = await lstatChain(folder, segments, 'dir');
  if (isRefusal(dir)) return dir;
  try {
    const names = await fs.promises.readdir(path.join(folder, ...segments));
    // Numeric order of <epoch ms>-<pid>-<seq>: when they were written.
    const key = (n: string) => n.slice(0, -'.jsonl'.length).split('-').map(Number);
    return names.filter(isOutboxFileName).sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  } catch (err) {
    return { missing: false, problem: `${path.join(folder, ...segments)} can't be listed (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

/**
 * The host project folder an event's (container-side) workspace stands for:
 * under relay.json's root, the same relative path under the allowed folder;
 * anything else, the folder itself.
 */
export function hostProjectDir(eventWorkspace: unknown, info: RelayInfo, folder: string): string {
  if (typeof eventWorkspace !== 'string' || !eventWorkspace.startsWith('/') || eventWorkspace.includes('\0')) return folder;
  const rel = path.posix.relative(info.root, eventWorkspace);
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return folder;
  return path.join(folder, ...rel.split('/'));
}

const EVENT_FIELDS = new Set(Object.keys(normalizedEventSchema.properties));
const STATUSES = new Set(['success', 'failure', 'unknown']);

/** One outbox line as an event: its basic shape checked, and only the schema's fields kept. Undefined: skip it. */
export function relayedEvent(line: string): NormalizedEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (!['eventId', 'sessionId', 'ts', 'kind', 'agent'].every((k) => typeof o[k] === 'string' && (o[k] as string).length > 0)) return undefined;
  // An ISO 8601 time, as every adapter writes (V8's Date.parse alone takes almost anything).
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(o.ts as string) || Number.isNaN(Date.parse(o.ts as string))) return undefined;
  const r = o.raw as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object' || typeof r.adapter !== 'string' || typeof r.ref !== 'string') return undefined;
  const event: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) if (EVENT_FIELDS.has(key)) event[key] = value;
  if (!STATUSES.has(event.status as string)) event.status = 'unknown';
  return event as unknown as NormalizedEvent;
}

export class RelayIngest {
  private running = false;
  /** The last problem logged per folder, so a lasting one is logged once, not every tick. */
  private readonly lastProblem = new Map<string, string>();

  constructor(private readonly opts: RelayIngestOptions) {}

  /** Reads every allowed folder's outbox once. A tick that finds the previous one still running does nothing. */
  async ingest(): Promise<RelayFolderResult[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const results: RelayFolderResult[] = [];
      for (const folder of relayAllowed(loadConfig(this.opts.home).config)) results.push(await this.ingestFolder(folder));
      return results;
    } finally {
      this.running = false;
    }
  }

  private problem(folder: string, problem: string | undefined): void {
    if (problem === undefined) {
      this.lastProblem.delete(folder);
      return;
    }
    if (this.lastProblem.get(folder) === problem) return;
    this.lastProblem.set(folder, problem);
    this.opts.log(`relay: ${problem}`);
  }

  private async ingestFolder(folder: string): Promise<RelayFolderResult> {
    const result: RelayFolderResult = { folder, files: 0, events: 0, written: 0, duplicates: 0, skippedLines: 0, notRecorded: 0, refused: 0 };
    const info = await readRelayInfo(folder);
    if (isRefusal(info)) {
      // No relay folder yet (the container hasn't started one): nothing to say.
      if (!info.missing) this.problem(folder, info.problem);
      result.problem = info.problem;
      return result;
    }
    const names = await listOutbox(folder);
    if (isRefusal(names)) {
      if (!names.missing) this.problem(folder, names.problem);
      result.problem = names.problem;
      return result;
    }
    const refusals: string[] = [];
    for (const name of names.slice(0, this.opts.maxFilesPerTick ?? 200)) {
      const segments = [...RELAY_SEGMENTS, RELAY_OUTBOX_DIR, name];
      const read = await readBelow(folder, segments, RELAY_MAX_FILE_BYTES);
      if (isRefusal(read)) {
        if (read.missing) continue; // gone since it was listed
        result.refused += 1;
        refusals.push(read.problem);
        // Too big to read: it never will be, so it goes (it's in the relay's own outbox, and named as the writer names files).
        if (read.tooBig) await removeBelow(folder, segments, read.tooBig);
        continue;
      }
      const events: NormalizedEvent[] = [];
      const projects = new Map<string, { workspace?: string; capture: boolean }>();
      for (let line of read.data.toString('utf8').split('\n')) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim() === '') continue;
        if (Buffer.byteLength(line, 'utf8') > RELAY_MAX_LINE_BYTES) {
          result.skippedLines += 1;
          continue;
        }
        const event = relayedEvent(line);
        if (!event) {
          result.skippedLines += 1;
          continue;
        }
        result.events += 1;
        const projectDir = hostProjectDir(event.workspace, info, folder);
        let project = projects.get(projectDir);
        if (!project) {
          project = { workspace: this.opts.workspaceFor(projectDir), capture: this.opts.captureContent(projectDir) };
          projects.set(projectDir, project);
        }
        if (project.workspace === undefined) {
          result.notRecorded += 1;
          continue;
        }
        events.push({ ...(project.capture ? event : withoutCapturedText(event)), workspace: project.workspace });
      }
      try {
        const written = events.length > 0 ? await this.opts.writer.write(events) : undefined;
        result.written += (written?.written ?? 0) + (written?.spooled ?? 0);
        result.duplicates += written?.duplicates ?? 0;
      } catch (err) {
        // Left for the next tick; what was written is skipped then as a duplicate.
        this.opts.log(`relay: couldn't write events from ${path.join(folder, ...segments)}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (await removeBelow(folder, segments, read.stat)) result.files += 1;
      else refusals.push(`${path.join(folder, ...segments)} couldn't be deleted after it was read`);
    }
    this.problem(folder, refusals.length > 0 ? `${folder}: ${refusals.length} outbox entr${refusals.length === 1 ? 'y' : 'ies'} refused, e.g. ${refusals[0]}` : undefined);
    if (result.files > 0 || result.skippedLines > 0) {
      this.opts.log(
        `relay: ${folder}: ${result.events} event(s) from ${result.files} file(s): ${result.written} new, ${result.duplicates} already recorded, ${result.notRecorded} not recorded (settings), ${result.skippedLines} bad line(s) skipped`
      );
    }
    if (result.files > 0) {
      try {
        const status = readRelayStatus(this.opts.home);
        status[folder] = { lastIngestAt: new Date((this.opts.now ?? Date.now)()).toISOString(), files: result.files, events: result.events, written: result.written };
        saveRelayStatus(this.opts.home, status);
      } catch (err) {
        this.opts.log(`relay: couldn't save ${relayStatusPath(this.opts.home)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }
}
