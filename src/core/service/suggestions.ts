import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { configHost, loadConfig, saveConfig } from '../config';
import { EventLog } from '../eventLog';
import { readDismissed, writeDismissed } from '../suggestionsState';
import { workspaceInfoOf, workspaceStoreDir } from '../userStore';
import { heuristicSettingsSection } from '../../heuristics';
import { RuleSource } from '../../heuristics/rule';
import { RuleStore } from '../../heuristics/ruleStore';
import { SuggestionsController, SuggestionsView } from '../../discovery/suggestionsController';
import { runDiscovery } from '../../discovery/discover';
import { AsyncDiscoveryRun, DEFAULT_WORKER_IDLE_MS, DiscoveryData, discoverOffThread, discoveryOptionsOf, inProcess, OffThreadRun, workerAvailable } from '../../discovery/offThread';
import { FindingsService } from './findings';
import { CoreAdvisorChoice, CoreAdvisors, PendingApproval } from './advisorModels';
import { proposeHeuristicsMessages } from '../../advisor/proposeHeuristics';

/**
 * Suggestions in the advisor UI (RFC step 5c-2): discovery over a workspace's history,
 * candidate rules with their replayed scores, built-in thresholds against your history,
 * shell sub-categories, and your saved rules, served by the core so no front door needs
 * VS Code. One SuggestionsController per workspace, the same one VS Code's Suggestions
 * tab runs, over the core's store and the workspace's own heuristics and settings.
 *
 * Writes go where VS Code's go: accepted rules and categories to the saved rules
 * (~/.snagboat/rules.json), a built-in's threshold to your user settings (config.json's
 * defaults, which a VS Code window with the per-user store on takes into its settings),
 * dismissals to suggestions.json. Advisor proposals (step 5c-2b) ask local models only, after you
 * approve the exact payload in the page (advisorModels.ts).
 *
 * Discovery and re-scoring a tweaked threshold run in a worker thread (discovery/offThread.ts), so the
 * core keeps answering hooks, event posts and the UI meanwhile; without the worker's script beside
 * the core's (a build that left it out), they run in process. A workspace's worker is stopped after
 * sitting idle (workerIdleMs) and brought back over the same history on the next tweak or score.
 */

export type SuggestionAction =
  | { action: 'discover' }
  | { action: 'tweak'; id: string; threshold: number }
  | { action: 'accept'; id: string }
  | { action: 'acceptCategory'; id: string }
  | { action: 'dismiss'; id: string }
  | { action: 'clearDismissed' }
  | { action: 'applyThreshold'; heuristic: string; setting: string }
  | { action: 'removeSaved'; section: 'rules' | 'categories'; id: string }
  | { action: 'askAdvisor'; advisorId?: string }
  | { action: 'applyAdvisorThreshold'; heuristic: string; setting: string }
  | { action: 'approve'; id: string; send: boolean };

/** What the page shows beside VS Code's Suggestions view: the local advisors, a request waiting for approval, an error. */
export interface CoreAdvice {
  advisors: CoreAdvisorChoice[];
  approval?: PendingApproval;
  error?: string;
}

export type CoreSuggestionsView = SuggestionsView & { core: CoreAdvice };

/** The action a request names, checked; undefined when it isn't one. */
export function parseSuggestionAction(body: unknown): SuggestionAction | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => typeof b[k] === 'string' && (b[k] as string).length > 0 && (b[k] as string).length <= 200;
  switch (b.action) {
    case 'discover':
    case 'clearDismissed':
      return { action: b.action };
    case 'tweak':
      return str('id') && typeof b.threshold === 'number' && Number.isFinite(b.threshold) ? { action: 'tweak', id: b.id as string, threshold: b.threshold } : undefined;
    case 'accept':
    case 'acceptCategory':
    case 'dismiss':
      return str('id') ? { action: b.action, id: b.id as string } : undefined;
    case 'applyThreshold':
      return str('heuristic') && str('setting') ? { action: 'applyThreshold', heuristic: b.heuristic as string, setting: b.setting as string } : undefined;
    case 'removeSaved':
      return (b.section === 'rules' || b.section === 'categories') && str('id') ? { action: 'removeSaved', section: b.section, id: b.id as string } : undefined;
    case 'askAdvisor':
      return b.advisorId === undefined ? { action: 'askAdvisor' } : str('advisorId') ? { action: 'askAdvisor', advisorId: b.advisorId as string } : undefined;
    case 'applyAdvisorThreshold':
      return str('heuristic') && str('setting') ? { action: 'applyAdvisorThreshold', heuristic: b.heuristic as string, setting: b.setting as string } : undefined;
    case 'approve':
      return str('id') && typeof b.send === 'boolean' ? { action: 'approve', id: b.id as string, send: b.send } : undefined;
    default:
      return undefined;
  }
}

