import { buildDigest, DigestPolicy, DigestTurn } from '../advisor/digest';
import { categoryDoc, MAX_EXAMPLES_PER_CANDIDATE, MAX_FAMILIES, MAX_PROPOSE_CANDIDATES, MAX_TOOL_NAMES, parseProposals, ProposeInput } from '../advisor/propose';
import { parseShellSubCategory, ShellSubCategory } from '../core/toolCategory';
import { NormalizedEvent } from '../core/types';
import { Baseline, Candidate, DiscoveryOptions, DiscoveryRun, runDiscovery, Score, ThresholdSuggestion } from '../discovery/discover';
import { shellCategoryReach } from '../discovery/shellCategories';
import { parseRule, RuleSource, TARGET_MEASURES } from '../heuristics/rule';
import { Provenance, RuleStore } from '../heuristics/ruleStore';

export interface CandidateView {
  id: string;
  /** Discovery found it (its threshold can be changed), or the advisor proposed it as a whole rule. */
  source: 'discovery' | 'advisor';
  /** The advisor wrote its title, summary, and suggested action. */
  named: boolean;
  title: string;
  summary: string;
  suggestedAction?: string;
  describes?: string;
  kind?: Candidate['probe']['kind'];
  threshold?: number;
  /** Discovery's own threshold, so a tweak can be undone. */
  proposedThreshold?: number;
  baseline?: Baseline;
  turnsAbove?: number;
  sessionsAbove?: number;
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
  shell: { shellCalls: number; leftShare: number; candidates: Array<{ id: string; source: 'discovery' | 'advisor'; label: string; match: string[]; share: number; calls: number; sessions: number }> };
  saved: SavedView[];
  dismissed: number;
  /** Whether an advisor can be asked, and what it last said. */
  advisor: AdvisorState & { available: boolean };
}

export interface AdvisorState {
  status: 'idle' | 'asking' | 'done';
  provider?: string;
  model?: string;
  at?: string;
  /** The server cut the request to fit its context window. */
  warning?: string;
  /** What was dropped from its answer, and why. */
  problems: string[];
}

/** What the advisor's answer came back as. */
export interface AdvisorAnswer {
  text: string;
  provider: string;
  model: string;
  warning?: string;
}

