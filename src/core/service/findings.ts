import * as fs from 'fs';
import * as path from 'path';
import { FindingRecord, NormalizedEvent, setShellSubCategories } from '@snagboat/schema';
import { configHost, loadConfig } from '../config';
import { ContextLimits, ModelContextMarks } from '../contextLimits';
import { EventLog } from '../eventLog';
import { EventStore } from '../eventStore';
import { findingId, readFindings, ruleVersion } from '../findingRecords';
import { userDataDir, workspaceInfoOf, workspaceStoreDir } from '../userStore';
import { builtInHeuristics, heuristicSettingsSection } from '../../heuristics';
import { EVENT_STORE_MAX_EVENTS, EVENT_STORE_WINDOW_MS, HeuristicsEngine } from '../../heuristics/engine';
import { buildRuleSet, Rule, RuleSource } from '../../heuristics/rule';
import { ruleHeuristic } from '../../heuristics/ruleHeuristic';
import { RuleStore } from '../../heuristics/ruleStore';
import { FindingReplay } from '../../heuristics/replay';
import { Finding, Heuristic, Progress } from '../../heuristics/types';
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
  /** Its heuristics and their settings, as last built, for replaying a session (newReplay). */
  heuristics?: Heuristic[];
  /** The rules among them, as data (discovery's worker builds its heuristics from them). */
  rules?: Rule[];
  settingsFor?: (id: string) => Record<string, unknown>;
  /** Each open episode as shown so far, by heuristic: for its findings.jsonl record when it closes. */
  shown: Map<string, ShownEpisode>;
  /** Heuristics showing an early warning and no finding yet: an episode that starts from one was warned early. */
  warned: Set<string>;
  /** Each heuristic's version when it was last built (a deleted rule keeps its last). */
  versions: Map<string, string>;
}

/** What an open episode has shown: the latest summary, every event it named, and whether an early warning came first. */
interface ShownEpisode {
  summary?: string;
  eventRefs: Set<string>;
  earlyWarning: boolean;
}

