import { NormalizedEvent } from '../core/types';
import { Baseline, Candidate, DiscoveryOptions, DiscoveryRun, runDiscovery, ThresholdSuggestion } from '../discovery/discover';
import { RuleSource } from '../heuristics/rule';
import { Provenance, RuleStore } from '../heuristics/ruleStore';

export interface CandidateView {
  id: string;
  title: string;
  describes: string;
  kind: Candidate['probe']['kind'];
  threshold: number;
  /** Discovery's own threshold, so a tweak can be undone. */
  proposedThreshold: number;
  baseline: Baseline;
  turnsAbove: number;
  sessionsAbove: number;
  episodes: number;
  sessions: number;
  overlaps: Record<string, number>;
  examples: Array<{ sessionId: string; name?: string }>;
  /** The rule as it would be saved, for reading or copying into settings. */
  rule: Record<string, unknown>;
}

export interface SavedView {
  section: 'rules' | 'categories';
  id: string;
  title: string;
  /** Where it's kept: saved (removable) or written in settings. */
  origin: 'saved' | 'settings';
  provenance?: Provenance;
}

/** Everything the Suggestions tab renders, sent whole on each change. */
export interface SuggestionsView {
  status: 'idle' | 'running' | 'ready' | 'failed';
  error?: string;
  source: string;
  days: number;
  ranAt?: string;
  from?: string;
  to?: string;
  sessions: number;
  turns: number;
  notes: string[];
  candidates: CandidateView[];
  thresholds: ThresholdSuggestion[];
  shell: { shellCalls: number; leftShare: number; candidates: Array<{ id: string; label: string; match: string[]; share: number; calls: number; sessions: number }> };
  saved: SavedView[];
  dismissed: number;
}

export interface SuggestionsHooks {
  /** This workspace's stored events over the discovery window. */
  loadEvents(): Promise<NormalizedEvent[]>;
  options(): DiscoveryOptions;
  store: RuleStore;
  settingsRules(): RuleSource;
  /** Saved rules or categories changed: rebuild the running heuristics. */
  rulesChanged(): void;
  /** Writes a built-in's setting. */
  applySetting(heuristic: string, setting: string, value: number): Promise<void>;
  dismissed(): string[];
  setDismissed(ids: string[]): Promise<void>;
  sessionName(sessionId: string): string | undefined;
  /** The workspace discovery reads, recorded with each accepted rule. */
  source(): string;
  days(): number;
  now(): string;
}

function idOf(doc: unknown): string {
  return typeof doc === 'object' && doc !== null && typeof (doc as { id?: unknown }).id === 'string' ? (doc as { id: string }).id : '(no id)';
}

function titleOf(doc: unknown, key: 'title' | 'label'): string {
  const v = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : idOf(doc);
}

/**
 * Serves the Suggestions tab: runs discovery over this workspace's history,
 * keeps tweaked thresholds re-scored, and turns accepts into saved rules
 * (with provenance) and dismissals into a remembered list.
 */
export class SuggestionsController {
  private run?: DiscoveryRun;
  private status: SuggestionsView['status'] = 'idle';
  private error?: string;
  private ranAt?: string;
  /** Candidates at a threshold you chose, by rule id. */
  private tweaked = new Map<string, Candidate>();
  private accepted = new Set<string>();
  private listeners: Array<() => void> = [];

  constructor(private readonly hooks: SuggestionsHooks) {}

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  get hasRun(): boolean {
    return this.status !== 'idle';
  }

