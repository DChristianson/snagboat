import * as crypto from 'crypto';
import { DigestPolicy, HOSTED_POLICY, LOCAL_POLICY } from './digest';
import { ID_PATTERN, isObject, parseBaseUrl, parseProviders, ProviderConfig, sendPolicy, parseContextWindow } from './providers';

/**
 * Installed advisors: several, each with a kind, the abilities it offers, and
 * a sending policy per ability. `snagboat.advisors` lists them;
 * `snagboat.advisor.providers` is the short form (one model, every ability,
 * one policy) and keeps working unchanged. See
 * docs/design/trusted-advisor.md#installed-advisors.
 */

/** What an advisor can do. The code keeps the design's older word for it. */
export type Capability = 'summarize-session' | 'report-on-goal' | 'set-up-advisor';

export const CAPABILITIES: readonly Capability[] = ['summarize-session', 'report-on-goal', 'set-up-advisor'];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'summarize-session': 'Summarize a session (Explain)',
  'report-on-goal': "Report on a goal (a goal advisor's performance report)",
  'set-up-advisor': 'Set up an advisor (a conversation on the + page)',
};

/**
 * Abilities removed with the weekly review and Ask the advisor (snagboat-79f.7.12). A setting that still
 * names one isn't a problem: summarize-week, propose-nudges and propose-tactics are ignored, and
 * propose-heuristics, whose sending rules and approval the performance report used, is read as
 * report-on-goal wherever report-on-goal isn't named itself.
 */
export const RETIRED_ABILITIES: Readonly<Record<string, Capability | undefined>> = {
  'summarize-week': undefined,
  'propose-heuristics': 'report-on-goal',
  'propose-nudges': undefined,
  'propose-tactics': undefined,
};

/** The abilities before snagboat-79f.7.12, in their order then, leaving out set-up-advisor (approved on its own). */
const ABILITIES_BEFORE_7_12 = ['summarize-session', 'summarize-week', 'propose-heuristics', 'propose-nudges', 'propose-tactics'] as const;
type AbilityBefore7_12 = (typeof ABILITIES_BEFORE_7_12)[number];

/**
 * Abilities approved on their own, not with the rest of the advisor (snagboat-79f.7.15, decided
 * November 18, 2026). Setting up an advisor sends only what you type in the conversation, so it has its
 * own sending rules and its own approval, and adding it left every existing approval (approvalKey) as it
 * was. To fold it back into the advisor's one approval, remove it here.
 */
export const SEPARATELY_APPROVED: ReadonlySet<Capability> = new Set(['set-up-advisor']);

/** The provider settings from before advisors, read as the default advisor for their ability. */
export const LEGACY_DEFAULT_SETTINGS: Record<string, Capability> = {
  explainProvider: 'summarize-session',
};

/**
 * The id of the advisor an ability uses unless another is picked: its entry in `snagboat.advisor.defaults`,
 * then the entry of a retired ability it took over (report-on-goal reads propose-heuristics), then the
 * older per-ability provider setting (`legacy` reads it by name), then `local`.
 */
export function defaultAdvisorId(ability: Capability, defaults: unknown, legacy: (setting: string) => unknown): string {
  const d = isObject(defaults) ? defaults : {};
  const names = [ability, ...Object.entries(RETIRED_ABILITIES).filter(([, now]) => now === ability).map(([old]) => old)];
  for (const name of names) {
    const set = d[name];
    if (typeof set === 'string' && set.trim()) return set.trim();
  }
  const setting = Object.entries(LEGACY_DEFAULT_SETTINGS).find(([, c]) => c === ability)?.[0];
  const old = setting ? legacy(setting) : undefined;
  return typeof old === 'string' && old ? old : 'local';
}

/** How an advisor is asked. Only `model` can be asked today; the others are reserved for the planned HypAware and agent advisors. */
export type AdvisorKind = 'model' | 'hypaware' | 'agent';
const KINDS: readonly AdvisorKind[] = ['model', 'hypaware', 'agent'];
const ASKABLE: ReadonlySet<AdvisorKind> = new Set(['model']);

export interface AbilityConfig {
  /** What the advisor may receive for this ability. */
  policy: DigestPolicy;
  /** A file replacing Snagboat's instruction for this ability (see ./prompts.ts). */
  promptFile?: string;
}