/** The most events one finding record names. */
const MAX_FINDING_REFS = 200;

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
  /** Appends finding episodes to the workspace's findings.jsonl (each as it closes, and again when a response lands). */
  store?: (workspace: string, records: FindingRecord[]) => void;
  /** Snagboat's version: a built-in heuristic's version in findings.jsonl. Default 'dev'. */
  version?: string;
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
    this.responsesLanded(workspace, events);
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

  /**
   * For a session page (RFC step 5b): the workspace's findings now, and a
   * fresh replay of its own heuristics with its own settings to find a
   * session's past ones, as VS Code's Sessions tab replays them.
   */
  async forSessions(workspace: string): Promise<{ current: WorkspaceFindings; newReplay: () => FindingReplay }> {
    const current = await this.current(workspace);
    const { heuristics, settingsFor, contextLimit } = await this.heuristicsFor(workspace, false);
    return { current, newReplay: () => new FindingReplay(heuristics, settingsFor, contextLimit) };
  }

  /**
   * The workspace's heuristics (built-ins and its rules) with its own settings, as last built, for
   * discovery (step 5c-2) and session replays. Evaluated first unless the caller just did.
   */
  async heuristicsFor(workspace: string, evaluate = true): Promise<{ heuristics: Heuristic[]; rules: Rule[]; settingsFor: (id: string) => Record<string, unknown>; contextLimit: (model: string | undefined) => number | undefined }> {
    if (evaluate) await this.current(workspace);
    const watch = await this.watch(workspace);
    return {
      heuristics: watch.heuristics ?? builtInHeuristics(),
      rules: watch.heuristics ? (watch.rules ?? []) : [],
      settingsFor: watch.settingsFor ?? (() => ({})),
      contextLimit: (model) => (model ? this.contextLimits.get(model)?.limit : undefined),
    };
  }

  /** What the core has learned of each model's context (the timelines' marks). */
  contextMarks(): Record<string, ModelContextMarks> {
    return this.contextLimits.all();
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
    const watch = { workspace, store, problems: [], followers: 0, queue: Promise.resolve(), heuristicIds: new Set<string>(), lastActivity: this.nowMs(), shown: new Map(), warned: new Set(), versions: new Map() } as unknown as Watch;
    watch.book = new ResponseBook(
      workspaceStoreDir(this.opts.home, workspace),
      (episode, refs) => {
        this.recordEpisode(watch, episode, refs);
        this.recordResponse(watch, episode, refs);
      },
      () => this.now()
    );
    return watch;
  }

  /**
   * An ended episode into findings.jsonl, as it was shown: its heuristic's version, the session
   * and turn of its latest event still in reach, its worst severity, latest summary, every event
   * it named, whether an early warning came first, and how you met it.
   */
  private recordEpisode(watch: Watch, episode: ResponseEpisode, refs: string[]): void {
    const shown = watch.shown.get(episode.heuristicId);
    watch.shown.delete(episode.heuristicId);
    if (!episode.endedAt || !this.opts.store) return;
    const named = [...new Set([...(shown?.eventRefs ?? []), ...refs])];
    const wanted = new Set(named);
    const ref = watch.store.query().filter((e) => wanted.has(e.eventId)).pop();
    const record: FindingRecord = {
      record: 'finding',
      version: 1,
      id: findingId(episode.heuristicId, ref?.sessionId, episode.startedAt),
      heuristicId: episode.heuristicId,
      heuristicVersion: watch.versions.get(episode.heuristicId) ?? this.opts.version ?? 'dev',
      ...(ref ? { sessionId: ref.sessionId } : {}),
      ...(ref?.turnId ? { turnId: ref.turnId } : {}),
      severity: episode.severity,
      ...(shown?.summary !== undefined ? { summary: shown.summary } : {}),
      firstTs: episode.startedAt,
      lastTs: episode.endedAt,
      eventRefs: named.slice(0, MAX_FINDING_REFS),
      earlyWarning: shown?.earlyWarning ?? false,
      response: episodeResponse(episode),
    };
    this.opts.store(watch.workspace, [record]);
  }

  /**
   * finding_response outcomes written to a workspace: an episode in its findings.jsonl whose
   * response differs is appended again under its id with the response that landed.
   */
  private responsesLanded(workspace: string, events: NormalizedEvent[]): void {
    if (!this.opts.store) return;
    const responses = events.filter((e) => e.kind === 'outcome' && e.outcome?.type === 'finding_response' && e.outcome.heuristicId && e.outcome.response);
    if (responses.length === 0) return;
    let stored: Map<string, FindingRecord> | undefined;
    const changed: FindingRecord[] = [];
    for (const e of responses) {
      const heuristicId = e.outcome!.heuristicId!;
      const prefix = `outcome:finding_response:${heuristicId}:`;
      if (!e.eventId.startsWith(prefix)) continue;
      const id = findingId(heuristicId, e.sessionId, e.eventId.slice(prefix.length));
      stored ??= readFindings(workspaceStoreDir(this.opts.home, workspace));
      const have = stored.get(id);
      if (!have || have.response === e.outcome!.response) continue;
      const next = { ...have, response: e.outcome!.response! };
      stored.set(id, next);
      changed.push(next);
    }
    if (changed.length > 0) this.opts.store(workspace, changed);
  }

  /** This evaluation's findings and early warnings, onto each open episode as shown. */
  private trackShown(watch: Watch, findings: Finding[], progress: Progress[]): void {
    const byId = new Map<string, Finding[]>();
    for (const f of findings) byId.set(f.heuristicId, [...(byId.get(f.heuristicId) ?? []), f]);
    const warning = new Set(progress.map((p) => p.heuristicId));
    for (const id of warning) if (!byId.has(id)) watch.warned.add(id);
    for (const id of [...watch.warned]) if (!warning.has(id) && !byId.has(id)) watch.warned.delete(id);
    for (const [id, list] of byId) {
      let shown = watch.shown.get(id);
      if (!shown) {
        shown = { eventRefs: new Set(), earlyWarning: watch.warned.has(id) };
        watch.shown.set(id, shown);
        watch.warned.delete(id);
      }
      // The one shown: the worst, latest.
      const top = [...list].sort((a, b) => (a.severity === b.severity ? b.detectedAt.localeCompare(a.detectedAt) : a.severity === 'warn' ? -1 : 1))[0];
      shown.summary = top.summary;
      for (const f of list) for (const r of f.eventRefs) if (shown.eventRefs.size < MAX_FINDING_REFS) shown.eventRefs.add(r);
    }
  }

  /** An ended episode as a finding_response outcome. */
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
    const progress = watch.engine!.progress(now);
    // An episode starts with the first evaluation that shows it, so what it showed is noted before the book can end one.
    this.trackShown(watch, findings, progress);
    watch.book.update(findings);
    return { workspace: watch.workspace, findings, progress, problems: watch.problems, responses: watch.book.states(), muted: watch.book.mutedHeuristics(), at: now };
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
    // Versions for findings.jsonl: a built-in's is Snagboat's; a saved rule's, a hash of its definition.
    const rules = new Map(ruleSet.rules.map((r) => [r.id, ruleVersion(r)]));
    for (const h of heuristics) watch.versions.set(h.id, rules.get(h.id) ?? this.opts.version ?? 'dev');
    const settingsFor = (id: string) => (id.includes(':') ? {} : host.section(heuristicSettingsSection(id)));
    watch.heuristics = heuristics;
    watch.rules = ruleSet.rules;
    watch.settingsFor = settingsFor;
    watch.engine = new HeuristicsEngine(heuristics, watch.store, settingsFor, (model) => (model ? this.contextLimits.get(model)?.limit : undefined));
    watch.built = built;
    watch.problems = [...problems, ...ruleSet.problems];
  }
}
