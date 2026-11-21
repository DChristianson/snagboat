import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BranchMerge, BranchRecord, CheckoutRecord, CommitFile, CommitRecord } from '@snagboat/schema';
import { GitRunner, runGit } from '../outcomes/gitOutcomes';

/**
 * What the repository job (service/gitRecordsJob.ts) reads from git for git.jsonl
 * (docs/design/export.md, "The store records it"): commits, branches and each working tree's
 * checkouts. Read-only: git log, rev-list, for-each-ref, merge-base and diff through runGit
 * (no optional locks, bounded), and the reflog files read directly. No network: a pull request
 * is known only by the number in a commit's subject.
 */

/** Where a folder sits in its repository. */
export interface RepoLocation {
  /** The working tree's root. */
  toplevel: string;
  /** Its git directory: the common one for the main working tree, .git/worktrees/<name> for another. */
  gitDir: string;
  /** The repository's shared git directory: the same for every working tree. */
  commonDir: string;
  /** '.' for the main working tree, else its name under .git/worktrees/. */
  worktree: string;
}

export async function locateRepo(folder: string, git: GitRunner = runGit): Promise<RepoLocation | undefined> {
  let out: string;
  try {
    out = await git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], folder);
  } catch {
    return undefined;
  }
  const [gitDir, commonDir, toplevel] = out.split('\n').map((l) => l.trim());
  if (!gitDir || !commonDir || !toplevel) return undefined;
  const same = path.resolve(gitDir) === path.resolve(commonDir);
  return { toplevel, gitDir, commonDir, worktree: same ? '.' : path.basename(gitDir) };
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const PR_IN_SUBJECT = /\(#(\d+)\)\s*$/;
const PR_IN_MERGE = /^Merge pull request #(\d+)\b/;

export function prOf(subject: string): number | undefined {
  const m = PR_IN_SUBJECT.exec(subject);
  return m ? Number(m[1]) : undefined;
}

// ---- reflogs --------------------------------------------------------------------------------

interface ReflogEntry {
  old: string;
  new: string;
  at: number;
  message: string;
}

const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*? (\d+) [+-]\d{4}(?:\t(.*))?$/;

/** A reflog file's entries, oldest first; [] when there is none (expired, or a reftable repository). */
export function readReflog(file: string): ReflogEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ReflogEntry[] = [];
  for (const line of text.split('\n')) {
    const m = REFLOG_LINE.exec(line);
    if (m) out.push({ old: m[1], new: m[2], at: Number(m[3]), message: m[4] ?? '' });
  }
  return out;
}

export function checkoutId(worktree: string, at: string, commit: string): string {
  return `checkout-${crypto.createHash('sha256').update(`${worktree}\n${at}\n${commit}`).digest('hex').slice(0, 16)}`;
}

/** A name from "checkout: moving from A to B": a branch name stays; a SHA or revision expression is the short SHA. */
function refName(text: string, sha: string): string {
  return /^[0-9a-f]{7,64}$/.test(text) || /[~^:{}\s]|@\{/.test(text) || text === 'HEAD' ? sha.slice(0, 7) : text;
}

/** The working tree's checkouts from its HEAD reflog, at or after `since` (ISO 8601). */
export function readCheckouts(loc: RepoLocation, since: string): CheckoutRecord[] {
  const out: CheckoutRecord[] = [];
  for (const e of readReflog(path.join(loc.gitDir, 'logs', 'HEAD'))) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(e.message);
    if (!m) continue;
    const at = iso(e.at);
    if (at < since) continue;
    out.push({ record: 'checkout', version: 1, id: checkoutId(loc.worktree, at, e.new), at, from: refName(m[1], e.old), to: refName(m[2], e.new), commit: e.new, where: loc.toplevel });
  }
  return out;
}

// ---- commits --------------------------------------------------------------------------------

const COMMIT_FORMAT = '%x1e%H%x1f%P%x1f%at%x1f%ct%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1d';
const CHUNK = 100;

function rawStatus(letter: string): CommitFile['status'] {
  if (letter === 'A' || letter === 'C') return 'A';
  if (letter === 'D') return 'D';
  if (letter === 'R') return 'R';
  return 'M';
}

