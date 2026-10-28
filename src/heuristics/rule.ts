import { isShellSubCategoryId, isToolCategory, parseShellSubCategory, ShellSubCategory } from '../core/toolCategory';
import { NormalizedEvent } from '../core/types';

/**
 * Declarative heuristics: which events count, what to measure over them, and
 * when that's worth a finding. Rules are data: they can only describe counts
 * and thresholds over events, never run code. ruleHeuristic.ts evaluates them.
 * See docs/heuristics.md#rules and docs/design/trusted-advisor.md#rule-format.
 */

export const RULE_SCOPES = ['turn', 'session', 'window'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** The kinds a rule sees: conversation events, as the built-ins do. */
export const RULE_EVENT_KINDS = ['user_prompt', 'turn_stop', 'tool_call', 'compaction'] as const;
export type RuleEventKind = (typeof RULE_EVENT_KINDS)[number];

export const MEASURE_TYPES = ['count', 'distinctTargets', 'maxPerTarget', 'topShare', 'sumTokens', 'contextPercent', 'failureRate', 'idleMinutes', 'consecutive'] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];

/** Measures that name a target, for `{target}` in summaries. */
export const TARGET_MEASURES: ReadonlySet<MeasureType> = new Set(['maxPerTarget', 'topShare']);

const STATUSES = ['success', 'failure', 'unknown'] as const;
const THRESHOLDS = ['gte', 'gt', 'lte', 'lt'] as const;
type Threshold = (typeof THRESHOLDS)[number];

export interface RuleFilter {
  kind?: RuleEventKind[];
  agent?: string[];
  /** Built-in categories or shell sub-category ids; `shell` matches its sub-categories too. */
  toolCategory?: string[];
  /** Raw tool names, exact or with `*` wildcards (`mcp__github__*`). */
  toolName?: string[];
  status?: NormalizedEvent['status'][];
  /** true: only subagents' events; false: only the main agent's. */
  subagent?: boolean;
  hasTarget?: boolean;
  /** Model calls that carry token counts. */
  hasTokens?: boolean;
}

export interface RuleMeasure {
  type: MeasureType;
  filter: RuleFilter;
  /** topShare: how many of the top targets to add up (default 1). */
  n?: number;
}

export type RuleCondition = ({ measure: string } & Partial<Record<Threshold, number>>) | { all: RuleCondition[] } | { any: RuleCondition[] };

/** A parsed, validated rule. The single-measure shorthand (`measure`) becomes a measure named `value`. */
export interface Rule {
  id: string;
  title: string;
  scope: RuleScope;
  windowMinutes?: number;
  /** Applies to every measure, on top of each measure's own filter. */
  filter: RuleFilter;
  measures: Record<string, RuleMeasure>;
  when: RuleCondition;
  severity: 'info' | 'warn';
  summary: string;
  suggestedAction?: string;
}

export interface ParseResult<T> {
  value?: T;
  errors: string[];
}

const RULE_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const MEASURE_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
const RESERVED_NAMES = new Set(['target', 'windowMinutes']);
const MAX_CONDITION_DEPTH = 4;
const RULE_FIELDS = ['id', 'title', 'scope', 'windowMinutes', 'filter', 'measure', 'measures', 'when', 'severity', 'summary', 'suggestedAction'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A string or list of strings, optionally from a fixed set; normalized to a list. */
function stringList<T extends string>(v: unknown, where: string, errors: string[], allowed?: readonly T[]): T[] | undefined {
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === 'string' && s.length > 0)) {
    errors.push(`${where} must be a string or a non-empty list of strings`);
    return undefined;
  }
  const bad = allowed ? list.filter((s) => !allowed.includes(s as T)) : [];
  if (bad.length > 0) {
    errors.push(`${where} has ${bad.map((s) => `"${s}"`).join(', ')}; expected one of ${allowed!.join(', ')}`);
    return undefined;
  }
  return list as T[];
}