interface AdvisorResults extends AdvisorState {
  names: Map<string, { title: string; summary: string; suggestedAction: string }>;
  rules: Array<{ rule: Record<string, unknown> & { id: string }; score: Score }>;
  categories: Array<{ category: ShellSubCategory; calls: number; share: number; sessions: number }>;
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
  /**
   * Asks the advisor to propose heuristics; the input is built with the
   * provider's sending rules. Undefined when you stopped it or it failed.
   * Absent: no advisor in this host.
   */
  propose?(build: (policy: DigestPolicy) => ProposeInput): Promise<AdvisorAnswer | undefined>;
  /** Workspace folders, for relative paths in example digests. */
  roots(): string[];
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
  private advisor: AdvisorResults = SuggestionsController.noAdvice();
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
      this.advisor = SuggestionsController.noAdvice();
      this.ranAt = this.hooks.now();
      this.status = 'ready';
      this.error = undefined;
    } catch (err) {
      this.status = 'failed';
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.notify();
  }

  private static noAdvice(): AdvisorResults {
    return { status: 'idle', problems: [], names: new Map(), rules: [], categories: [] };
  }

  private candidate(id: string): Candidate | undefined {
    return this.tweaked.get(id) ?? this.run?.result.candidates.find((c) => c.rule.id === id);
  }

  /** A discovery candidate's rule with the advisor's names, if it gave any. */
  private named(rule: Candidate['rule']): Candidate['rule'] {
    const n = this.advisor.names.get(rule.id);
    return n ? { ...rule, title: n.title, summary: n.summary, ...(n.suggestedAction ? { suggestedAction: n.suggestedAction } : {}) } : rule;
  }

  /**
   * Asks the advisor about this discovery: names for the candidates, a few
   * rules of its own, and shell categories. Everything it returns is checked
   * by the same validators as a hand-written rule and scored by replay;
   * nothing is saved until you accept.
   */
  async askAdvisor(): Promise<void> {
    const run = this.run;
    if (!run || this.status !== 'ready' || !this.hooks.propose || this.advisor.status === 'asking') return;
    const dismissed = new Set(this.hooks.dismissed());
    const candidates = run.result.candidates.filter((c) => !dismissed.has(c.rule.id) && !this.accepted.has(c.rule.id)).slice(0, MAX_PROPOSE_CANDIDATES);
    const toolCounts = new Map<string, number>();
    for (const e of run.events) if (e.kind === 'tool_call' && e.toolName) toolCounts.set(e.toolName, (toolCounts.get(e.toolName) ?? 0) + 1);
    const toolNames = [...toolCounts].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls);
    const build = (policy: DigestPolicy): ProposeInput => ({
      turns: run.result.turns,
      sessions: run.result.sessions,
      candidates: candidates.map((c) => {
        const measures = parseRule(c.rule).value?.measures ?? {};
        const examples = c.exampleTurns
          .slice(0, MAX_EXAMPLES_PER_CANDIDATE)
          .map((t) => buildDigest({ sessionId: t.sessionId, events: run.sessionEvents(t.sessionId), turnId: t.turnId, findings: [], roots: this.hooks.roots() }, policy).turns[0])
          .filter((t): t is DigestTurn => !!t);
        return {
          id: c.rule.id,
          describes: c.probe.describes,
          kind: c.probe.kind,
          threshold: c.threshold,
          baseline: c.baseline,
          turnsAbove: c.turnsAbove,
          placeholders: [...Object.keys(measures), ...(Object.values(measures).some((m) => TARGET_MEASURES.has(m.type)) ? ['target'] : [])],
          examples,
        };
      }),
      shell: { shellCalls: run.result.shell.shellCalls, families: run.result.shell.families.slice(0, MAX_FAMILIES).map((f) => ({ name: f.name, calls: f.calls })) },
      toolNames: toolNames.slice(0, MAX_TOOL_NAMES),
    });
    const before = this.advisor;
    this.advisor = { ...SuggestionsController.noAdvice(), status: 'asking' };
    this.notify();
    const answer = await this.hooks.propose(build);
    if (!answer || this.run !== run) {
      this.advisor = before.status === 'asking' ? SuggestionsController.noAdvice() : before;
      this.notify();
      return;
    }
    const proposals = parseProposals(answer.text, new Set(candidates.map((c) => c.rule.id)));
    const results: AdvisorResults = { ...SuggestionsController.noAdvice(), status: 'done', provider: answer.provider, model: answer.model, at: this.hooks.now(), problems: proposals.problems, ...(answer.warning ? { warning: answer.warning } : {}) };
    for (const n of proposals.names) {
      const c = candidates.find((x) => x.rule.id === n.id)!;
      // Values arrive formatted with their units (32M, 45%); models add them again anyway.
      n.summary = n.summary.replace(/\{(\w+)\}\s?(?:[KMB]\b|%)/g, '{$1}');
      const { errors } = parseRule({ ...c.rule, title: n.title, summary: n.summary, ...(n.suggestedAction ? { suggestedAction: n.suggestedAction } : {}) });
      if (errors.length > 0) results.problems.push(`the name for ${n.id} was dropped: ${errors.join('; ')}`);
      else results.names.set(n.id, n);
    }
    const taken = new Set([...run.result.candidates.map((c) => c.rule.id), ...this.hooks.store.list('rules').map((s) => s.doc.id)]);
    const valid = [];
    for (const doc of proposals.rules) {
      const { value, errors } = parseRule(doc);
      if (!value) results.problems.push(`rule ${doc.id} was dropped: ${errors.join('; ')}`);
      else if (taken.has(value.id)) results.problems.push(`rule ${doc.id} was dropped: that id is taken`);
      else {
        taken.add(value.id);
        valid.push({ doc, value });
      }
    }
    const scores = run.score(valid.map((v) => v.value));
    for (const v of valid) {
      const score = scores.get(v.value.id)!;
      if (score.episodes === 0) results.problems.push(`rule ${v.value.id} was dropped: it would never have fired on your history`);
      else results.rules.push({ rule: v.doc, score });
    }
    for (const c of proposals.categories) {
      const { value, errors } = parseShellSubCategory(categoryDoc(c));
      if (!value) {
        results.problems.push(`category "${c.label}" was dropped: ${errors.join('; ')}`);
        continue;
      }
      const reach = shellCategoryReach(value, run.events);
      if (reach.calls === 0) results.problems.push(`category "${c.label}" was dropped: it matches none of your shell calls`);
      else results.categories.push({ category: value, ...reach });
    }
    this.advisor = results;
    this.notify();
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
    if (this.accepted.has(id)) return;
    const c = this.candidate(id);
    const a = c ? undefined : this.advisor.rules.find((r) => r.rule.id === id);
    if (!c && !a) return;
    const rule = c ? this.named(c.rule) : a!.rule;
    const score = c ? c.score : a!.score;
    await this.hooks.store.save('rules', rule, this.provenance({ episodes: score.episodes, sessions: score.sessions }, a ? 'advisor' : 'discovery'));
    this.accepted.add(id);
    this.hooks.rulesChanged();
    this.notify();
  }

  async acceptCategory(id: string): Promise<void> {
    const c = this.run?.result.shell.candidates.find((s) => s.category.id === id);
    const a = c ? undefined : this.advisor.categories.find((s) => s.category.id === id);
    if ((!c && !a) || this.accepted.has(id)) return;
    await this.hooks.store.save('categories', { ...(c ?? a)!.category }, this.provenance(undefined, a ? 'advisor' : 'discovery'));
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

  private provenance(replay?: Provenance['replay'], proposedBy: 'discovery' | 'advisor' = 'discovery'): Provenance {
    return { proposedBy, addedAt: this.hooks.now(), workspace: this.hooks.source(), ...(replay ? { replay } : {}) };
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
        .map((p): CandidateView => {
          const c = this.tweaked.get(p.rule.id) ?? p;
          const rule = this.named(c.rule);
          return {
            id: c.rule.id,
            source: 'discovery',
            named: this.advisor.names.has(c.rule.id),
            title: String(rule.title),
            summary: String(rule.summary),
            ...(typeof rule.suggestedAction === 'string' ? { suggestedAction: rule.suggestedAction } : {}),
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
            rule,
          };
        })
        .concat(
          this.advisor.rules
            .filter((a) => !hidden(a.rule.id))
            .map((a): CandidateView => ({
              id: a.rule.id,
              source: 'advisor',
              named: true,
              title: String(a.rule.title),
              summary: String(a.rule.summary),
              ...(typeof a.rule.suggestedAction === 'string' ? { suggestedAction: a.rule.suggestedAction } : {}),
              episodes: a.score.episodes,
              sessions: a.score.sessions,
              overlaps: a.score.overlaps,
              examples: a.score.examples.map((sessionId) => ({ sessionId, name: this.hooks.sessionName(sessionId) })),
              rule: a.rule,
            }))
        ),
      thresholds: r?.thresholds ?? [],
      shell: {
        shellCalls: r?.shell.shellCalls ?? 0,
        leftShare: r?.shell.leftShare ?? 0,
        candidates: [...(r?.shell.candidates ?? []).map((c) => ({ ...c, source: 'discovery' as const })), ...this.advisor.categories.map((c) => ({ ...c, source: 'advisor' as const }))]
          .filter((c) => !hidden(c.category.id))
          .map((c) => ({ id: c.category.id, source: c.source, label: c.category.label, match: c.category.match, share: c.share, calls: c.calls, sessions: c.sessions })),
      },
      saved,
      dismissed: dismissed.size,
      advisor: {
        available: !!this.hooks.propose,
        status: this.advisor.status,
        problems: this.advisor.problems,
        ...(this.advisor.provider ? { provider: this.advisor.provider, model: this.advisor.model, at: this.advisor.at } : {}),
        ...(this.advisor.warning ? { warning: this.advisor.warning } : {}),
      },
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

