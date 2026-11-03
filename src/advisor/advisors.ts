import * as crypto from 'crypto';
import { DigestPolicy, HOSTED_POLICY, LOCAL_POLICY } from './digest';
import { ID_PATTERN, isObject, parseBaseUrl, parseProviders, ProviderConfig, sendPolicy } from './providers';

/**
 * Installed advisors: several, each with a kind, the abilities it offers, and
 * a sending policy per ability. `snagboat.advisors` lists them;
 * `snagboat.advisor.providers` is the short form (one model, every ability,
 * one policy) and keeps working unchanged. See
 * docs/design/trusted-advisor.md#installed-advisors.
 */

/** What an advisor can do. The code keeps the design's older word for it. */
export type Capability = 'summarize-session' | 'summarize-week' | 'propose-heuristics' | 'propose-nudges' | 'propose-tactics';

export const CAPABILITIES: readonly Capability[] = ['summarize-session', 'summarize-week', 'propose-heuristics', 'propose-nudges', 'propose-tactics'];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'summarize-session': 'Summarize a session (Explain)',
  'summarize-week': 'Summarize the week (in the review)',
  'propose-heuristics': 'Propose heuristics (Ask the advisor)',
  'propose-nudges': 'Propose nudges (in the review, and the live line)',
  'propose-tactics': 'Propose tactics',
};

/** The provider settings from before advisors, read as the default advisor for their ability. */
export const LEGACY_DEFAULT_SETTINGS: Record<string, Capability> = {
  explainProvider: 'summarize-session',
  reviewProvider: 'summarize-week',
  proposeProvider: 'propose-heuristics',
  nudgeProvider: 'propose-nudges',
};

/** How an advisor is asked. Only `model` can be asked today; the others are reserved for the phase 5 spikes. */
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
}

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
}

function allAbilities(policy: DigestPolicy): AdvisorConfig['abilities'] {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, { policy }]));
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
  for (const p of fromProviders.providers) advisors.push({ ...p, kind: 'model', abilities: allAbilities(p.policy), source: 'providers' });

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
    const abilities = parseAbilities(entry.abilities, policy, where, problems);
    if (!abilities) continue;
    advisors.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : entry.id,
      ...address,
      model: typeof entry.model === 'string' ? entry.model.trim() : '',
      policy,
      kind,
      abilities,
      source: 'advisors',
      ...(typeof entry.persona === 'string' && entry.persona.trim() ? { persona: entry.persona.trim() } : {}),
      ...(typeof entry.personaFile === 'string' && entry.personaFile.trim() ? { personaFile: entry.personaFile.trim() } : {}),
    });
  }
  return { advisors, problems };
}

/**
 * `abilities`: absent means every ability with the advisor's policy; an object
 * names each one as true, false, or `{ send }` for a policy of its own over
 * the advisor's.
 */
function parseAbilities(value: unknown, policy: DigestPolicy, where: string, problems: string[]): AdvisorConfig['abilities'] | undefined {
  if (value === undefined) return allAbilities(policy);
  if (!isObject(value)) {
    problems.push(`${where}: abilities must be an object naming each ability`);
    return undefined;
  }
  const abilities: AdvisorConfig['abilities'] = {};
  for (const [name, v] of Object.entries(value)) {
    if (!isCapability(name)) {
      problems.push(`${where}: unknown ability "${name}" (one of ${CAPABILITIES.join(', ')})`);
      return undefined;
    }
    if (v === false) continue;
    if (v === true) abilities[name] = { policy };
    else if (isObject(v)) {
      const promptFile = typeof v.prompt === 'string' && v.prompt.trim() ? v.prompt.trim() : undefined;
      abilities[name] = { policy: sendPolicy(v.send, policy), ...(promptFile ? { promptFile } : {}) };
    } else {
      problems.push(`${where}: ability "${name}" must be true, false, or an object`);
      return undefined;
    }
  }
  if (Object.keys(abilities).length === 0) problems.push(`${where}: offers no ability`);
  return abilities;
}

/**
 * What an approval covers: where requests go and what each ability may
 * contain. Changing either asks again; changing the model, or a prompt,
 * doesn't (a prompt changes what's asked, not what data is sent, and the
 * approval document shows it).
 */
export function approvalKey(a: AdvisorConfig): string {
  const abilities = CAPABILITIES.filter((c) => a.abilities[c]).map((c) => [c, a.abilities[c]!.policy]);
  return crypto.createHash('sha256').update(JSON.stringify({ id: a.id, baseUrl: a.baseUrl, abilities })).digest('hex').slice(0, 16);
}

/** How an answer is labelled: the advisor, its kind, and its model. */
export function describeAdvisor(a: Pick<AdvisorConfig, 'label' | 'kind' | 'model'>): string {
  return a.kind === 'model' ? `${a.label}, model \`${a.model}\`` : `${a.label} (${a.kind})`;
}
