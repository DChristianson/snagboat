import { Baseline } from '../discovery/discover';
import { Probe } from '../discovery/probes';
import { DigestTurn } from './digest';
import { PromptLayers, systemPrompt } from './prompts';
import { ChatMessage } from './providers';

/**
 * Propose heuristics: the advisor's part in discovery. It names and explains discovery's
 * candidates, may propose a few rules of its own, and groups shell command
 * families into categories. It only ever returns data: every rule and category
 * is validated like a hand-written one and scored by replay before you see it,
 * and nothing is saved until you accept. The system prompt's layers are in
 * ./prompts.ts. See docs/design/trusted-advisor.md.
 */

export interface ProposeCandidate {
  id: string;
  /** Completes "turns with N or more …". */
  describes: string;
  kind: Probe['kind'];
  threshold: number;
  baseline: Baseline;
  turnsAbove: number;
  /** Placeholders its summary may use. */
  placeholders: string[];
  /** Digests of turns that reached the threshold. */
  examples: DigestTurn[];
}

/** How a heuristic or rule did over the discovery window, as sent. */
export interface EffectivenessInput {
  id: string;
  title?: string;
  /** A built-in (its threshold is a setting) rather than a saved rule. */
  builtIn: boolean;
  episodes: number;
  warnings: number;
  sessions: number;
  acknowledged?: number;
  medianMinutesToAcknowledge?: number;
  expiredUnacknowledged?: number;
  muted: boolean;
}

/** A built-in threshold against the person's own history, as sent. */
export interface ThresholdInput {
  heuristic: string;
  setting: string;
  describes: string;
  current: number;
  /** Share of turns at or above the current setting. */
  currentShare: number;
  /** Discovery's own suggestion at the person's tail, if any. */
  suggested?: number;
  suggestedShare?: number;
}

export interface ProposeInput {
  turns: number;
  sessions: number;
  candidates: ProposeCandidate[];
  shell: { shellCalls: number; families: Array<{ name: string; calls: number }> };
  /** The agents' tool names seen (Bash, Read, mcp__github__…), with calls, so rules filter on names that exist. */
  toolNames: Array<{ name: string; calls: number }>;
  /** How the current heuristics and rules did, so the advisor can judge what to retire or re-threshold. */
  effectiveness?: EffectivenessInput[];
  thresholds?: ThresholdInput[];
}

/** Bounds on what's sent: a few candidates, two example turns each, the commonest command families. */
export const MAX_PROPOSE_CANDIDATES = 6;
export const MAX_EXAMPLES_PER_CANDIDATE = 2;
export const MAX_FAMILIES = 30;
export const MAX_TOOL_NAMES = 30;
const MAX_RULES = 3;
const MAX_CATEGORIES = 6;
export const MAX_EFFECTIVENESS = 30;
const MAX_RETIRE = 5;
const MAX_THRESHOLDS = 5;

export function proposeHeuristicsMessages(input: ProposeInput, prompts: PromptLayers = {}): ChatMessage[] {
  const data = {
    history: { turns: input.turns, sessions: input.sessions },
    candidates: input.candidates.map((c) => ({
      id: c.id,
      pattern: `turns with ${c.threshold} or more ${c.describes}`,
      turnsReaching: c.turnsAbove,
      yourMedian: c.baseline.p50,
      your99thPercentile: c.baseline.p99,
      placeholders: c.placeholders.map((p) => `{${p}}`),
      exampleTurns: c.examples,
    })),
    shellCommandFamilies: { plainShellCalls: input.shell.shellCalls, families: input.shell.families },
    toolNames: input.toolNames,
    ...(input.effectiveness ? { effectiveness: input.effectiveness.slice(0, MAX_EFFECTIVENESS) } : {}),
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
  };
  return [
    { role: 'system', content: systemPrompt('propose-heuristics', prompts) },
    { role: 'user', content: `Propose heuristics from this discovery.\n\nData:\n${JSON.stringify(data)}` },
  ];
}