function parseFilter(v: unknown, where: string, errors: string[]): RuleFilter {
  if (v === undefined) return {};
  if (!isObject(v)) {
    errors.push(`${where} must be an object`);
    return {};
  }
  const f: RuleFilter = {};
  for (const [key, value] of Object.entries(v)) {
    const at = `${where}.${key}`;
    switch (key) {
      case 'kind':
        f.kind = stringList(value, at, errors, RULE_EVENT_KINDS);
        break;
      case 'agent':
        f.agent = stringList(value, at, errors);
        break;
      case 'toolCategory': {
        f.toolCategory = stringList(value, at, errors);
        const bad = (f.toolCategory ?? []).filter((c) => !isToolCategory(c) && !isShellSubCategoryId(c));
        if (bad.length > 0) errors.push(`${at} has unknown ${bad.map((c) => `"${c}"`).join(', ')}; expected a built-in category or a shell sub-category id`);
        break;
      }
      case 'toolName':
        f.toolName = stringList(value, at, errors);
        break;
      case 'status':
        f.status = stringList(value, at, errors, STATUSES);
        break;
      case 'subagent':
      case 'hasTarget':
      case 'hasTokens':
        if (typeof value === 'boolean') f[key] = value;
        else errors.push(`${at} must be true or false`);
        break;
      default:
        errors.push(`${where} has unknown field "${key}"`);
    }
  }
  return f;
}

function parseMeasure(v: unknown, where: string, errors: string[]): RuleMeasure | undefined {
  if (!isObject(v)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(v)) if (!['type', 'filter', 'n'].includes(key)) errors.push(`${where} has unknown field "${key}"`);
  if (!MEASURE_TYPES.includes(v.type as MeasureType)) {
    errors.push(`${where}.type must be one of ${MEASURE_TYPES.join(', ')}`);
    return undefined;
  }
  const type = v.type as MeasureType;
  if (v.n !== undefined && (type !== 'topShare' || typeof v.n !== 'number' || !Number.isInteger(v.n) || v.n < 1)) {
    errors.push(`${where}.n is only for topShare, as a whole number of targets (1 or more)`);
  }
  return { type, filter: parseFilter(v.filter, `${where}.filter`, errors), ...(type === 'topShare' && typeof v.n === 'number' ? { n: v.n } : {}) };
}