/** A commit's files from `--raw --numstat -z` output: raw entries first, then numstat. */
function parseFiles(diff: string): CommitFile[] {
  const tokens = diff.split('\0').map((t) => t.replace(/^\n+/, ''));
  const files: CommitFile[] = [];
  const byPath = new Map<string, CommitFile>();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith(':')) {
      const letter = t.split(' ').pop()?.[0] ?? 'M';
      if (letter === 'R' || letter === 'C') {
        const file: CommitFile = { path: tokens[i + 2], status: rawStatus(letter), added: 0, deleted: 0, ...(letter === 'R' ? { from: tokens[i + 1] } : {}) };
        files.push(file);
        byPath.set(file.path, file);
        i += 3;
      } else {
        const file: CommitFile = { path: tokens[i + 1], status: rawStatus(letter), added: 0, deleted: 0 };
        files.push(file);
        byPath.set(file.path, file);
        i += 2;
      }
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(t);
    if (m) {
      let p = m[3];
      if (p === '') {
        p = tokens[i + 2];
        i += 3;
      } else i += 1;
      const file = byPath.get(p);
      if (file) {
        file.added = m[1] === '-' ? 0 : Number(m[1]);
        file.deleted = m[2] === '-' ? 0 : Number(m[2]);
      }
      continue;
    }
    i += 1;
  }
  return files;
}

function parseCommits(out: string): Omit<CommitRecord, 'onBranches'>[] {
  const commits: Omit<CommitRecord, 'onBranches'>[] = [];
  for (const chunk of out.split('\x1e')) {
    const end = chunk.indexOf('\x1d');
    if (end < 0) continue;
    const [sha, parents, at, ct, author, committer, ...message] = chunk.slice(0, end).split('\x1f');
    const text = message.join('\x1f').replace(/\s+$/, '');
    const nl = text.indexOf('\n');
    const subject = (nl < 0 ? text : text.slice(0, nl)).trim();
    const body = nl < 0 ? '' : text.slice(nl + 1).trim();
    const parentList = parents.split(' ').filter(Boolean);
    const pr = prOf(subject);
    const reverts = /This reverts commit ([0-9a-f]{7,64})/.exec(body)?.[1];
    const coAuthors = [...body.matchAll(/^co-authored-by:[ \t]*(.+?)[ \t]*$/gim)].map((m) => m[1]);
    commits.push({
      record: 'commit',
      version: 1,
      sha,
      parents: parentList,
      kind: parentList.length > 1 ? 'merge' : pr !== undefined ? 'squash' : 'commit',
      authoredAt: iso(Number(at)),
      committedAt: iso(Number(ct)),
      author,
      committer,
      coAuthors,
      subject,
      ...(body ? { body } : {}),
      files: parseFiles(chunk.slice(end + 1)),
      ...(pr !== undefined ? { pr } : {}),
      ...(reverts ? { reverts } : {}),
    });
  }
  return commits;
}

/** The SHAs of commits on any branch, tag or remote-tracking ref (not stashes or notes) committed at or after `since`. */
export async function commitShasSince(repo: string, since: string, git: GitRunner = runGit): Promise<string[]> {
  const out = await git(['rev-list', '--exclude=refs/stash', '--exclude=refs/notes/*', '--all', `--since=${Math.floor(Date.parse(since) / 1000)}`], repo);
  return out.split('\n').filter(Boolean);
}

/** Commit records for these SHAs; onBranches from `heads` (branch name to head SHA). */
export async function readCommits(repo: string, shas: string[], heads: Map<string, string>, since: string, git: GitRunner = runGit): Promise<CommitRecord[]> {
  if (shas.length === 0) return [];
  const commits: Omit<CommitRecord, 'onBranches'>[] = [];
  for (let i = 0; i < shas.length; i += CHUNK) {
    const out = await git(['log', '--no-walk=unsorted', '--diff-merges=first-parent', '-M', '--raw', '--numstat', '-z', `--format=${COMMIT_FORMAT}`, ...shas.slice(i, i + CHUNK)], repo);
    commits.push(...parseCommits(out));
  }
  const wanted = new Set(shas);
  const onBranches = new Map<string, string[]>();
  for (const [name, head] of [...heads].sort(([a], [b]) => a.localeCompare(b))) {
    const out = await git(['rev-list', `--since=${Math.floor(Date.parse(since) / 1000)}`, head], repo);
    for (const sha of out.split('\n')) if (wanted.has(sha)) onBranches.set(sha, [...(onBranches.get(sha) ?? []), name]);
  }
  return commits.map((c) => ({ ...c, onBranches: onBranches.get(c.sha) ?? [] }));
}

// ---- branches -------------------------------------------------------------------------------

