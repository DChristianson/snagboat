import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent, setShellSubCategories } from '@snagboat/schema';
import { configHost, loadConfig } from '../config';
import { ContextLimits } from '../contextLimits';
import { EventLog } from '../eventLog';
import { EventStore } from '../eventStore';
import { userDataDir, workspaceInfoOf, workspaceStoreDir } from '../userStore';
import { builtInHeuristics, heuristicSettingsSection } from '../../heuristics';
import { EVENT_STORE_MAX_EVENTS, EVENT_STORE_WINDOW_MS, HeuristicsEngine } from '../../heuristics/engine';
import { buildRuleSet, RuleSource } from '../../heuristics/rule';
import { ruleHeuristic } from '../../heuristics/ruleHeuristic';
import { RuleStore } from '../../heuristics/ruleStore';
import { Finding, Progress } from '../../heuristics/types';

/**
 * Heuristics in the core (3c-3d): the findings for a workspace, worked out
 * where its events are written, so every front door sees the same ones. A
 * VS Code window that's a client gets them on its event stream and only
 * delivers them (status bar, notifications); `GET /findings` answers anyone
 * else.
 *
 * A workspace is evaluated while something follows it (a client's stream),
 * after each batch written to it and on a timer (some heuristics, such as
 * "stalled", fire on the absence of events). Each keeps the same recent
 * window of events a window keeps (EventStore), seeded from the last days of
 * its log. Its heuristics are the built-ins plus the rules in
 * ~/.snagboat/rules.json and its settings' "rules", with its own settings
 * (config.json, .snagboat.json); they're rebuilt when those change.
 *
 * Tool categories ("toolCategories") label shell calls process-wide, as the
 * collectors normalize every project's events, so the core uses only the
 * user's (rules.json and config.json "defaults"), never a project's own, and
 * sets them only when those change.
 */

export interface WorkspaceFindings {
  workspace: string;
  findings: Finding[];
  progress: Progress[];
  /** Rule and tool-category problems in this workspace's rules, if any. */
  problems: string[];
  at: string;
}

interface Watch {
  workspace: string;
  store: EventStore;
  engine?: HeuristicsEngine;
  /** What the engine was built from: rules.json's mtime and the settings rules. */
  built?: string;
  problems: string[];
  /** The last result sent, without times, to tell a change. */
  last?: string;
  followers: number;
  /** Evaluations of this workspace, one at a time. */
  queue: Promise<unknown>;
  /** An evaluation queued and not yet started: more events wait for it rather than queue another. */
  pending?: Promise<void>;
}

export interface FindingsServiceOptions {
  home: string;
  /** Told when a followed workspace's findings or early warnings change. */
  onChange: (result: WorkspaceFindings) => void;
  /** The folder whose settings a workspace uses; a .code-workspace file's first folder, which its window registered. */
  settingsDir?: (workspace: string) => string | undefined;
  log?: (line: string) => void;
  now?: () => number;
}

export class FindingsService {
  private readonly watches = new Map<string, Watch>();
  private readonly contextLimits: ContextLimits;
  private loaded?: Promise<void>;
  /** The user-level tool categories last set process-wide. */
  private categories?: string;

  constructor(private readonly opts: FindingsServiceOptions) {
    this.contextLimits = new ContextLimits(userDataDir(opts.home));
  }

  private now(): string {
    return new Date((this.opts.now ?? Date.now)()).toISOString();
  }

  private load(): Promise<void> {
    this.loaded ??= this.contextLimits.load().catch(() => undefined);
    return this.loaded;
  }