function parseCondition(v: unknown, where: string, names: string[], errors: string[], depth = 1): RuleCondition | undefined {
  if (!isObject(v)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  if ('all' in v || 'any' in v) {
    const op = 'all' in v ? 'all' : 'any';
    if (Object.keys(v).length !== 1) errors.push(`${where} must have only "${op}"`);
    const list = v[op];
    if (depth >= MAX_CONDITION_DEPTH) {
      errors.push(`${where} nests conditions too deeply`);
      return undefined;
    }
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${where}.${op} must be a non-empty list of conditions`);
      return undefined;
    }
    const parts = list.map((c, i) => parseCondition(c, `${where}.${op}[${i}]`, names, errors, depth + 1));
    if (parts.some((p) => !p)) return undefined;
    return op === 'all' ? { all: parts as RuleCondition[] } : { any: parts as RuleCondition[] };
  }
  const measure = v.measure ?? (names.length === 1 ? names[0] : undefined);
  if (typeof measure !== 'string' || !names.includes(measure)) {
    errors.push(names.length === 1 ? `${where}.measure must be "${names[0]}"` : `${where}.measure must name one of the rule's measures: ${names.join(', ')}`);
    return undefined;
  }
  const condition: RuleCondition = { measure };
  for (const [key, value] of Object.entries(v)) {
    if (key === 'measure') continue;
    if (!THRESHOLDS.includes(key as Threshold)) errors.push(`${where} has unknown field "${key}"; thresholds are ${THRESHOLDS.join(', ')}`);
    else if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${where}.${key} must be a number`);
    else condition[key as Threshold] = value;
  }
  if (!THRESHOLDS.some((t) => t in condition)) errors.push(`${where} needs a threshold (${THRESHOLDS.join(', ')})`);
  return condition;
}

/** Placeholders a summary may use: each measure, `<measure>.target` for target measures, `target`, and `windowMinutes`. */
function checkPlaceholders(text: string, where: string, rule: Pick<Rule, 'measures' | 'scope'>, errors: string[]): void {
  const targetful = Object.entries(rule.measures).filter(([, m]) => TARGET_MEASURES.has(m.type)).map(([name]) => name);
  const allowed = new Set([...Object.keys(rule.measures), ...targetful.map((n) => `${n}.target`)]);
  if (targetful.length > 0) allowed.add('target');
  if (rule.scope === 'window') allowed.add('windowMinutes');
  for (const [, name] of text.matchAll(/\{([^}]*)\}/g)) {
    if (!allowed.has(name)) errors.push(`${where} uses {${name}}; available: ${[...allowed].map((a) => `{${a}}`).join(', ')}`);
  }
}

/** Validates a rule document, collecting every problem rather than stopping at the first. */
export function parseRule(doc: unknown): ParseResult<Rule> {
  if (!isObject(doc)) return { errors: ['a rule must be a JSON object'] };
  const errors: string[] = [];
  for (const key of Object.keys(doc)) if (!RULE_FIELDS.includes(key)) errors.push(`unknown field "${key}"`);

  if (typeof doc.id !== 'string' || !RULE_ID.test(doc.id)) errors.push('id must look like "user:read-loop": a source, a colon, then lowercase letters, digits, and dashes');
  if (typeof doc.title !== 'string' || !doc.title.trim()) errors.push('title must be a non-empty string');
  if (!RULE_SCOPES.includes(doc.scope as RuleScope)) errors.push(`scope must be one of ${RULE_SCOPES.join(', ')}`);
  const scope = doc.scope as RuleScope;
  if (scope === 'window') {
    if (typeof doc.windowMinutes !== 'number' || !(doc.windowMinutes > 0)) errors.push('windowMinutes must be a positive number for a window scope');
  } else if (doc.windowMinutes !== undefined) {
    errors.push('windowMinutes is only for a window scope');
  }
  if (doc.severity !== 'info' && doc.severity !== 'warn') errors.push('severity must be "info" or "warn"');

  const filter = parseFilter(doc.filter, 'filter', errors);
  const measures: Record<string, RuleMeasure> = {};
  if ((doc.measure === undefined) === (doc.measures === undefined)) {
    errors.push('give either "measure" (one) or "measures" (named), not both');
  } else if (doc.measure !== undefined) {
    const m = parseMeasure(doc.measure, 'measure', errors);
    if (m) measures.value = m;
  } else if (!isObject(doc.measures) || Object.keys(doc.measures).length === 0) {
    errors.push('measures must be an object naming one or more measures');
  } else {
    for (const [name, value] of Object.entries(doc.measures)) {
      if (!MEASURE_NAME.test(name) || RESERVED_NAMES.has(name)) {
        errors.push(`measure name "${name}" must be letters and digits, and not ${[...RESERVED_NAMES].join(' or ')}`);
        continue;
      }
      const m = parseMeasure(value, `measures.${name}`, errors);
      if (m) measures[name] = m;
    }
  }
  const names = Object.keys(measures);
  const when = names.length > 0 ? parseCondition(doc.when, 'when', names, errors) : undefined;

  if (typeof doc.summary !== 'string' || !doc.summary.trim()) errors.push('summary must be a non-empty string');
  else checkPlaceholders(doc.summary, 'summary', { measures, scope }, errors);
  if (doc.suggestedAction !== undefined) {
    if (typeof doc.suggestedAction !== 'string') errors.push('suggestedAction must be a string');
    else checkPlaceholders(doc.suggestedAction, 'suggestedAction', { measures, scope }, errors);
  }

  if (errors.length > 0 || !when) return { errors };
  return {
    value: {
      id: doc.id as string,
      title: (doc.title as string).trim(),
      scope,
      ...(scope === 'window' ? { windowMinutes: doc.windowMinutes as number } : {}),
      filter,
      measures,
      when,
      severity: doc.severity as Rule['severity'],
      summary: doc.summary as string,
      ...(doc.suggestedAction !== undefined ? { suggestedAction: doc.suggestedAction as string } : {}),
    },
    errors,
  };
}

/** Rules and shell sub-categories from one place they're kept (saved, settings). */
export interface RuleSource {
  origin: string;
  rules: unknown[];
  categories: unknown[];
}

export interface RuleSet {
  rules: Rule[];
  categories: ShellSubCategory[];
  /** One line per document that was ignored, naming where it came from and why. */
  problems: string[];
}

function docId(doc: unknown): string {
  return isObject(doc) && typeof doc.id === 'string' ? doc.id : '(no id)';
}

/** Validates every source; a later source's rule or category replaces an earlier one with the same id. */
export function buildRuleSet(sources: RuleSource[]): RuleSet {
  const rules = new Map<string, Rule>();
  const categories = new Map<string, ShellSubCategory>();
  const problems: string[] = [];
  for (const source of sources) {
    for (const doc of source.rules) {
      const { value, errors } = parseRule(doc);
      if (value) rules.set(value.id, value);
      else problems.push(`${source.origin} rule ${docId(doc)}: ${errors.join('; ')}`);
    }
    for (const doc of source.categories) {
      const { value, errors } = parseShellSubCategory(doc);
      if (value) categories.set(value.id, value);
      else problems.push(`${source.origin} tool category ${docId(doc)}: ${errors.join('; ')}`);
    }
  }
  return { rules: [...rules.values()], categories: [...categories.values()], problems };
}
