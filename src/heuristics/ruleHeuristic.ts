import { contextSize } from '../core/contextLimits';
import { isConversationEvent } from '../core/sessions';
import { categoryMatches } from '../core/toolCategory';
import { currentTurnsIn } from '../core/turns';
import { NormalizedEvent, NormalizedEventKind } from '../core/types';
import { compactTokens } from './settings';
import { Rule, RuleCondition, RuleFilter, RuleMeasure, TARGET_MEASURES, MeasureType } from './rule';
import { Finding, Heuristic, HeuristicContext, Progress } from './types';

const MAX_REFS = 200;

/** What a measure found in one scope: its value (undefined when there was nothing to measure), and the events behind it. */
export interface Measured {
  value?: number;
  target?: string;
  refs: NormalizedEvent[];
}

const namePatterns = new Map<string, RegExp>();

/** A raw tool name against an exact name or a `*` pattern. */
function nameMatches(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  let re = namePatterns.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    namePatterns.set(pattern, re);
  }
  return re.test(name);
}

function matches(f: RuleFilter, e: NormalizedEvent): boolean {
  if (f.kind && !(f.kind as string[]).includes(e.kind)) return false;
  if (f.agent && !f.agent.includes(e.agent)) return false;
  if (f.toolCategory && !(e.toolCategory && f.toolCategory.some((c) => categoryMatches(e.toolCategory!, c)))) return false;
  if (f.toolName && !(e.toolName && f.toolName.some((p) => nameMatches(e.toolName!, p)))) return false;
  if (f.status && !f.status.includes(e.status)) return false;
  if (f.subagent !== undefined && f.subagent !== Boolean(e.agentId)) return false;
  if (f.hasTarget !== undefined && f.hasTarget !== Boolean(e.target)) return false;
  if (f.hasTokens !== undefined && f.hasTokens !== Boolean(e.tokens)) return false;
  return true;
}

/** Events with a target, grouped by it, largest group first. */
function byTarget(events: NormalizedEvent[]): Array<[string, NormalizedEvent[]]> {
  const groups = new Map<string, NormalizedEvent[]>();
  for (const e of events) if (e.target) groups.set(e.target, [...(groups.get(e.target) ?? []), e]);
  return [...groups].sort((a, b) => b[1].length - a[1].length);
}

function tokenTotal(e: NormalizedEvent): number {
  const t = e.tokens;
  return t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreation ?? 0) : 0;
}

/** Measures one scope's events (time-ordered). Discovery uses it too, to measure every past turn. */
export function measure(m: RuleMeasure, base: RuleFilter, events: NormalizedEvent[], ctx: Pick<HeuristicContext, 'now' | 'contextLimit'>): Measured {
  const matching = events.filter((e) => matches(base, e) && matches(m.filter, e));
  switch (m.type) {
    case 'count':
      return { value: matching.length, refs: matching };
    case 'distinctTargets': {
      const targeted = matching.filter((e) => e.target);
      return { value: new Set(targeted.map((e) => e.target)).size, refs: targeted };
    }
    case 'maxPerTarget': {
      const [top] = byTarget(matching);
      return top ? { value: top[1].length, target: top[0], refs: top[1] } : { refs: [] };
    }
    case 'topShare': {
      const groups = byTarget(matching);
      const total = groups.reduce((n, [, g]) => n + g.length, 0);
      if (total === 0) return { refs: [] };
      const top = groups.slice(0, m.n ?? 1).reduce((n, [, g]) => n + g.length, 0);
      return { value: top / total, target: groups[0][0], refs: groups.flatMap(([, g]) => g) };
    }
    case 'sumTokens': {
      const withTokens = matching.filter((e) => e.tokens);
      return { value: withTokens.reduce((n, e) => n + tokenTotal(e), 0), refs: withTokens };
    }
    case 'contextPercent': {
      const last = matching.filter((e) => e.tokens).pop();
      const size = last && contextSize(last);
      const limit = last && (last.contextLimit ?? ctx.contextLimit?.(last.model));
      return last && size && limit ? { value: (100 * size) / limit, refs: [last] } : { refs: [] };
    }
    case 'failureRate': {
      const decided = matching.filter((e) => e.status !== 'unknown');
      const failures = decided.filter((e) => e.status === 'failure');
      return decided.length > 0 ? { value: failures.length / decided.length, refs: failures } : { refs: [] };
    }
    case 'idleMinutes': {
      const last = matching[matching.length - 1];
      return last ? { value: (Date.parse(ctx.now) - Date.parse(last.ts)) / 60_000, refs: [last] } : { refs: [] };
    }
    case 'consecutive': {
      // Runs are counted among events of the filtered kinds, so a failed tool
      // call followed by a model call and another failed tool call is a run of two.
      const kinds = [base.kind, m.filter.kind].filter((k): k is NonNullable<typeof k> => !!k);
      let best: NormalizedEvent[] = [];
      let run: NormalizedEvent[] = [];
      for (const e of events) {
        if (!kinds.every((k) => (k as string[]).includes(e.kind))) continue;
        if (matches(base, e) && matches(m.filter, e)) {
          run.push(e);
          if (run.length > best.length) best = run;
        } else {
          run = [];
        }
      }
      return { value: best.length, refs: best };
    }
  }
}