export interface AdvisorConfig extends ProviderConfig {
  kind: AdvisorKind;
  /** The abilities it offers, each with its own policy; absent abilities aren't offered. */
  abilities: Partial<Record<Capability, AbilityConfig>>;
  /** Which setting it came from, so a model picked on first use is written back to the right one. */
  source: 'advisors' | 'providers';
  /** Its persona and strategy, as text in the setting, or in a file (see ./prompts.ts). */
  persona?: string;
  personaFile?: string;
  /**
   * What it offered before snagboat-79f.7.12 removed abilities, by their names then, so an approval given
   * before then still counts (approvalKeyBefore7_12). Absent when there is nothing to go on.
   */
  before7_12?: Partial<Record<AbilityBefore7_12, AbilityConfig>>;
}

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
}

function allAbilities(policy: DigestPolicy): AdvisorConfig['abilities'] {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, { policy }]));
}

/** Every ability before snagboat-79f.7.12 with one policy: what an advisor offering them all offered then. */
function allBefore7_12(policy: DigestPolicy): NonNullable<AdvisorConfig['before7_12']> {
  return Object.fromEntries(ABILITIES_BEFORE_7_12.map((c) => [c, { policy }]));
}

/**
 * Advisors from both settings. A provider is a model advisor offering every
 * ability with its one policy. The providers default (Ollama on localhost)
 * applies only when neither setting is set.
 */
export function parseAdvisors(advisorsValue: unknown, providersValue: unknown): { advisors: AdvisorConfig[]; problems: string[] } {
  const advisors: AdvisorConfig[] = [];
  const problems: string[] = [];
  const explicit = Array.isArray(advisorsValue) && advisorsValue.length > 0;
  const fromProviders = parseProviders(explicit && !Array.isArray(providersValue) ? [] : providersValue);
  problems.push(...fromProviders.problems);
  for (const p of fromProviders.providers) advisors.push({ ...p, kind: 'model', abilities: allAbilities(p.policy), source: 'providers', before7_12: allBefore7_12(p.policy) });

  for (const [i, entry] of (Array.isArray(advisorsValue) ? advisorsValue : []).entries()) {
    const where = isObject(entry) && typeof entry.id === 'string' ? `advisor ${entry.id}` : `advisor ${i + 1}`;
    if (!isObject(entry) || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
      problems.push(`${where}: id must be lowercase letters, digits, and dashes`);
      continue;
    }
    if (advisors.some((a) => a.id === entry.id)) {
      problems.push(`${where}: another advisor or provider has this id`);
      continue;
    }
    const kind = entry.kind === undefined ? 'model' : (KINDS as readonly unknown[]).includes(entry.kind) ? (entry.kind as AdvisorKind) : undefined;
    if (!kind) {
      problems.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
      continue;
    }
    if (!ASKABLE.has(kind)) {
      problems.push(`${where}: ${kind} advisors aren't available yet`);
      continue;
    }
    const address = parseBaseUrl(entry, where, problems);
    if (!address) continue;
    const base = address.locality === 'local' ? LOCAL_POLICY : HOSTED_POLICY;
    const policy = sendPolicy(entry.send, base);
    const parsed = parseAbilities(entry.abilities, policy, where, problems);
    if (!parsed) continue;
    const { abilities, before7_12 } = parsed;
    advisors.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : entry.id,
      ...address,
      model: typeof entry.model === 'string' ? entry.model.trim() : '',
      ...(() => {
        const contextWindow = parseContextWindow(entry.contextWindow, where, problems);
        return contextWindow ? { contextWindow } : {};
      })(),
      policy,
      kind,
      abilities,
      source: 'advisors',
      ...(before7_12 ? { before7_12 } : {}),
      ...(typeof entry.persona === 'string' && entry.persona.trim() ? { persona: entry.persona.trim() } : {}),
      ...(typeof entry.personaFile === 'string' && entry.personaFile.trim() ? { personaFile: entry.personaFile.trim() } : {}),
    });
  }
  return { advisors, problems };
}

/**
 * `abilities`: absent means every ability with the advisor's policy; an object
 * names each one as true, false, or `{ send }` for a policy of its own over
 * the advisor's. A retired ability (RETIRED_ABILITIES) is no problem: it is
 * read as the ability that took it over unless that one is named too, and
 * kept in `before7_12` for approvals given before it was retired.
 */
