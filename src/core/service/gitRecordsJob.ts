import * as path from 'path';
import { BranchRecord, CommitRecord, GitRecord, storeRecordKey } from '@snagboat/schema';
import { effectiveSettings } from '../config';
import { commitShasSince, localBranches, locateRepo, readCheckouts, readCommits, RepoLocation, updateBranches } from '../gitRecords';
import { oldestKeptDay } from '../retention';
import { foldStoreFile, storeRecordTime } from '../storeRecordFiles';
import { listUserStores, UserStore } from '../userStore';
import { GitRunner, runGit } from '../../outcomes/gitOutcomes';
import { retentionPolicyFor, StoreWriter } from './storeWriter';

/**
 * The repository job (docs/design/export.md, "The store records it"): for each workspace in
 * the per-user store that's a folder in a git repository, with `outcomes.git` and `collect`
 * not turned off, it appends to the workspace's git.jsonl the commits, branches and checkouts
 * it hasn't recorded, and a branch again when it changes (moved, merged, deleted). Read-only
 * git (gitRecords.ts), no network.
 *
 * Cadence: the core ticks it every few minutes (GIT_RECORDS_TICK_MS). A repository is read
 * on a tick when one of its workspaces had events written in the last ACTIVE_MS (a session is
 * active, so checkouts are seen near their times), or an hour has passed since it was last
 * read. One run at a time.
 *
 * Worktrees: each working tree is its own workspace with its own store folder. Every store of
 * a repository gets the repository's shared records, its commits and branches, the same in
 * each (read once per run, and a branch's id taken from whichever store saw it first, so the
 * stores agree), and only its own working tree's checkouts. An export of several worktrees
 * folds them by key.
 *
 * Retention: each store keeps records from its own retention.rawDays (storeRecordTime), and
 * nothing older is appended, so retention and this job don't undo each other.
 */

export const GIT_RECORDS_TICK_MS = 5 * 60_000;
export const GIT_RECORDS_IDLE_MS = 60 * 60_000;
/** A workspace with events written this recently has an active session. */
export const ACTIVE_MS = 15 * 60_000;

export const GIT_RECORDS_FILE = 'git.jsonl';

interface Member {
  store: UserStore;
  loc: RepoLocation;
  file: string;
  /** The oldest record time this store keeps. */
  cutoff: string;
}

export class GitRecordsJob {
  private running?: Promise<number>;
  private readonly lastRun = new Map<string, number>();
  private readonly activity = new Map<string, number>();
  private readonly notMerged = new Map<string, Set<string>>();
  private readonly stopListening: () => void;

  constructor(
    private readonly home: string,
    private readonly writer: StoreWriter,
    private readonly log: (line: string) => void = () => undefined,
    private readonly git: GitRunner = runGit,
    private readonly clock: () => number = Date.now
  ) {
    this.stopListening = writer.onWritten((workspace) => this.activity.set(workspace, this.clock()));
  }

  dispose(): void {
    this.stopListening();
  }

  /**
   * Reads the repositories due now (or every one, with `force`) and appends what's new; how
   * many records. A run already going is joined, not repeated.
   */
  run(opts: { force?: boolean } = {}): Promise<number> {
    this.running ??= this.runNow(opts.force ?? false).finally(() => (this.running = undefined));
    return this.running;
  }

  private async runNow(force: boolean): Promise<number> {
    const now = this.clock();
    const today = new Date(now).toISOString().slice(0, 10);
    const repos = new Map<string, Member[]>();
    for (const store of listUserStores(this.home)) {
      if (!store.folder) continue;
      const settings = effectiveSettings(this.home, store.folder).values;
      if (settings['outcomes.git'] === false || settings.collect === false) continue;
      const loc = await locateRepo(store.folder, this.git);
      if (!loc) continue;
      const rawDays = Math.max(1, Math.floor(retentionPolicyFor(this.home, store.workspace).rawDays));
      const member = { store, loc, file: path.join(store.dir, GIT_RECORDS_FILE), cutoff: `${oldestKeptDay(today, rawDays)}T00:00:00.000Z` };
      repos.set(loc.commonDir, [...(repos.get(loc.commonDir) ?? []), member]);
    }
    let total = 0;
    for (const [commonDir, members] of repos) {
      const last = this.lastRun.get(commonDir);
      const active = members.some((m) => now - (this.activity.get(m.store.workspace) ?? -Infinity) < ACTIVE_MS);
      if (!force && last !== undefined && now - last < GIT_RECORDS_IDLE_MS && !active) continue;
      this.lastRun.set(commonDir, now);
      try {
        total += await this.record(commonDir, members, now);
      } catch (err) {
        this.log(`git records for ${members[0].loc.toplevel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (total > 0) this.log(`recorded ${total} git record(s)`);
    return total;
  }

  /** One repository: read once, then append to each of its stores what that store lacks. */
  private async record(commonDir: string, members: Member[], now: number): Promise<number> {
    const nowIso = new Date(now).toISOString();
    const repo = members[0].loc.toplevel;
    const folds = members.map((m) => foldStoreFile<GitRecord>(m.file));

    // What any of the repository's stores has: commits by SHA, and each branch's latest record.
    const commits = new Map<string, CommitRecord>();
    const branches = new Map<string, BranchRecord>();
    for (const fold of folds) {
      for (const r of fold.values()) {
        if (r.record === 'commit') commits.set(r.sha, r);
        else if (r.record === 'branch') branches.set(r.id, newer(branches.get(r.id), r));
      }
    }

    const since = members.map((m) => m.cutoff).sort()[0];
    const heads = await localBranches(repo, this.git);
    const unseen = (await commitShasSince(repo, since, this.git)).filter((sha) => !commits.has(sha));
    for (const c of await readCommits(repo, unseen, heads, since, this.git)) commits.set(c.sha, c);
    let notMerged = this.notMerged.get(commonDir);
    if (!notMerged) this.notMerged.set(commonDir, (notMerged = new Set()));
    const branchRecords = await updateBranches(members[0].loc, [...branches.values()], heads, nowIso, this.git, notMerged);

    const checkouts = new Map<string, GitRecord[]>();
    let total = 0;
    for (const [i, m] of members.entries()) {
      const fold = folds[i];
      let own = checkouts.get(m.loc.gitDir);
      if (!own) checkouts.set(m.loc.gitDir, (own = readCheckouts(m.loc, since)));
      const wanted: GitRecord[] = [...commits.values(), ...branchRecords, ...own];
      const append = wanted.filter((r) => {
        const at = storeRecordTime(r);
        if (at !== undefined && at < m.cutoff) return false;
        const have = fold.get(storeRecordKey(r));
        return !have || JSON.stringify(have) !== JSON.stringify(r);
      });
      if (append.length === 0) continue;
      // Commits in history order, oldest first, then branches, then checkouts.
      append.sort((a, b) => order(a) - order(b) || (a.record === 'commit' && b.record === 'commit' ? a.committedAt.localeCompare(b.committedAt) : 0));
      await this.writer.appendRecords(m.file, append);
      total += append.length;
    }
    return total;
  }
}

const order = (r: GitRecord) => (r.record === 'commit' ? 0 : r.record === 'branch' ? 1 : 2);

/** Of two lines of one branch's record from different stores, the further along: deleted, then merged. */
function newer(a: BranchRecord | undefined, b: BranchRecord): BranchRecord {
  if (!a) return b;
  const rank = (r: BranchRecord) => (r.deletedAt ? 2 : 0) + (r.merged ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}