/** An approval for a request that's no longer waiting (answered elsewhere, or timed out). */
export class NotWaiting extends Error {
  constructor() {
    super('that request is no longer waiting for approval');
  }
}

interface Entry {
  controller: SuggestionsController;
  store: RuleStore;
  names: Map<string, string>;
  /** The last advisor request's failure, shown until the next one. */
  error?: string;
  /** The latest discovery's worker-backed run, when discovery ran in a worker. */
  run?: OffThreadRun;
}

export interface SuggestionsOptions {
  /** The local advisors asked for proposals; default the user's own (advisorModels.ts). */
  advisors?: CoreAdvisors;
  /** Stop a workspace's discovery worker after this long with nothing asked of it; 0 never. Default 15 minutes. */
  workerIdleMs?: number;
}

export class SuggestionsService {
  private readonly entries = new Map<string, Entry>();
  /** Set once the worker's script turned out missing. */
  private inProcess = false;

  private readonly advisors: CoreAdvisors;

  constructor(
    private readonly home: string,
    private readonly findings: FindingsService,
    private readonly log: (line: string) => void = () => undefined,
    private readonly options: SuggestionsOptions = {}
  ) {
    this.advisors = options.advisors ?? new CoreAdvisors(home, undefined, log);
  }

  /** The Suggestions view for a workspace; discovery runs on the first ask, then on Discover again. */
  async view(workspace: string): Promise<CoreSuggestionsView> {
    const entry = await this.entry(workspace);
    if (entry.controller.view().status === 'idle') {
      void entry.controller.discover().catch((err) => this.log(`discovery failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
    }
    return this.withAdvice(entry);
  }

  private withAdvice(entry: Entry): CoreSuggestionsView {
    const approval = this.advisors.pendingApproval();
    return {
      ...entry.controller.view(),
      core: { advisors: this.advisors.choices('propose-heuristics'), ...(approval ? { approval } : {}), ...(entry.error ? { error: entry.error } : {}) },
    };
  }

  async act(workspace: string, a: SuggestionAction): Promise<CoreSuggestionsView> {
    const entry = await this.entry(workspace);
    const c = entry.controller;
    switch (a.action) {
      case 'discover':
        void c.discover().catch((err) => this.log(`discovery failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
        break;
      case 'tweak':
        await c.tweak(a.id, a.threshold);
        break;
      case 'accept':
        await c.accept(a.id);
        break;
      case 'acceptCategory':
        await c.acceptCategory(a.id);
        break;
      case 'dismiss':
        await c.dismiss(a.id);
        break;
      case 'clearDismissed':
        await c.clearDismissed();
        break;
      case 'applyThreshold':
        await c.applyThreshold(a.heuristic, a.setting);
        break;
      case 'removeSaved':
        await c.removeSaved(a.section, a.id);
        break;
      case 'askAdvisor':
        // Runs on: the request may wait for your approval, which a later POST gives (approve).
        entry.error = undefined;
        void c.askAdvisor(a.advisorId).catch((err) => (entry.error = err instanceof Error ? err.message : String(err)));
        // The controller marks itself asking after a step of its own; let it, so the view returned says so and
        // the page keeps looking until the request waits for approval or is answered.
        await new Promise((r) => setImmediate(r));
        break;
      case 'applyAdvisorThreshold':
        await c.applyAdvisorThreshold(a.heuristic, a.setting);
        break;
      case 'approve':
        if (!this.advisors.decide(a.id, a.send)) throw new NotWaiting();
        break;
    }
    return this.withAdvice(entry);
  }

  /** Stops every workspace's discovery worker. */
  dispose(): void {
    for (const entry of this.entries.values()) entry.controller.dispose();
    this.entries.clear();
  }

  /** Whether a workspace's discovery worker is up, and how often it was brought back; undefined without one (for tests). */
  worker(workspace: string): { running: boolean; restarts: number } | undefined {
    const run = this.entries.get(workspace)?.run;
    return run ? { running: run.workerRunning, restarts: run.restarts } : undefined;
  }

  /** Discovery over the events with the workspace's heuristics as data, in the worker. */
  private async discover(workspace: string, events: NormalizedEvent[], data: DiscoveryData): Promise<AsyncDiscoveryRun> {
    if (this.inProcess || !workerAvailable()) {
      if (!this.inProcess) this.log(`the discovery worker isn't beside the core; discovery runs in process`);
      this.inProcess = true;
      return inProcess(runDiscovery(events, discoveryOptionsOf(data)));
    }
    const run = await discoverOffThread(events, data, {
      idleMs: this.options.workerIdleMs ?? DEFAULT_WORKER_IDLE_MS,
      log: (line) => this.log(`${line} (${workspace})`),
    });
    const entry = this.entries.get(workspace);
    if (entry) entry.run = run;
    return run;
  }

  /** The heuristics discovery runs with, as data a worker can rebuild them from. */
  private discoveryData(options: Awaited<ReturnType<FindingsService['heuristicsFor']>>): DiscoveryData {
    const ruleIds = new Set(options.rules.map((r) => r.id));
    const contextLimits: Record<string, number> = {};
    for (const [model, marks] of Object.entries(this.findings.contextMarks())) if (typeof marks.limit === 'number') contextLimits[model] = marks.limit;
    return {
      builtIns: options.heuristics.map((h) => h.id).filter((id) => !ruleIds.has(id)),
      rules: options.rules,
      settings: Object.fromEntries(options.heuristics.map((h) => [h.id, options.settingsFor(h.id)])),
      contextLimits,
    };
  }

  private folderOf(workspace: string): string {
    return workspaceInfoOf(workspace).folder ?? workspace;
  }

  private days(workspace: string): number {
    const days = Number(configHost(this.home, this.folderOf(workspace)).get<unknown>('snagboat.discovery', 'days', 30));
    return Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
  }

  private async entry(workspace: string): Promise<Entry> {
    let entry = this.entries.get(workspace);
    if (!entry) {
      const store = new RuleStore(this.home);
      const names = new Map<string, string>();
      let options = await this.findings.heuristicsFor(workspace);
      const controller = new SuggestionsController({
        loadEvents: async () => {
          // Fresh heuristics and settings for each run, and the sessions' names for its examples.
          options = await this.findings.heuristicsFor(workspace);
          await store.load().catch(() => undefined);
          const log = new EventLog(workspaceStoreDir(this.home, workspace));
          const since = new Date(Date.now() - (this.days(workspace) - 1) * 86_400_000).toISOString().slice(0, 10);
          const events: NormalizedEvent[] = [];
          for (const day of await log.listDays()) if (day >= since) for (const e of await log.readDay(day)) {
            if (e.kind === 'session_name' && e.sessionName) names.set(e.sessionId, e.sessionName);
            events.push(e);
          }
          return events;
        },
        discover: (events) => this.discover(workspace, events, this.discoveryData(options)),
        store,
        settingsRules: (): RuleSource => {
          const rules = configHost(this.home, this.folderOf(workspace)).get<unknown>('snagboat', 'rules', []);
          return { origin: 'settings', rules: Array.isArray(rules) ? rules : [], categories: [] };
        },
        // The workspace's findings use the saved rules from their next evaluation; have it run now.
        rulesChanged: () => void this.findings.current(workspace).catch(() => undefined),
        applySetting: async (heuristic, setting, value) => {
          // Your user settings, as VS Code's Apply writes them; a VS Code window takes them from config.json.
          const key = `${heuristicSettingsSection(heuristic).replace(/^snagboat\./, '')}.${setting}`;
          const { config } = loadConfig(this.home);
          saveConfig(this.home, { ...config, defaults: { ...config.defaults, [key]: value } });
          await this.findings.current(workspace).catch(() => undefined);
        },
        // Local advisors only (decided for 5c-2b); the request waits for your approval the first time.
        propose: async (build, advisorId) => {
          let asked;
          try {
            asked = await this.advisors.ask('propose-heuristics', async ({ policy, prompts }) => proposeHeuristicsMessages(build(policy), prompts), { advisorId });
          } catch (err) {
            const e = this.entries.get(workspace);
            if (e) e.error = err instanceof Error ? err.message : String(err);
            return undefined;
          }
          if (!asked) return undefined;
          return { text: asked.completion.text, provider: asked.advisor.label, model: asked.advisor.model };
        },
        advisorCount: () => this.advisors.offering('propose-heuristics').length,
        dismissed: () => readDismissed(this.home),
        setDismissed: async (ids) => writeDismissed(this.home, ids),
        sessionName: (id) => names.get(id),
        roots: () => [this.folderOf(workspace)],
        source: () => path.basename(this.folderOf(workspace)) || workspace,
        days: () => this.days(workspace),
        now: () => new Date().toISOString(),
      });
      entry = { controller, store, names };
      this.entries.set(workspace, entry);
    }
    // Saved rules may have changed elsewhere (VS Code, another tab) since the last look.
    await entry.store.load().catch(() => undefined);
    return entry;
  }
}