export interface Proposals {
  names: Array<{ id: string; title: string; summary: string; suggestedAction: string }>;
  rules: Array<Record<string, unknown> & { id: string }>;
  categories: Array<{ label: string; match: string[] }>;
  /** Heuristics or rules it thinks should go, from those it was told about. */
  retire: Array<{ id: string; reason: string }>;
  /** Threshold changes for built-ins, from the settings it was told about. */
  thresholds: Array<{ heuristic: string; setting: string; value: number; reason: string }>;
  /** What was dropped from the answer, and why. */
  problems: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first JSON object in a model's answer, allowing for code fences or text around it. */
function firstObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/** What the answer may refer to: the heuristics it was told how did, and the thresholds it was shown. */
export interface Known {
  heuristicIds: Set<string>;
  thresholds: Array<{ heuristic: string; setting: string }>;
}

/**
 * Reads the answer's shape only; whether each rule or category is valid is
 * decided by the same validators as hand-written ones. New rules always get an
 * `advisor:` id, so they can't replace a rule of yours. Retire and threshold
 * proposals may name only what the request listed.
 */
export function parseProposals(text: string, candidateIds: Set<string>, known: Known = { heuristicIds: new Set(), thresholds: [] }): Proposals {
  const out: Proposals = { names: [], rules: [], categories: [], retire: [], thresholds: [], problems: [] };
  const answer = firstObject(text);
  if (!isObject(answer)) {
    out.problems.push('the answer was not a JSON object');
    return out;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  for (const n of Array.isArray(answer.names) ? answer.names : []) {
    if (!isObject(n) || !candidateIds.has(str(n.id))) {
      out.problems.push(`a name for an unknown candidate (${isObject(n) ? str(n.id) || 'no id' : 'not an object'}) was dropped`);
      continue;
    }
    if (!str(n.title) || !str(n.summary)) {
      out.problems.push(`the name for ${str(n.id)} had no title or summary`);
      continue;
    }
    out.names.push({ id: str(n.id), title: str(n.title).slice(0, 80), summary: str(n.summary).slice(0, 200), suggestedAction: str(n.suggestedAction).slice(0, 300) });
  }
  const rules = Array.isArray(answer.rules) ? answer.rules : [];
  if (rules.length > MAX_RULES) out.problems.push(`${rules.length - MAX_RULES} rules past the first ${MAX_RULES} were dropped`);
  for (const r of rules.slice(0, MAX_RULES)) {
    if (!isObject(r)) continue;
    const name = slug(str(r.id).replace(/^[a-z-]*:/, '')) || slug(str(r.title)) || 'rule';
    out.rules.push({ ...r, id: `advisor:${name}` });
  }
  const categories = Array.isArray(answer.categories) ? answer.categories : [];
  for (const c of categories.slice(0, MAX_CATEGORIES)) {
    if (!isObject(c) || !str(c.label) || !Array.isArray(c.match)) continue;
    out.categories.push({ label: str(c.label).slice(0, 40), match: c.match.filter((m): m is string => typeof m === 'string') });
  }
  for (const r of (Array.isArray(answer.retire) ? answer.retire : []).slice(0, MAX_RETIRE)) {
    if (!isObject(r)) continue;
    if (!known.heuristicIds.has(str(r.id))) {
      out.problems.push(`a retire proposal for ${str(r.id) || 'no id'} was dropped: it wasn't among the heuristics it was told about`);
      continue;
    }
    out.retire.push({ id: str(r.id), reason: str(r.reason).slice(0, 200) });
  }
  for (const t of (Array.isArray(answer.thresholds) ? answer.thresholds : []).slice(0, MAX_THRESHOLDS)) {
    if (!isObject(t)) continue;
    const heuristic = str(t.heuristic);
    const setting = str(t.setting);
    if (!known.thresholds.some((k) => k.heuristic === heuristic && k.setting === setting)) {
      out.problems.push(`a threshold proposal for ${heuristic || 'no heuristic'} ${setting} was dropped: not a setting it was shown`);
      continue;
    }
    if (typeof t.value !== 'number' || !Number.isFinite(t.value) || t.value <= 0) {
      out.problems.push(`the threshold proposal for ${heuristic} ${setting} was dropped: its value isn't a positive number`);
      continue;
    }
    out.thresholds.push({ heuristic, setting, value: t.value, reason: str(t.reason).slice(0, 200) });
  }
  return out;
}

/**
 * A suggested action that tells the person to look rather than what to do:
 * "check what the agent is doing" names no cause and no action. A hint for
 * the eval report, not a validator.
 */
export function weakAction(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length < 4) return true;
  return /^(check|look|review|investigate|consider|monitor|watch|see|verify)\b/i.test(t) && !/\b(instead|run|add|split|point|set|use|ask|write|move|stop|break|reduce|raise|lower|switch|pick|give|tell|plan|try)\b/i.test(t);
}

/** An advisor category as a sub-category document, for the usual validator. */
export function categoryDoc(c: { label: string; match: string[] }): Record<string, unknown> {
  return { id: `advisor:shell/${slug(c.label) || 'commands'}`, parent: 'shell', label: c.label, match: c.match };
}
