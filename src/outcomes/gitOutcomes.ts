import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { baseCategory, NormalizedEvent } from '@snagboat/schema';
import { OUTCOMES_ADAPTER } from './testsGreen';

/**
 * Git outcomes (RFC step 4b): what became of the commits made in a session,
 * read from the repository's history with read-only git commands.
 *
 * A session's commit is one made between the session's first event and 30
 * minutes after its last that touches a file the session's agent edited
 * (tool calls in the file-edit category). For each:
 *
 *   - milestone: the session's last test or build run before the commit
 *     passed: a piece of work done (Beads issues can be another source later);
 *   - commit_kept / commit_reverted, at 7 days: whether a commit saying
 *     "This reverts commit <id>" came within 7 days of it;
 *   - code_survival, at 7 and 30 days: of the lines it added to the session's
 *     files, how many are still there at HEAD (git blame).
 *
 * Each outcome has a fixed id and time (the commit's, plus 7 or 30 days), so
 * running again writes nothing twice, and a check already recorded is skipped
 * before any git command runs for it.
 */

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** git, read-only: no optional locks (so it never contends with your own git), bounded in time and output. */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });

const DAY_MS = 86_400_000;
/** A commit this long after a session's last event still counts as the session's. */
const AFTER_SESSION_MS = 30 * 60_000;
export const KEPT_AFTER_DAYS = 7;
export const SURVIVAL_DAYS = [7, 30];
/** At most this many of a commit's files are blamed. */
const MAX_BLAME_FILES = 20;

interface Session {
  sessionId: string;
  agent: NormalizedEvent['agent'];
  first: number;
  last: number;
  /** Repository-relative paths the agent edited, with the edits. */
  files: Map<string, string[]>;
  /** Test and build runs, in order. */
  runs: Array<{ at: number; passed: boolean }>;
}

interface Commit {
  sha: string;
  at: number;
  files: string[];
}

