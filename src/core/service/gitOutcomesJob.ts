import * as fs from 'fs';
import * as path from 'path';
import { currentLinks, GitRecord, LinkRecord } from '@snagboat/schema';
import { effectiveSettings } from '../config';
import { EventLog } from '../eventLog';
import { foldStoreFile, readStoreRecordLines } from '../storeRecordFiles';
import { listUserStores } from '../userStore';
import { gitOutcomes, GitRunner, repositoryOf, runGit, SessionCommit, SURVIVAL_DAYS } from '../../outcomes/gitOutcomes';
import { GIT_RECORDS_FILE } from './gitRecordsJob';
import { LinkerJob, LINKS_FILE } from './linkerJob';
import { StoreWriter } from './storeWriter';

/**
 * The core's git outcomes run (RFC step 4b, outcomes/gitOutcomes.ts): every
 * few hours, for each workspace in the per-user store that's a folder in a git
 * repository, with `outcomes.git` and `collect` not turned off, it reads the
 * workspace's recent days and records the commit outcomes now due. One run at
 * a time; a workspace whose git fails is skipped and logged.
 *
 * Which session made a commit is the linker's: once a workspace's store has git.jsonl and
 * links.jsonl, its commits are the ones its session made commit links name (observed first),
 * with git.jsonl's times and files (storedSessionCommits). The linker runs first. A store
 * without them (the repository job hasn't run yet) is read the old way, `git log` and the same
 * rule (gitOutcomes.ts), so outcomes don't wait for it.
 *
 * Multi-root workspaces (.code-workspace) aren't read yet.
 */

export const GIT_OUTCOMES_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Enough days back to cover the latest check (code survival at 30 days) and the session before it. */
const DAYS_BACK = Math.max(...SURVIVAL_DAYS) + 2;

export class GitOutcomesJob {
  private running?: Promise<number>;

  constructor(
    private readonly home: string,
    private readonly writer: StoreWriter,
    private readonly log: (line: string) => void = () => undefined,
    private readonly git: GitRunner = runGit,
    private readonly linker?: LinkerJob
  ) {}

  /** Records the outcomes due now; how many. A run already going is joined, not repeated. */
  run(now = Date.now()): Promise<number> {
    this.running ??= this.runNow(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async runNow(now: number): Promise<number> {
    let total = 0;
    if (this.linker) await this.linker.run().catch((err) => this.log(`linking before git outcomes failed: ${err instanceof Error ? err.message : String(err)}`));
    const since = new Date(now - DAYS_BACK * 86_400_000).toISOString().slice(0, 10);
    for (const store of listUserStores(this.home)) {
      if (!store.folder) continue;
      const settings = effectiveSettings(this.home, store.folder).values;
      if (settings['outcomes.git'] === false || settings.collect === false) continue;
      try {
        const repo = await repositoryOf(store.folder, this.git);
        if (!repo) continue;
        const log = new EventLog(store.dir);
        const events = [];
        for (const day of await log.listDays()) if (day >= since) events.push(...(await log.readDay(day)));
        const outcomes = await gitOutcomes({ repo, events, now, git: this.git, workspace: store.workspace, commits: storedSessionCommits(store.dir) });
        if (outcomes.length === 0) continue;
        const { written } = await this.writer.write(outcomes);
        total += written;
      } catch (err) {
        this.log(`git outcomes for ${store.folder}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (total > 0) this.log(`recorded ${total} git outcome(s)`);
    return total;
  }
}

/**
 * The commits a store's session made commit links name, one session each (an observed link
 * first), with git.jsonl's commit times and files; undefined when the store has no git.jsonl or
 * links.jsonl yet.
 */
export function storedSessionCommits(dir: string): SessionCommit[] | undefined {
  const gitFile = path.join(dir, GIT_RECORDS_FILE);
  const linksFile = path.join(dir, LINKS_FILE);
  if (!fs.existsSync(gitFile) || !fs.existsSync(linksFile)) return undefined;
  const git = foldStoreFile<GitRecord>(gitFile);
  const bySha = new Map<string, LinkRecord>();
  for (const l of currentLinks(readStoreRecordLines<LinkRecord>(linksFile))) {
    if (l.kind !== 'made' || l.from.type !== 'session' || l.to.type !== 'commit') continue;
    const have = bySha.get(l.to.id);
    if (!have || (have.confidence === 'inferred' && l.confidence === 'observed')) bySha.set(l.to.id, l);
  }
  const out: SessionCommit[] = [];
  for (const [sha, l] of bySha) {
    const c = git.get(`commit:${sha}`);
    if (c?.record !== 'commit') continue;
    out.push({ sessionId: l.from.id, sha, at: Date.parse(c.committedAt), files: c.files.map((f) => f.path) });
  }
  return out.sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha));
}
