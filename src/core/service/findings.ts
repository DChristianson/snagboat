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
import { episodeResponse, ResponseEpisode } from '../../heuristics/responses';
import { OUTCOMES_ADAPTER } from '../../outcomes/testsGreen';
import { FindingState, Response, ResponseBook } from './responses';

/**
 * Heuristics in the core (3c-3d): the findings for a workspace, worked out
 * where its events are written, so every front door sees the same ones. A
 * VS Code window that's a client gets them on its event stream and only
 * delivers them (status bar, notifications); `GET /findings` answers anyone
 * else.
 *
 * A workspace is evaluated while something follows it (a client's stream) or
 * while it has activity (events or responses in the last day), whether or not
 * VS Code has it open; how you meet its findings is kept here too
 * (responses.ts),
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
  /** How you've met them (any front door, through the core): per heuristic with findings now, and every muted one. */
  responses: Record<string, FindingState>;
  muted: string[];
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
  /** How you've met its findings. */
  book: ResponseBook;
  /** Its heuristics' ids, as last built (a deleted rule's ended episode records no outcome). */
  heuristicIds: Set<string>;
  /** When it last had events or a response: a workspace nothing follows is let go after a day quiet. */
  lastActivity: number;
}

export interface FindingsServiceOptions {
  home: string;
  /** Told when a followed workspace's findings or early warnings change. */
  onChange: (result: WorkspaceFindings) => void;
  /** The folder whose settings a workspace uses; a .code-workspace file's first folder, which its window registered. */
  settingsDir?: (workspace: string) => string | undefined;
  log?: (line: string) => void;
  now?: () => number;
  /** Writes outcome events (finding_response) for a workspace. */
  record?: (workspace: string, events: NormalizedEvent[]) => void;
}

/** A workspace nothing follows is evaluated this long after its last activity. */
const ACTIVE_FOR_MS = 24 * 60 * 60_000;
/** A finding that passed unanswered in less time than this isn't recorded as an outcome: it flickered. */
const MIN_PASSED_EPISODE_MS = 30_000;

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
      // Kept while it has activity (tick() lets it go after a quiet day): its response book lives on it.
      watch.followers -= 1;
    };
  }

  /**
   * The workspace's findings now, evaluated if nothing follows it. A followed
   * one is also published if it changed, so a client that just changed its
   * rules or settings sees the result on its stream.
   */
  async current(workspace: string): Promise<WorkspaceFindings> {
    const existed = this.watches.has(workspace);
    const watch = await this.watch(workspace);
    if (existed) await this.publish(watch);
    return this.serial(watch, () => this.evaluate(watch));
  }

  /**
   * A batch written to a workspace: re-evaluated. A workspace with activity is
   * evaluated whether or not a window follows it, so its findings, episodes and
   * your responses carry on without VS Code.
   */
  ingest(workspace: string, events: NormalizedEvent[]): void {
    for (const e of events) this.contextLimits.observe(e);
    const watch = this.watches.get(workspace);
    if (!watch) {
      // Seeded from its log, which already holds this batch.
      void this.watch(workspace)
        .then((w) => this.publish(w))
        .catch((err) => this.opts.log?.(`couldn't start evaluating ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    watch.lastActivity = this.nowMs();
    for (const e of events) watch.store.ingest(e);
    void this.publish(watch);
  }

  /** Re-evaluates every watched workspace (the core's timer); lets go of ones a day quiet that nothing follows. */
  tick(): void {
    const now = this.nowMs();
    for (const [workspace, watch] of this.watches) {
      if (watch.followers <= 0 && now - watch.lastActivity > ACTIVE_FOR_MS) {
        watch.book.close();
        this.watches.delete(workspace);
        continue;
      }
      void this.publish(watch);
    }
  }

  /** A response to a finding from any front door: kept, and the workspace's findings sent again with it. */
  async respond(workspace: string, heuristicId: string, response: Response): Promise<FindingState> {
    const watch = await this.watch(workspace);
    watch.lastActivity = this.nowMs();
    // Evaluated first, so the book knows which findings are active now.
    await this.serial(watch, () => this.evaluate(watch));
    const state = watch.book.respond(heuristicId, response);
    watch.last = undefined;
    await this.publish(watch);
    return state;
  }

  /** Writes open episodes and saves what it learned of models' context limits. */
  dispose(): Promise<void> {
    for (const watch of this.watches.values()) watch.book.close();
    return this.contextLimits.dispose();
  }

  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
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
    const watch = { workspace, store, problems: [], followers: 0, queue: Promise.resolve(), heuristicIds: new Set<string>(), lastActivity: this.nowMs() } as unknown as Watch;
    watch.book = new ResponseBook(workspaceStoreDir(this.opts.home, workspace), (episode, refs) => this.recordResponse(watch, episode, refs));
    return watch;
  }

  /** An ended episode as a finding_response outcome, as a window writing its own folder records it. */
  private recordResponse(watch: Watch, episode: ResponseEpisode, refs: string[]): void {
    const endedAt = episode.endedAt;
    if (!endedAt || !this.opts.record) return;
    const response = episodeResponse(episode);
    // A finding that came and went within seconds unanswered says nothing about its use; nor does a rule you deleted.
    if (response === 'passed' && Date.parse(endedAt) - Date.parse(episode.startedAt) < MIN_PASSED_EPISODE_MS) return;
    if (!watch.heuristicIds.has(episode.heuristicId)) return;
    // Filed in the session of the finding's latest event still in reach.
    const wanted = new Set(refs);
    const ref = watch.store.query().filter((e) => wanted.has(e.eventId)).pop();
    if (!ref) return;
    this.opts.record(watch.workspace, [
      {
        eventId: `outcome:finding_response:${episode.heuristicId}:${episode.startedAt}`,
        sessionId: ref.sessionId,
        agent: ref.agent,
        ts: endedAt,
        kind: 'outcome',
        status: 'unknown',
        outcome: { type: 'finding_response', heuristicId: episode.heuristicId, response, refs },
        raw: { adapter: OUTCOMES_ADAPTER, ref: `finding:${episode.heuristicId}:${episode.startedAt}` },
      },
    ]);
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
    const key = JSON.stringify([result.findings.map((f) => ({ ...f, detectedAt: undefined })), result.progress, result.problems, result.responses, result.muted]);
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
    watch.book.update(findings);
    return { workspace: watch.workspace, findings, progress: watch.engine!.progress(now), problems: watch.problems, responses: watch.book.states(), muted: watch.book.mutedHeuristics(), at: now };
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
    watch.heuristicIds = new Set(heuristics.map((h) => h.id));
    const settingsFor = (id: string) => (id.includes(':') ? {} : host.section(heuristicSettingsSection(id)));
    watch.engine = new HeuristicsEngine(heuristics, watch.store, settingsFor, (model) => (model ? this.contextLimits.get(model)?.limit : undefined));
    watch.built = built;
    watch.problems = [...problems, ...ruleSet.problems];
  }
}