function holds(condition: RuleCondition, values: Map<string, Measured>): boolean {
  if ('all' in condition) return condition.all.every((c) => holds(c, values));
  if ('any' in condition) return condition.any.some((c) => holds(c, values));
  const v = values.get(condition.measure)?.value;
  if (v === undefined) return false;
  return (
    (condition.gte === undefined || v >= condition.gte) &&
    (condition.gt === undefined || v > condition.gt) &&
    (condition.lte === undefined || v <= condition.lte) &&
    (condition.lt === undefined || v < condition.lt)
  );
}

/** How far a condition is toward holding, 0 to 1; undefined where that can't be said (lte and lt thresholds, nothing measured). */
function shareOf(condition: RuleCondition, values: Map<string, Measured>): number | undefined {
  if ('all' in condition || 'any' in condition) {
    const parts = ('all' in condition ? condition.all : condition.any).map((c) => shareOf(c, values));
    if (parts.some((p) => p === undefined)) return undefined;
    return 'all' in condition ? Math.min(...(parts as number[])) : Math.max(...(parts as number[]));
  }
  const v = values.get(condition.measure)?.value;
  const target = condition.gte ?? condition.gt;
  if (v === undefined || target === undefined || target <= 0 || condition.lte !== undefined || condition.lt !== undefined) return undefined;
  return Math.min(v / target, 1);
}

function formatValue(type: MeasureType, v: number | undefined): string {
  if (v === undefined) return '?';
  switch (type) {
    case 'topShare':
    case 'failureRate':
      return `${Math.round(v * 100)}%`;
    case 'contextPercent':
      return `${Math.round(v)}%`;
    case 'sumTokens':
      return compactTokens(v);
    case 'idleMinutes':
      return String(Math.round(v));
    default:
      return String(v);
  }
}

function render(text: string, rule: Rule, values: Map<string, Measured>): string {
  return text.replace(/\{([^}]*)\}/g, (_, name: string) => {
    if (name === 'windowMinutes') return String(rule.windowMinutes);
    if (name === 'target') {
      const first = Object.keys(rule.measures).find((n) => TARGET_MEASURES.has(rule.measures[n].type) && values.get(n)?.target);
      return (first && values.get(first)?.target) ?? '?';
    }
    if (name.endsWith('.target')) return values.get(name.slice(0, -'.target'.length))?.target ?? '?';
    return formatValue(rule.measures[name].type, values.get(name)?.value);
  });
}

/** Each session's events in the rule's scope, with the event a finding should point at first (the turn's prompt). */
function scopeGroups(rule: Rule, ctx: HeuristicContext): Array<{ events: NormalizedEvent[]; anchor?: string }> {
  if (rule.scope === 'turn') return currentTurnsIn(ctx.store).map((t) => ({ events: t.events, anchor: t.promptEventId }));
  const since = rule.scope === 'window' ? new Date(Date.parse(ctx.now) - rule.windowMinutes! * 60_000).toISOString() : undefined;
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of ctx.store.query(since ? { since } : {})) {
    if (!isConversationEvent(e)) continue;
    bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  }
  return [...bySession.values()].map((events) => ({ events }));
}

const CONVERSATION_KINDS: NormalizedEventKind[] = ['user_prompt', 'turn_stop', 'tool_call', 'compaction'];

/** A rule as a heuristic for the engine, so it gets replay, past findings, acknowledge, and mute like a built-in. */
export function ruleHeuristic(rule: Rule): Heuristic {
  const timeDependent = rule.scope === 'window' || Object.values(rule.measures).some((m) => m.type === 'idleMinutes');
  return {
    id: rule.id,
    appliesTo: CONVERSATION_KINDS,
    onlyChangesWithEvents: !timeDependent,

    ...(rule.earlyWarning !== undefined
      ? {
          progress(ctx: HeuristicContext): Progress[] {
            const out: Progress[] = [];
            for (const group of scopeGroups(rule, ctx)) {
              const values = new Map(Object.entries(rule.measures).map(([name, m]) => [name, measure(m, rule.filter, group.events, ctx)]));
              if (holds(rule.when, values)) continue;
              const share = shareOf(rule.when, values);
              if (share === undefined || share < rule.earlyWarning!) continue;
              out.push({ heuristicId: rule.id, share, summary: `Heading for "${rule.title}": ${render(rule.summary, rule, values)}`, eventRefs: group.anchor ? [group.anchor] : [] });
            }
            return out;
          },
        }
      : {}),

    evaluate(ctx: HeuristicContext): Finding[] {
      const findings: Finding[] = [];
      for (const group of scopeGroups(rule, ctx)) {
        const values = new Map(Object.entries(rule.measures).map(([name, m]) => [name, measure(m, rule.filter, group.events, ctx)]));
        if (!holds(rule.when, values)) continue;
        const refs = new Set(group.anchor ? [group.anchor] : []);
        for (const v of values.values()) for (const e of v.refs.slice(-MAX_REFS)) refs.add(e.eventId);
        findings.push({
          heuristicId: rule.id,
          severity: rule.severity,
          summary: render(rule.summary, rule, values),
          eventRefs: [...refs],
          ...(rule.suggestedAction ? { suggestedAction: render(rule.suggestedAction, rule, values) } : {}),
          detectedAt: ctx.now,
        });
      }
      return findings;
    },
  };
}
