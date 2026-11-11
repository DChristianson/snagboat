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
import { FindingsService } from './findings';

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
 * dismissals to suggestions.json. Advisor proposals (a model) come with step 5c-2b.
 */

export type SuggestionAction =
  | { action: 'discover' }
  | { action: 'tweak'; id: string; threshold: number }
  | { action: 'accept'; id: string }
  | { action: 'acceptCategory'; id: string }
  | { action: 'dismiss'; id: string }
  | { action: 'clearDismissed' }
  | { action: 'applyThreshold'; heuristic: string; setting: string }
  | { action: 'removeSaved'; section: 'rules' | 'categories'; id: string };

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
    default:
      return undefined;
  }
}

interface Entry {
  controller: SuggestionsController;
  store: RuleStore;
  names: Map<string, string>;
}

export class SuggestionsService {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly home: string,
    private readonly findings: FindingsService,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  /** The Suggestions view for a workspace; discovery runs on the first ask, then on Discover again. */
  async view(workspace: string): Promise<SuggestionsView> {
    const entry = await this.entry(workspace);
    const view = entry.controller.view();
    if (view.status === 'idle') {
      void entry.controller.discover().catch((err) => this.log(`discovery failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
      return entry.controller.view();
    }
    return view;
  }

  async act(workspace: string, a: SuggestionAction): Promise<SuggestionsView> {
    const entry = await this.entry(workspace);
    const c = entry.controller;
    switch (a.action) {
      case 'discover':
        void c.discover().catch((err) => this.log(`discovery failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
        break;
      case 'tweak':
        c.tweak(a.id, a.threshold);
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
    }
    return c.view();
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
        options: () => ({ existing: options.heuristics, settingsFor: options.settingsFor, contextLimit: options.contextLimit }),
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