export async function localBranches(repo: string, git: GitRunner = runGit): Promise<Map<string, string>> {
  const out = await git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'], repo);
  const heads = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, sha] = line.split('\t');
    if (name && sha) heads.set(name, sha);
  }
  return heads;
}

const quiet = async (git: GitRunner, args: string[], repo: string): Promise<string | undefined> => {
  try {
    return (await git(args, repo)).trim();
  } catch {
    return undefined;
  }
};

/** The branch work is merged into: origin/HEAD's branch when that's known locally, else main, else master. */
export async function defaultBranch(repo: string, heads: Map<string, string>, git: GitRunner = runGit): Promise<string | undefined> {
  const remote = await quiet(git, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], repo);
  if (remote?.startsWith('refs/remotes/origin/')) return remote.slice('refs/remotes/origin/'.length);
  if (heads.has('main')) return 'main';
  if (heads.has('master')) return 'master';
  return undefined;
}

/** A branch's creation from its reflog, and whether it was rebased. */
interface BranchHistory {
  createdAt?: string;
  from?: string;
  rebased: boolean;
}

function branchHistory(commonDir: string, name: string): BranchHistory {
  const entries = readReflog(path.join(commonDir, 'logs', 'refs', 'heads', ...name.split('/')));
  const first = entries[0];
  const created = first && /^0+$/.test(first.old) ? first : undefined;
  return { ...(created ? { createdAt: iso(created.at), from: created.new } : {}), rebased: entries.some((e) => e.message.startsWith('rebase')) };
}

/** A diff reduced to what a patch-id compares: file headers and changed lines, without line numbers or whitespace. */
function patchKey(diff: string): string {
  const kept: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) kept.push(line);
    else if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) kept.push(line.replace(/\s+/g, ''));
  }
  return kept.length ? crypto.createHash('sha256').update(kept.join('\n')).digest('hex') : '';
}

const MAX_SQUASH_CANDIDATES = 200;

/**
 * Where a branch went, if into `into`, checked against each of `tips`: the heads of
 * refs/heads/<into> and refs/remotes/origin/<into>, the ones that exist.
 *
 *   - merge: its head is reachable from the target, and the first commit on the target's
 *     first-parent line that contains it is a merge commit;
 *   - fast-forward (rebase, when the branch's reflog shows a rebase): its head is on the target's
 *     first-parent line, and the branch had commits of its own (its head isn't where its reflog
 *     says it started; without a reflog this isn't decided);
 *   - squash: not reachable, and a commit on the target since they diverged names a pull request
 *     ("(#N)") and has the branch's changes, or the subject of one of its commits, or its name;
 *   - rebase: not reachable, and every commit of the branch is on the target as an equivalent
 *     patch (git cherry).
 */
export async function detectMerge(
  repo: string,
  branch: { name: string; head: string; from?: string; rebased: boolean },
  into: string,
  tips: string[],
  nowIso: string,
  git: GitRunner = runGit
): Promise<BranchMerge | undefined> {
  for (const tip of tips) {
    const reachable = (await quiet(git, ['merge-base', '--is-ancestor', branch.head, tip], repo)) !== undefined;
    if (reachable) {
      const chain = (await git(['rev-list', '--first-parent', '--ancestry-path', '--parents', `${branch.head}..${tip}`], repo)).split('\n').filter(Boolean);
      const oldest = chain.length ? chain[chain.length - 1].split(' ') : undefined;
      if (oldest && oldest.length > 2 && oldest[1] !== branch.head) {
        const [ct, subject] = (await git(['show', '-s', '--format=%ct%x1f%s', oldest[0]], repo)).trim().split('\x1f');
        const pr = prOf(subject) ?? (PR_IN_MERGE.exec(subject) ? Number(PR_IN_MERGE.exec(subject)![1]) : undefined);
        return { into, at: iso(Number(ct)), via: 'merge', commit: oldest[0], ...(pr !== undefined ? { pr } : {}) };
      }
      // On the target's own line: fast-forwarded (or rebased, then fast-forwarded), if it had commits of its own.
      if (branch.from && branch.from !== branch.head) return { into, at: nowIso, via: branch.rebased ? 'rebase' : 'fast-forward', commit: tip };
      continue;
    }
    const base = await quiet(git, ['merge-base', branch.head, tip], repo);
    if (!base) continue;
    const candidates = (await git(['log', '--first-parent', '--no-merges', `--max-count=${MAX_SQUASH_CANDIDATES}`, '--format=%H%x1f%ct%x1f%s', `${base}..${tip}`], repo))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\x1f'))
      .filter(([, , s]) => PR_IN_SUBJECT.test(s ?? ''))
      .reverse();
    if (candidates.length > 0) {
      const own = await git(['diff', '--no-color', '--no-ext-diff', base, branch.head], repo);
      const ownKey = patchKey(own);
      const subjects = new Set((await git(['log', '--format=%s', `${base}..${branch.head}`], repo)).split('\n').filter(Boolean));
      subjects.add(branch.name);
      for (const [sha, ct, subject] of candidates) {
        const title = subject.replace(PR_IN_SUBJECT, '').trim();
        let match = subjects.has(title);
        if (!match && ownKey) match = patchKey(await git(['show', '--no-color', '--no-ext-diff', '--format=', sha], repo)) === ownKey;
        if (match) return { into, at: iso(Number(ct)), via: 'squash', commit: sha, pr: prOf(subject) };
      }
    }
    const cherry = (await git(['cherry', tip, branch.head], repo)).split('\n').filter(Boolean);
    if (cherry.length > 0 && cherry.every((l) => l.startsWith('-'))) return { into, at: nowIso, via: 'rebase', commit: tip };
  }
  return undefined;
}

