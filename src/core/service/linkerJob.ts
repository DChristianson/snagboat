import * as fs from 'fs';
import * as path from 'path';
import { BranchRecord, CheckoutRecord, CommitRecord, GitRecord, LinkRecord, NormalizedEvent, PlanItemRecord, PlanRecord, TransitionRecord } from '@snagboat/schema';
import { effectiveSettings } from '../config';
import { EventLog } from '../eventLog';
import { locateRepo, RepoLocation } from '../gitRecords';
import { ComputedLink, computeLinks, issuePrefix, linksToAppend, observeEvent, SessionFacts } from '../links';
import { oldestKeptDay } from '../retention';
import { foldStoreFile, storeRecordTime } from '../storeRecordFiles';
import { listUserStores, UserStore } from '../userStore';
import { GitRunner, runGit } from '../../outcomes/gitOutcomes';
import { GIT_RECORDS_FILE } from './gitRecordsJob';
import { PLAN_RECORDS_FILE } from './planRecordsJob';
import { retentionPolicyFor, StoreWriter } from './storeWriter';

/**
 * The linker (docs/design/export.md, "How records are linked"): keeps each workspace's
 * links.jsonl current with what its events, git.jsonl and plan.jsonl show, by the rules in
 * links.ts.
 *
 * Incremental: what it needs of a workspace's events (links.ts SessionFacts) is read from its
 * log once, then kept current from StoreWriter's write notifications, so a run reads only the
 * repository's git.jsonl and plan.jsonl files. A run works out a repository's links from
 * everything (all its worktrees' sessions, the shared commits and branches, each worktree's
 * checkouts) and appends only what changed; running again appends nothing. A link naming a session
 * goes to that session's workspace; a commit's or branch's links go to every workspace of the
 * repository, as git.jsonl's shared records do.
 *
 * When: the first run links every repository; then a few seconds (LINKER_DEBOUNCE_MS) after events are written to a workspace, or after the
 * repository and plan jobs append records (schedule()), only the repositories that changed; and
 * a full pass every LINKER_FULL_PASS_MS that reads the events again (what retention removed
 * goes) and links every repository. One run at a time, so one repository at a time.
 *
 * Retention: a link's time is its latest evidence (LinkRecord.at); nothing older than the
 * workspace's retention.rawDays is appended, and the store writer's retention prunes links.jsonl
 * by the same time. `collect` off for a project stops its links.
 */

export const LINKS_FILE = 'links.jsonl';
export const LINKER_DEBOUNCE_MS = 5_000;
export const LINKER_FULL_PASS_MS = 6 * 60 * 60_000;

interface Member {
  store: UserStore;
  folder: string;
  loc?: RepoLocation;
  file: string;
  cutoff: string;
}

/** A workspace's facts: loaded from its log the first time, then kept current. */
interface Facts {
  sessions: Map<string, SessionFacts>;
  loaded?: Promise<void>;
}

export interface LinkerJobOptions {
  log?: (line: string) => void;
  git?: GitRunner;
  clock?: () => number;
  /** How long after a write or a record job to link; 0: only when run() is called. Default LINKER_DEBOUNCE_MS. */
  debounceMs?: number;
}

export interface LinkerRunStats {
  /** Records appended. */
  appended: number;
  repositories: number;
  ms: number;
}

export class LinkerJob {
  private readonly facts = new Map<string, Facts>();
  private readonly dirty = new Set<string>();
  /** No run yet: the first links every repository. */
  private first = true;
  private readonly locations = new Map<string, RepoLocation | undefined>();
  private running?: Promise<LinkerRunStats>;
  private timer?: NodeJS.Timeout;
  private readonly stopListening: () => void;
  private readonly log: (line: string) => void;
  private readonly git: GitRunner;
  private readonly clock: () => number;
  private readonly debounceMs: number;
  /** The last run's numbers. */
  last?: LinkerRunStats;

  constructor(private readonly home: string, private readonly writer: StoreWriter, opts: LinkerJobOptions = {}) {
    this.log = opts.log ?? (() => undefined);
    this.git = opts.git ?? runGit;
    this.clock = opts.clock ?? Date.now;
    this.debounceMs = opts.debounceMs ?? LINKER_DEBOUNCE_MS;
    this.stopListening = writer.onWritten((workspace, events) => this.observe(workspace, events));
  }

  dispose(): void {
    this.stopListening();
    if (this.timer) clearTimeout(this.timer);
  }

  /** Events written to a workspace: into its facts (when they're loaded; else they're read with the log), and a run soon. */
  observe(workspace: string, events: NormalizedEvent[]): void {
    const facts = this.facts.get(workspace);
    if (facts) for (const e of events) observeEvent(facts.sessions, e);
    this.schedule(workspace);
  }

