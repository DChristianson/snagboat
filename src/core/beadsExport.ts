import * as fs from 'fs';
import * as path from 'path';
import { openBelow } from './containerTranscripts';

/**
 * Beads exported by a dev container (bead snagboat-93b.10.8). bd runs only in the container, so the container's
 * beads-export.sh (.devcontainer/beads-export.sh here, .snagboat/bin/beads-export.sh where `snagboat containers allow
 * --edit` put it) writes what bd knows into the project folder, which this machine sees at the same path:
 *
 *   <folder>/.snagboat/beads/issues.jsonl         bd export: one issue per line
 *   <folder>/.snagboat/beads/history/<id>.json    bd history <id> --events --json: the bead's audit events
 *   <folder>/.snagboat/beads/status.json          when the exporter last ran, its counts, bd's version, its last error
 *
 * This reads them back in bd's own shapes, for the plan job (snagboat-93b.10.4), which uses host bd when it's
 * installed, else this, else markdown. The folder is written from the container, so it's read as untrusted: no symlinks
 * on the way down (openBelow), size caps, records without the fields the plan job needs are dropped and counted, and
 * problems name paths and counts, never contents.
 */

/** <folder>/.snagboat/beads, one segment each. */
export const BEADS_EXPORT_SEGMENTS: readonly string[] = ['.snagboat', 'beads'];
const MAX_ISSUES_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;
/** What bd accepts in an id; anything else isn't looked up as a file name. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One line of `bd export`. Only id is guaranteed; the rest is bd's, passed through. */
export interface BeadsIssue {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  assignee?: string;
  owner?: string;
  created_at?: string;
  created_by?: string;
  updated_at?: string;
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  dependencies?: Array<{ issue_id: string; depends_on_id: string; type: string; created_at?: string; created_by?: string }>;
  [field: string]: unknown;
}

/** One entry of `bd history <id> --events --json`. For 'updated', old_value is the bead's whole old state and new_value the fields set, both JSON text. */
export interface BeadsEvent {
  id: string;
  issue_id: string;
  event_type: string;
  actor?: string;
  old_value?: string;
  new_value?: string;
  created_at: string;
  [field: string]: unknown;
}

/** status.json, as beads-export.sh writes it (version 1). */
export interface BeadsExportStatus {
  version: number;
  folder?: string;
  last_run?: string;
  ok?: boolean;
  last_success?: string | null;
  duration_s?: number;
  interval_s?: number;
  issues?: number;
  histories?: number;
  histories_written?: number;
  history_failures?: number;
  bd_version?: string | null;
  pid?: number;
  last_error?: string | null;
  last_error_at?: string | null;
}

export interface BeadsExport {
  dir: string;
  issues: BeadsIssue[];
  /** Each bead's audit events, oldest first (bd prints newest first). A bead the exporter hasn't reached yet has no entry. */
  events: Map<string, BeadsEvent[]>;
  /** Issues with no history file yet, or one that couldn't be read. */
  missingHistory: string[];
  status?: BeadsExportStatus;
  /** When the exporter last ran: status.json's last_run, else issues.jsonl's modification time. */
  lastRun?: Date;
  /** The exporter ran within staleAfterMs of now: it's still running in a container. A stale export is still returned. */
  fresh: boolean;
  /** issues.jsonl's modification time: when the issues last changed (the exporter leaves it alone otherwise). */
  issuesChanged: Date;
  /** What was refused or skipped, by path and count. */
  problems: string[];
}

export interface ReadBeadsExportOptions {
  now?: Date;
  /** How old lastRun may be and still be fresh. Default: three of the exporter's intervals, at least 5 minutes. */
  staleAfterMs?: number;
  /** Read history only for these beads (say, those whose updated_at changed); default all issues. */
  historyFor?: Iterable<string>;
}

export function beadsExportDir(folder: string): string {
  return path.join(folder, ...BEADS_EXPORT_SEGMENTS);
}

type Read = { text: string; stat: fs.Stats } | { missing: boolean; problem: string };