/**
 * The branch records after this run: the known ones (the latest of each, from git.jsonl)
 * updated with each branch's head, creation and merge, a new record for a branch not seen
 * before (or deleted and made again, by its reflog's creation time), and `deletedAt` on one
 * that's gone. Records unchanged come back as they were.
 */
export async function updateBranches(
  loc: RepoLocation,
  known: BranchRecord[],
  heads: Map<string, string>,
  nowIso: string,
  git: GitRunner = runGit,
  /** Branches already found not merged, by name, head and the targets' heads: not checked again until one moves. */
  notMerged: Set<string> = new Set()
): Promise<BranchRecord[]> {
  const repo = loc.toplevel;
  const into = await defaultBranch(repo, heads, git);
  const tips: string[] = [];
  if (into) {
    for (const ref of [`refs/heads/${into}`, `refs/remotes/origin/${into}`]) {
      const tip = await quiet(git, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], repo);
      if (tip && !tips.includes(tip)) tips.push(tip);
    }
  }
  const merge = async (r: BranchRecord, rebased: boolean): Promise<BranchMerge | undefined> => {
    if (r.merged) return r.merged;
    if (!into || r.name === into || tips.length === 0) return undefined;
    const key = `${r.name}\n${r.head}\n${r.from ?? ''}\n${rebased}\n${tips.join(' ')}`;
    if (notMerged.has(key)) return undefined;
    const found = await detectMerge(repo, { name: r.name, head: r.head, from: r.from, rebased }, into, tips, nowIso, git);
    if (!found) notMerged.add(key);
    return found;
  };

  const out = new Map(known.map((r) => [r.id, r]));
  const live = new Map<string, BranchRecord>();
  for (const r of known) {
    if (r.deletedAt) continue;
    const other = live.get(r.name);
    if (!other || r.firstSeenAt > other.firstSeenAt) live.set(r.name, r);
  }
  for (const [name, head] of heads) {
    const history = branchHistory(loc.commonDir, name);
    let rec = live.get(name);
    live.delete(name);
    if (rec && history.createdAt && rec.createdAt && history.createdAt !== rec.createdAt) {
      // Deleted and made again between runs: the old one is gone.
      out.set(rec.id, { ...rec, merged: await merge(rec, false), deletedAt: nowIso });
      rec = undefined;
    }
    const next: BranchRecord = rec
      ? { ...rec, head, ...(rec.createdAt || !history.createdAt ? {} : { createdAt: history.createdAt, from: history.from }) }
      : { record: 'branch', version: 1, id: `${name}@${nowIso}`, name, firstSeenAt: nowIso, ...(history.createdAt ? { createdAt: history.createdAt, from: history.from } : {}), head };
    const merged = await merge(next, history.rebased);
    out.set(next.id, merged ? { ...next, merged } : next);
  }
  for (const rec of live.values()) {
    const merged = await merge(rec, false);
    out.set(rec.id, { ...rec, ...(merged ? { merged } : {}), deletedAt: nowIso });
  }
  // Without undefined fields, so an unchanged record serializes as it was stored.
  return [...out.values()].map((r) => JSON.parse(JSON.stringify(r)) as BranchRecord);
}