/** The repository containing dir, or undefined if it isn't in one (or git isn't installed). */
export async function repositoryOf(dir: string, git: GitRunner = runGit): Promise<string | undefined> {
  try {
    return (await git(['rev-parse', '--show-toplevel'], dir)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A file's path inside the repository, as git names it; undefined outside it. Tries the path as given, then its real path (macOS's /var is /private/var). */
function repoPath(repo: string, file: string): string | undefined {
  const inside = (p: string) => {
    const rel = path.relative(repo, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
  };
  const direct = inside(file);
  if (direct) return direct;
  try {
    // The file may be gone (deleted since); its folder still says where it was.
    return inside(path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)));
  } catch {
    return undefined;
  }
}

function sessionsIn(events: NormalizedEvent[], repo: string): Map<string, Session> {
  const sessions = new Map<string, Session>();
  for (const e of events) {
    if (e.kind === 'outcome' || e.kind === 'session_name' || e.channel === 'inline') continue;
    const at = Date.parse(e.ts);
    let s = sessions.get(e.sessionId);
    if (!s) {
      s = { sessionId: e.sessionId, agent: e.agent, first: at, last: at, files: new Map(), runs: [] };
      sessions.set(e.sessionId, s);
    }
    s.first = Math.min(s.first, at);
    s.last = Math.max(s.last, at);
    if (e.kind !== 'tool_call' || !e.toolCategory) continue;
    const category = baseCategory(e.toolCategory);
    if (category === 'tests-builds' && e.status !== 'unknown') s.runs.push({ at, passed: e.status === 'success' });
    if (category === 'file-edit' && e.target && path.isAbsolute(e.target)) {
      const key = repoPath(repo, e.target);
      if (key) s.files.set(key, [...(s.files.get(key) ?? []), e.eventId]);
    }
  }
  for (const s of sessions.values()) s.runs.sort((a, b) => a.at - b.at);
  return sessions;
}

async function commitsSince(repo: string, since: number, git: GitRunner): Promise<Commit[]> {
  const out = await git(['log', '--all', '--no-merges', `--since=${Math.floor(since / 1000)}`, '--format=%x1e%H %ct', '--name-only'], repo);
  const commits: Commit[] = [];
  for (const record of out.split('\x1e')) {
    const lines = record.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const [sha, ct] = lines[0].split(' ');
    commits.push({ sha, at: Number(ct) * 1000, files: lines.slice(1) });
  }
  return commits;
}

/** Commits that say they revert another, by the reverted commit's id, with when. */
async function reverts(repo: string, since: number, git: GitRunner): Promise<Map<string, number>> {
  const out = await git(['log', '--all', `--since=${Math.floor(since / 1000)}`, '--grep=This reverts commit', '--format=%x1e%ct %B'], repo);
  const reverted = new Map<string, number>();
  for (const record of out.split('\x1e')) {
    const at = Number(record.trim().split(' ')[0]) * 1000;
    for (const m of record.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
      const prev = reverted.get(m[1]);
      if (prev === undefined || at < prev) reverted.set(m[1], at);
    }
  }
  return reverted;
}

/** Lines the commit added to these files. */
async function linesAdded(repo: string, sha: string, files: string[], git: GitRunner): Promise<number> {
  const out = await git(['show', '--numstat', '--format=', sha, '--', ...files], repo);
  let added = 0;
  for (const line of out.split('\n')) {
    const n = Number(line.split('\t')[0]);
    if (Number.isFinite(n)) added += n;
  }
  return added;
}

/** Lines at HEAD that git blame gives to the commit, in these files. */
async function linesSurviving(repo: string, sha: string, files: string[], git: GitRunner): Promise<number> {
  let surviving = 0;
  for (const file of files) {
    let out: string;
    try {
      out = await git(['blame', '--line-porcelain', 'HEAD', '--', file], repo);
    } catch {
      continue; // deleted since, or not in HEAD's tree
    }
    for (const line of out.split('\n')) if (line.startsWith(sha)) surviving += 1;
  }
  return surviving;
}

const sameRepo = (sha: string, full: string) => full.startsWith(sha) || sha.startsWith(full);

/**
 * The git outcomes due for a workspace's sessions in `events` (its recent
 * days, outcomes it already has included), newest checks only. `now` is when
 * the checks run.
 */
export async function gitOutcomes(opts: { repo: string; events: NormalizedEvent[]; now: number; git?: GitRunner; workspace?: string }): Promise<NormalizedEvent[]> {
  const git = opts.git ?? runGit;
  const have = new Set(opts.events.filter((e) => e.kind === 'outcome').map((e) => e.eventId));
  const sessions = [...sessionsIn(opts.events, opts.repo).values()].filter((s) => s.files.size > 0);
  if (sessions.length === 0) return [];
  const since = Math.min(...sessions.map((s) => s.first));
  const commits = await commitsSince(opts.repo, since, git);
  let revertedBy: Map<string, number> | undefined;
  const out: NormalizedEvent[] = [];
  const emit = (session: Session, commit: Commit, id: string, at: number, outcome: NonNullable<NormalizedEvent['outcome']>, refs: string[]) => {
    out.push({
      eventId: id,
      sessionId: session.sessionId,
      agent: session.agent,
      ts: new Date(at).toISOString(),
      kind: 'outcome',
      status: outcome.type === 'commit_reverted' ? 'failure' : 'success',
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      outcome: { ...outcome, commit: commit.sha, refs },
      raw: { adapter: OUTCOMES_ADAPTER, ref: `git:${commit.sha}` },
    });
  };

  for (const commit of commits) {
    // The session it belongs to: made during it (or just after) and touching its files; the most files wins.
    let best: { session: Session; files: string[] } | undefined;
    for (const s of sessions) {
      if (commit.at < s.first || commit.at > s.last + AFTER_SESSION_MS) continue;
      const files = commit.files.filter((f) => s.files.has(f));
      if (files.length > 0 && (!best || files.length > best.files.length)) best = { session: s, files };
    }
    if (!best) continue;
    const { session, files } = best;
    const refs = [...new Set(files.flatMap((f) => session.files.get(f) ?? []))].slice(0, 20);

    const milestoneId = `outcome:milestone:${commit.sha}`;
    const lastRun = [...session.runs].reverse().find((r) => r.at <= commit.at);
    if (!have.has(milestoneId) && lastRun?.passed) emit(session, commit, milestoneId, commit.at, { type: 'milestone', files: files.length }, refs);

    const keptAt = commit.at + KEPT_AFTER_DAYS * DAY_MS;
    const fateId = `outcome:commit:${commit.sha}`;
    if (!have.has(fateId) && opts.now >= keptAt) {
      revertedBy ??= await reverts(opts.repo, since, git);
      const revertAt = [...revertedBy].find(([sha]) => sameRepo(sha, commit.sha))?.[1];
      const reverted = revertAt !== undefined && revertAt <= keptAt;
      emit(session, commit, fateId, keptAt, { type: reverted ? 'commit_reverted' : 'commit_kept', files: files.length }, refs);
    }

    for (const days of SURVIVAL_DAYS) {
      const at = commit.at + days * DAY_MS;
      const id = `outcome:code_survival:${commit.sha}:${days}`;
      if (have.has(id) || opts.now < at) continue;
      const blamed = files.slice(0, MAX_BLAME_FILES);
      const written = await linesAdded(opts.repo, commit.sha, blamed, git);
      if (written === 0) continue;
      const surviving = await linesSurviving(opts.repo, commit.sha, blamed, git);
      emit(session, commit, id, at, { type: 'code_survival', files: blamed.length, days, linesWritten: written, linesSurviving: Math.min(surviving, written) }, refs);
    }
  }
  return out;
}