  /** Evaluates the workspace from now on (ref-counted); returns the function that stops following it. */
  async follow(workspace: string): Promise<() => void> {
    const watch = await this.watch(workspace);
    watch.followers += 1;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      watch.followers -= 1;
      if (watch.followers <= 0 && this.watches.get(workspace) === watch) this.watches.delete(workspace);
    };
  }

  /**
   * The workspace's findings now, evaluated if nothing follows it. A followed
   * one is also published if it changed, so a client that just changed its
   * rules or settings sees the result on its stream.
   */
  async current(workspace: string): Promise<WorkspaceFindings> {
    const followed = this.watches.get(workspace);
    if (followed) await this.publish(followed);
    const watch = followed ?? (await this.seed(workspace));
    return this.serial(watch, () => this.evaluate(watch));
  }

  /** A batch written to a workspace: re-evaluated if it's followed. */
  ingest(workspace: string, events: NormalizedEvent[]): void {
    for (const e of events) this.contextLimits.observe(e);
    const watch = this.watches.get(workspace);
    if (!watch) return;
    for (const e of events) watch.store.ingest(e);
    void this.publish(watch);
  }

  /** Re-evaluates every followed workspace (the core's timer). */
  tick(): void {
    for (const watch of this.watches.values()) void this.publish(watch);
  }

  /** Saves what it learned of models' context limits. */
  dispose(): Promise<void> {
    return this.contextLimits.dispose();
  }

  private async watch(workspace: string): Promise<Watch> {
    const existing = this.watches.get(workspace);
    if (existing) return existing;
    const watch = await this.seed(workspace);
    // Another follow may have seeded it meanwhile.
    const raced = this.watches.get(workspace);
    if (raced) return raced;
    this.watches.set(workspace, watch);
    return watch;
  }

  /** A workspace's recent window of events, read from the last days of its log. */
  private async seed(workspace: string): Promise<Watch> {
    await this.load();
    const store = new EventStore({ windowMs: EVENT_STORE_WINDOW_MS, maxEvents: EVENT_STORE_MAX_EVENTS });
    const log = new EventLog(workspaceStoreDir(this.opts.home, workspace));
    const since = new Date((this.opts.now ?? Date.now)() - EVENT_STORE_WINDOW_MS - 86_400_000).toISOString().slice(0, 10);
    for (const day of await log.listDays()) {
      if (day < since) continue;
      for (const e of await log.readDay(day)) {
        store.ingest(e);
        this.contextLimits.observe(e);
      }
    }
    return { workspace, store, problems: [], followers: 0, queue: Promise.resolve() };
  }

  private serial<T>(watch: Watch, op: () => Promise<T>): Promise<T> {
    const run = watch.queue.then(op);
    watch.queue = run.catch(() => undefined);
    return run;
  }

  /** Evaluates and tells onChange if something changed; at most one waits per workspace. Never rejects. */
  private publish(watch: Watch): Promise<void> {
    if (watch.pending) return watch.pending;
    watch.pending = this.serial(watch, async () => {
      // From here on, new events need another evaluation.
      watch.pending = undefined;
      let result: WorkspaceFindings;
      try {
        result = await this.evaluate(watch);
      } catch (err) {
        this.opts.log?.(`heuristics failed for ${watch.workspace}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    // detectedAt moves on every run; a change is in what's found.
    const key = JSON.stringify([result.findings.map((f) => ({ ...f, detectedAt: undefined })), result.progress, result.problems]);
      if (key === watch.last) return;
      watch.last = key;
      this.opts.onChange(result);
    });
    return watch.pending;
  }

  /** The workspace's last result, evaluated now (sent to a stream when it opens). */
  async latest(workspace: string): Promise<WorkspaceFindings | undefined> {
    const watch = this.watches.get(workspace);
    return watch ? this.serial(watch, () => this.evaluate(watch)) : undefined;
  }

  private async evaluate(watch: Watch): Promise<WorkspaceFindings> {
    const folder = workspaceInfoOf(watch.workspace).folder ?? this.opts.settingsDir?.(watch.workspace) ?? watch.workspace;
    const host = configHost(this.opts.home, folder);
    await this.rebuild(watch, host);
    const now = this.now();
    const findings = [...watch.engine!.tick(now).values()].flat();
    return { workspace: watch.workspace, findings, progress: watch.engine!.progress(now), problems: watch.problems, at: now };
  }

  /** (Re)builds the workspace's heuristics when its rules changed. */
  private async rebuild(watch: Watch, host: ReturnType<typeof configHost>): Promise<void> {
    const rulesFile = path.join(this.opts.home, 'rules.json');
    let mtime = 0;
    try {
      mtime = fs.statSync(rulesFile).mtimeMs;
    } catch {
      // no saved rules
    }
    const list = (key: string): unknown[] => {
      const value = host.get<unknown>('snagboat', key, []);
      return Array.isArray(value) ? value : [];
    };
    // Rules are the workspace's own; tool categories only ever the user's (config.json "defaults").
    const userCategories = loadConfig(this.opts.home).config.defaults.toolCategories;
    const settingsSource: RuleSource = { origin: 'settings', rules: list('rules'), categories: Array.isArray(userCategories) ? userCategories : [] };
    const built = JSON.stringify([mtime, settingsSource]);
    if (watch.engine && built === watch.built) return;
    const store = new RuleStore(this.opts.home);
    const problems: string[] = [];
    try {
      await store.load();
    } catch (err) {
      problems.push(`saved rules couldn't be read and are off until the file is fixed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ruleSet = buildRuleSet([store.source(), settingsSource]);
    const categories = JSON.stringify(ruleSet.categories);
    if (categories !== this.categories) {
      this.categories = categories;
      setShellSubCategories(ruleSet.categories);
    }
    const heuristics = [...builtInHeuristics(), ...ruleSet.rules.map(ruleHeuristic)];
    const settingsFor = (id: string) => (id.includes(':') ? {} : host.section(heuristicSettingsSection(id)));
    watch.engine = new HeuristicsEngine(heuristics, watch.store, settingsFor, (model) => (model ? this.contextLimits.get(model)?.limit : undefined));
    watch.built = built;
    watch.problems = [...problems, ...ruleSet.problems];
  }
}