function readBelow(folder: string, file: string, max: number): Read {
  const opened = openBelow(folder, file);
  if (!('fd' in opened)) return opened;
  try {
    const stat = fs.fstatSync(opened.fd);
    if (stat.size > max) return { missing: false, problem: `${file} is over ${Math.round(max / 1024 / 1024) || 1} MB` };
    return { text: fs.readFileSync(opened.fd, 'utf8'), stat };
  } finally {
    fs.closeSync(opened.fd);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The folder's exported beads, or undefined when there's no export (no .snagboat/beads/issues.jsonl, or it's refused:
 * then problems would say why, so a refused one comes back with no issues and the problem).
 */
export function readBeadsExport(folder: string, options: ReadBeadsExportOptions = {}): BeadsExport | undefined {
  const dir = beadsExportDir(folder);
  const issuesFile = path.join(dir, 'issues.jsonl');
  const read = readBelow(folder, issuesFile, MAX_ISSUES_BYTES);
  if (!('text' in read)) {
    if (read.missing) return undefined;
    return { dir, issues: [], events: new Map(), missingHistory: [], fresh: false, issuesChanged: new Date(0), problems: [`refused ${read.problem}`] };
  }
  const problems: string[] = [];
  const issues: BeadsIssue[] = [];
  const seen = new Set<string>();
  let bad = 0;
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    // bd export marks issues with _type "issue"; other record types (memories, with --all) aren't beads.
    if (!isObject(value) || typeof value.id !== 'string' || !ID.test(value.id) || (value._type !== undefined && value._type !== 'issue') || seen.has(value.id)) {
      bad++;
      continue;
    }
    seen.add(value.id);
    issues.push(value as BeadsIssue);
  }
  if (bad) problems.push(`skipped ${bad} line(s) of ${issuesFile} that aren't bd issues`);

  let status: BeadsExportStatus | undefined;
  const statusFile = path.join(dir, 'status.json');
  const statusRead = readBelow(folder, statusFile, MAX_STATUS_BYTES);
  if ('text' in statusRead) {
    try {
      const value: unknown = JSON.parse(statusRead.text);
      if (isObject(value) && typeof value.version === 'number') status = value as unknown as BeadsExportStatus;
      else problems.push(`${statusFile} isn't the exporter's status`);
    } catch {
      problems.push(`${statusFile} isn't JSON`);
    }
  } else if (!statusRead.missing) problems.push(`refused ${statusRead.problem}`);

  const events = new Map<string, BeadsEvent[]>();
  const missingHistory: string[] = [];
  const wanted = options.historyFor ? new Set(options.historyFor) : undefined;
  for (const issue of issues) {
    if (wanted && !wanted.has(issue.id)) continue;
    const file = path.join(dir, 'history', `${issue.id}.json`);
    const h = readBelow(folder, file, MAX_HISTORY_BYTES);
    if (!('text' in h)) {
      missingHistory.push(issue.id);
      if (!h.missing) problems.push(`refused ${h.problem}`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(h.text);
    } catch {
      missingHistory.push(issue.id);
      problems.push(`${file} isn't JSON`);
      continue;
    }
    // bd prints null, not [], for a bead with no events.
    const list = value === null ? [] : value;
    if (!Array.isArray(list)) {
      missingHistory.push(issue.id);
      problems.push(`${file} isn't a list of events`);
      continue;
    }
    const kept = list.filter(
      (e): e is BeadsEvent => isObject(e) && typeof e.id === 'string' && e.issue_id === issue.id && typeof e.event_type === 'string' && typeof e.created_at === 'string'
    );
    if (kept.length !== list.length) problems.push(`skipped ${list.length - kept.length} event(s) in ${file} that aren't this bead's audit events`);
    // Oldest first; events at the same second keep bd's order, reversed (bd lists newest first).
    const ordered = kept.reverse().map((e, i) => ({ e, i, t: Date.parse(e.created_at) }));
    ordered.sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) || a.t === b.t ? a.i - b.i : a.t - b.t));
    events.set(issue.id, ordered.map((o) => o.e));
  }

  const now = options.now ?? new Date();
  const ranAt = status?.last_run ? Date.parse(status.last_run) : NaN;
  const lastRun = Number.isNaN(ranAt) ? read.stat.mtime : new Date(ranAt);
  const interval = typeof status?.interval_s === 'number' && status.interval_s > 0 ? status.interval_s : 60;
  const staleAfter = options.staleAfterMs ?? Math.max(3 * interval * 1000, 5 * 60 * 1000);
  const age = now.getTime() - lastRun.getTime();
  return { dir, issues, events, missingHistory, status, lastRun, fresh: age <= staleAfter, issuesChanged: read.stat.mtime, problems };
}