  /** Something changed for a workspace (or, with none named, for all of them): link it after the debounce. */
  schedule(workspace?: string): void {
    if (workspace) this.dirty.add(workspace);
    else for (const s of listUserStores(this.home)) this.dirty.add(s.workspace);
    if (this.debounceMs <= 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run().catch((err) => this.log(`linking failed: ${err instanceof Error ? err.message : String(err)}`));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /**
   * Links the repositories with changes (or every one, with `full`, reading their events again).
   * A run already going is followed by one more, so nothing scheduled meanwhile is missed.
   */
  run(opts: { full?: boolean } = {}): Promise<LinkerRunStats> {
    if (opts.full) {
      this.facts.clear();
      this.locations.clear();
      for (const s of listUserStores(this.home)) this.dirty.add(s.workspace);
    }
    if (this.running) return this.running.then(() => this.run());
    this.running = this.runNow().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The facts the linker keeps of a workspace's sessions, loaded first if need be (the git outcomes job and the plans view read them). */
  async sessionsOf(workspace: string, dir: string): Promise<Map<string, SessionFacts>> {
    let facts = this.facts.get(workspace);
    if (!facts) {
      facts = { sessions: new Map() };
      this.facts.set(workspace, facts);
      const f = facts;
      f.loaded = (async () => {
        const log = new EventLog(dir);
        for (const day of await log.listDays()) for (const e of await log.readDay(day)) observeEvent(f.sessions, e);
      })();
    }
    await facts.loaded;
    return facts.sessions;
  }

  private async location(folder: string): Promise<RepoLocation | undefined> {
    if (!this.locations.has(folder)) this.locations.set(folder, fs.existsSync(folder) ? await locateRepo(folder, this.git) : undefined);
    return this.locations.get(folder);
  }

  private async runNow(): Promise<LinkerRunStats> {
    const started = this.clock();
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    const all = this.first;
    this.first = false;
    const today = new Date(started).toISOString().slice(0, 10);
    const groups = new Map<string, Member[]>();
    for (const store of listUserStores(this.home)) {
      if (!store.folder) continue;
      if (effectiveSettings(this.home, store.folder).values.collect === false) continue;
      const loc = await this.location(store.folder);
      const rawDays = Math.max(1, Math.floor(retentionPolicyFor(this.home, store.workspace).rawDays));
      const member: Member = { store, folder: store.folder, loc, file: path.join(store.dir, LINKS_FILE), cutoff: `${oldestKeptDay(today, rawDays)}T00:00:00.000Z` };
      const key = loc?.commonDir ?? store.folder;
      groups.set(key, [...(groups.get(key) ?? []), member]);
    }
    let appended = 0;
    let repositories = 0;
    for (const members of groups.values()) {
      if (!all && !members.some((m) => dirty.has(m.store.workspace))) continue;
      repositories += 1;
      try {
        appended += await this.link(members);
      } catch (err) {
        this.log(`links for ${members[0].folder}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const stats = { appended, repositories, ms: this.clock() - started };
    this.last = stats;
    if (appended > 0) this.log(`linked: ${appended} link record(s) in ${repositories} repositor${repositories === 1 ? 'y' : 'ies'}, ${stats.ms} ms`);
    return stats;
  }

  /** One repository (or a folder outside one): its links worked out once, then each store's share appended. */
  private async link(members: Member[]): Promise<number> {
    const commits = new Map<string, CommitRecord>();
    const branches = new Map<string, BranchRecord>();
    const checkouts = new Map<string, CheckoutRecord>();
    const items = new Map<string, PlanItemRecord>();
    const transitions = new Map<string, TransitionRecord>();
    for (const m of members) {
      for (const r of foldStoreFile<GitRecord>(path.join(m.store.dir, GIT_RECORDS_FILE)).values()) {
        if (r.record === 'commit') commits.set(r.sha, r);
        else if (r.record === 'branch') branches.set(r.id, furtherAlong(branches.get(r.id), r));
        else if (r.record === 'checkout') checkouts.set(r.id, r);
      }
      for (const r of foldStoreFile<PlanRecord>(path.join(m.store.dir, PLAN_RECORDS_FILE)).values()) {
        if (r.record === 'item') {
          const have = items.get(r.id);
          if (!have || r.updated > have.updated) items.set(r.id, r);
        } else if (r.record === 'transition') transitions.set(r.id, r);
      }
    }
    const workspaces = [];
    const sessionIds = new Set<string>();
    for (const m of members) {
      const facts = await this.sessionsOf(m.store.workspace, m.store.dir);
      for (const id of facts.keys()) sessionIds.add(id);
      workspaces.push({ workspace: m.store.workspace, where: m.loc?.toplevel ?? m.folder, sessions: facts.values() });
    }
    const computed = computeLinks({
      workspaces,
      commits: [...commits.values()],
      branches: [...branches.values()],
      checkouts: [...checkouts.values()],
      items: [...items.values()],
      transitions: [...transitions.values()],
      prefix: issuePrefix(members.map((m) => m.folder), items.values()),
    });
    let total = 0;
    for (const m of members) {
      const mine = computed.filter((c: ComputedLink) => {
        const at = storeRecordTime(c.link);
        return (c.workspace === undefined || c.workspace === m.store.workspace) && (at === undefined || at >= m.cutoff);
      });
      const append = linksToAppend(foldStoreFile<LinkRecord>(m.file), mine, computed, sessionIds);
      if (append.length === 0) continue;
      await this.writer.appendRecords(m.file, append);
      total += append.length;
    }
    return total;
  }
}

/** Of two lines of one branch's record from different stores, the further along: deleted, then merged. */
function furtherAlong(a: BranchRecord | undefined, b: BranchRecord): BranchRecord {
  if (!a) return b;
  const rank = (r: BranchRecord) => (r.deletedAt ? 2 : 0) + (r.merged ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}