function parseAbilities(value: unknown, policy: DigestPolicy, where: string, problems: string[]): Pick<AdvisorConfig, 'abilities' | 'before7_12'> | undefined {
  if (value === undefined) return { abilities: allAbilities(policy), before7_12: allBefore7_12(policy) };
  if (!isObject(value)) {
    problems.push(`${where}: abilities must be an object naming each ability`);
    return undefined;
  }
  const abilities: AdvisorConfig['abilities'] = {};
  const before7_12: NonNullable<AdvisorConfig['before7_12']> = {};
  for (const [name, v] of Object.entries(value)) {
    const current = isCapability(name);
    if (!current && !(name in RETIRED_ABILITIES)) {
      problems.push(`${where}: unknown ability "${name}" (one of ${CAPABILITIES.join(', ')})`);
      return undefined;
    }
    let config: AbilityConfig;
    if (v === false) continue;
    if (v === true) config = { policy };
    else if (isObject(v)) {
      const promptFile = typeof v.prompt === 'string' && v.prompt.trim() ? v.prompt.trim() : undefined;
      config = { policy: sendPolicy(v.send, policy), ...(promptFile ? { promptFile } : {}) };
    } else {
      problems.push(`${where}: ability "${name}" must be true, false, or an object`);
      return undefined;
    }
    if (current) abilities[name] = config;
    if ((ABILITIES_BEFORE_7_12 as readonly string[]).includes(name)) before7_12[name as AbilityBefore7_12] = config;
  }
  // A retired ability's settings for the ability that took it over, when that one isn't named.
  for (const [old, now] of Object.entries(RETIRED_ABILITIES)) {
    const config = before7_12[old as AbilityBefore7_12];
    if (now && config && !(now in value)) abilities[now] = config;
  }
  if (Object.keys(abilities).length === 0) problems.push(`${where}: offers no ability`);
  return { abilities, ...(Object.keys(before7_12).length ? { before7_12 } : {}) };
}

/**
 * What an approval covers: where requests go and what each ability may
 * contain. Changing either asks again; changing the model, or a prompt,
 * doesn't (a prompt changes what's asked, not what data is sent, and the
 * approval document shows it).
 */
export function approvalKey(a: AdvisorConfig): string {
  const abilities = CAPABILITIES.filter((c) => a.abilities[c] && !SEPARATELY_APPROVED.has(c)).map((c) => [c, a.abilities[c]!.policy]);
  return crypto.createHash('sha256').update(JSON.stringify({ id: a.id, baseUrl: a.baseUrl, abilities })).digest('hex').slice(0, 16);
}

/**
 * The advisor's one approval key as it was before snagboat-79f.7.12 removed abilities, worked out from
 * what it offered then (`before7_12`). An approval given then covered at least what it may be sent now,
 * so it still counts, as long as report-on-goal kept propose-heuristics' sending rules. Undefined when
 * there is nothing to work it out from.
 */
export function approvalKeyBefore7_12(a: AdvisorConfig): string | undefined {
  const then = a.before7_12;
  if (!then) return undefined;
  const now = a.abilities['report-on-goal'];
  if (now && JSON.stringify(then['propose-heuristics']?.policy) !== JSON.stringify(now.policy)) return undefined;
  const abilities = ABILITIES_BEFORE_7_12.filter((c) => then[c]).map((c) => [c, then[c]!.policy]);
  return crypto.createHash('sha256').update(JSON.stringify({ id: a.id, baseUrl: a.baseUrl, abilities })).digest('hex').slice(0, 16);
}

/**
 * Whether you have approved asking an advisor for an ability: its approval now (approvalFor), or, for the
 * advisor's one approval, the same approval given before snagboat-79f.7.12 (approvalKeyBefore7_12).
 */
export function isApproved(approvals: Record<string, string>, a: AdvisorConfig, ability: Capability): boolean {
  const { name, key } = approvalFor(a, ability);
  if (approvals[name] === key) return true;
  if (SEPARATELY_APPROVED.has(ability)) return false;
  const before = approvalKeyBefore7_12(a);
  return before !== undefined && approvals[name] === before;
}

/**
 * Where an approval to ask an advisor for an ability is kept, and what it covers: the advisor's one
 * approval (its id, approvalKey), or, for an ability approved on its own, `<id>#<ability>` over the
 * address and that ability's sending rules.
 */
export function approvalFor(a: AdvisorConfig, ability: Capability): { name: string; key: string } {
  if (!SEPARATELY_APPROVED.has(ability)) return { name: a.id, key: approvalKey(a) };
  const policy = a.abilities[ability]?.policy ?? a.policy;
  return { name: `${a.id}#${ability}`, key: crypto.createHash('sha256').update(JSON.stringify({ id: a.id, baseUrl: a.baseUrl, ability, policy })).digest('hex').slice(0, 16) };
}

/** How an answer is labelled: the advisor, its kind, and its model. */
export function describeAdvisor(a: Pick<AdvisorConfig, 'label' | 'kind' | 'model'>): string {
  return a.kind === 'model' ? `${a.label}, model \`${a.model}\`` : `${a.label} (${a.kind})`;
}
