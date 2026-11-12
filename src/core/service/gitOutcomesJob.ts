import { effectiveSettings } from '../config';
import { EventLog } from '../eventLog';
import { listUserStores } from '../userStore';
import { gitOutcomes, GitRunner, repositoryOf, runGit, SURVIVAL_DAYS } from '../../outcomes/gitOutcomes';
import { StoreWriter } from './storeWriter';

/**
 * The core's git outcomes run (RFC step 4b, outcomes/gitOutcomes.ts): every
 * few hours, for each workspace in the per-user store that's a folder in a git
 * repository, with `outcomes.git` and `collect` not turned off, it reads the
 * workspace's recent days and records the commit outcomes now due. One run at
 * a time; a workspace whose git fails is skipped and logged.
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
    private readonly git: GitRunner = runGit
  ) {}

  /** Records the outcomes due now; how many. A run already going is joined, not repeated. */
  run(now = Date.now()): Promise<number> {
    this.running ??= this.runNow(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async runNow(now: number): Promise<number> {
    let total = 0;
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
        const outcomes = await gitOutcomes({ repo, events, now, git: this.git, workspace: store.workspace });
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