  async discover(): Promise<void> {
    if (this.status === 'running') return;
    this.status = 'running';
    this.notify();
    try {
      const events = await this.hooks.loadEvents();
      this.run = runDiscovery(events, this.hooks.options());
      this.tweaked.clear();
      this.accepted.clear();
      this.ranAt = this.hooks.now();
      this.status = 'ready';
      this.error = undefined;
    } catch (err) {
      this.status = 'failed';
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.notify();
  }

  private candidate(id: string): Candidate | undefined {
    return this.tweaked.get(id) ?? this.run?.result.candidates.find((c) => c.rule.id === id);
  }

  /** Re-scores a candidate at your threshold. */
  tweak(id: string, threshold: number): void {
    const proposed = this.run?.result.candidates.find((c) => c.rule.id === id);
    if (!proposed) return;
    if (threshold === proposed.threshold) this.tweaked.delete(id);
    else {
      const c = this.run!.tweak(id, threshold);
      if (!c) return;
      this.tweaked.set(id, c);
    }
    this.notify();
  }

  async accept(id: string): Promise<void> {
    const c = this.candidate(id);
    if (!c || this.accepted.has(id)) return;
    await this.hooks.store.save('rules', c.rule, this.provenance({ episodes: c.score.episodes, sessions: c.score.sessions }));
    this.accepted.add(id);
    this.hooks.rulesChanged();
    this.notify();
  }

  async acceptCategory(id: string): Promise<void> {
    const c = this.run?.result.shell.candidates.find((s) => s.category.id === id);
    if (!c || this.accepted.has(id)) return;
    await this.hooks.store.save('categories', { ...c.category }, this.provenance());
    this.accepted.add(id);
    this.hooks.rulesChanged();
    this.notify();
  }

  async dismiss(id: string): Promise<void> {
    const dismissed = new Set(this.hooks.dismissed());
    dismissed.add(id);
    await this.hooks.setDismissed([...dismissed]);
    this.notify();
  }

  async clearDismissed(): Promise<void> {
    await this.hooks.setDismissed([]);
    this.notify();
  }

  /** Applies discovery's suggested threshold to a built-in's setting (never a value from the page). */
  async applyThreshold(heuristic: string, setting: string): Promise<void> {
    const t = this.run?.result.thresholds.find((s) => s.heuristic === heuristic && s.setting === setting);
    if (t?.suggested === undefined) return;
    await this.hooks.applySetting(heuristic, setting, t.suggested);
    t.current = t.suggested;
    t.currentShare = t.suggestedShare ?? t.currentShare;
    this.notify();
  }

  async removeSaved(section: 'rules' | 'categories', id: string): Promise<void> {
    await this.hooks.store.remove(section, id);
    this.accepted.delete(id);
    this.hooks.rulesChanged();
    this.notify();
  }

  private provenance(replay?: Provenance['replay']): Provenance {
    return { proposedBy: 'discovery', addedAt: this.hooks.now(), workspace: this.hooks.source(), ...(replay ? { replay } : {}) };
  }

  view(): SuggestionsView {
    const dismissed = new Set(this.hooks.dismissed());
    const hidden = (id: string) => dismissed.has(id) || this.accepted.has(id);
    const r = this.run?.result;
    const saved: SavedView[] = [
      ...this.hooks.store.list('rules').map((s) => ({ section: 'rules' as const, id: s.doc.id, title: titleOf(s.doc, 'title'), origin: 'saved' as const, provenance: s.provenance })),
      ...this.hooks.store.list('categories').map((s) => ({ section: 'categories' as const, id: s.doc.id, title: titleOf(s.doc, 'label'), origin: 'saved' as const, provenance: s.provenance })),
    ];
    const settings = this.hooks.settingsRules();
    for (const doc of settings.rules) saved.push({ section: 'rules', id: idOf(doc), title: titleOf(doc, 'title'), origin: 'settings' });
    for (const doc of settings.categories) saved.push({ section: 'categories', id: idOf(doc), title: titleOf(doc, 'label'), origin: 'settings' });

    return {
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      source: this.hooks.source(),
      days: this.hooks.days(),
      ranAt: this.ranAt,
      from: r?.from,
      to: r?.to,
      sessions: r?.sessions ?? 0,
      turns: r?.turns ?? 0,
      notes: r?.notes ?? [],
      candidates: (r?.candidates ?? [])
        .filter((p) => !hidden(p.rule.id))
        .map((p) => {
          const c = this.tweaked.get(p.rule.id) ?? p;
          return {
            id: c.rule.id,
            title: String(c.rule.title),
            describes: c.probe.describes,
            kind: c.probe.kind,
            threshold: c.threshold,
            proposedThreshold: p.threshold,
            baseline: c.baseline,
            turnsAbove: c.turnsAbove,
            sessionsAbove: c.sessionsAbove,
            episodes: c.score.episodes,
            sessions: c.score.sessions,
            overlaps: c.score.overlaps,
            examples: c.score.examples.map((sessionId) => ({ sessionId, name: this.hooks.sessionName(sessionId) })),
            rule: c.rule,
          };
        }),
      thresholds: r?.thresholds ?? [],
      shell: {
        shellCalls: r?.shell.shellCalls ?? 0,
        leftShare: r?.shell.leftShare ?? 0,
        candidates: (r?.shell.candidates ?? [])
          .filter((c) => !hidden(c.category.id))
          .map((c) => ({ id: c.category.id, label: c.category.label, match: c.category.match, share: c.share, calls: c.calls, sessions: c.sessions })),
      },
      saved,
      dismissed: dismissed.size,
    };
  }
}

/** A rules file as Export Rules writes it, or a plain list of rules as in snagboat.rules. */
export function parseRulesFile(text: string): RuleSource & { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { origin: 'file', rules: [], categories: [], errors: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const unwrap = (entries: unknown) => (Array.isArray(entries) ? entries.map((e) => (typeof e === 'object' && e !== null && 'doc' in e ? (e as { doc: unknown }).doc : e)) : []);
  if (Array.isArray(parsed)) return { origin: 'file', rules: unwrap(parsed), categories: [], errors: [] };
  if (typeof parsed === 'object' && parsed !== null && ('rules' in parsed || 'categories' in parsed)) {
    const p = parsed as { rules?: unknown; categories?: unknown };
    return { origin: 'file', rules: unwrap(p.rules), categories: unwrap(p.categories), errors: [] };
  }
  return { origin: 'file', rules: [], categories: [], errors: ['expected a list of rules, or an object with "rules" and "categories"'] };
}

