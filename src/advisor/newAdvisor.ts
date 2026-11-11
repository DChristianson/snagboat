import * as fs from 'fs';
import * as path from 'path';
import { AdvisorGoal, DEFAULT_PERSONAS, parseAdvisor } from './goals';
import { MEASURES } from './measures';

/**
 * Adding an advisor (RFC step 5c, the + on the advisor UI): a short form becomes
 * a new ~/.snagboat/advisors/<id>/persona.md, front matter (status line, goal,
 * measures, the rules it speaks for, its notification limit, its cue) above its
 * voice. Only ever a new folder: an existing advisor, built in or yours, is
 * never overwritten from here; edit its persona.md for that.
 */

export const CUE_COLORS = ['amber', 'blue', 'red', 'teal'] as const;
export const CUE_ICONS = ['coin', 'compass', 'anchor', 'telescope'] as const;

export interface NewAdvisor {
  name: string;
  /** Its goal in plain words: "Keeping token cost down". */
  status: string;
  /** What it works toward, as an id: token-cost-down. */
  goal: string;
  measures: string[];
  /** Heuristic or rule ids whose notifications it speaks for. */
  rules: string[];
  maxPerHour: number;
  color: (typeof CUE_COLORS)[number];
  icon: (typeof CUE_ICONS)[number];
  voice: string;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const LIMITS = { name: 40, status: 80, goal: 48, voice: 2000, list: 12, maxPerHour: 20 };

/** The folder name for an advisor called this: lowercase, dashes. */
export function advisorId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** One line of text for the front matter, double-quoted with \ and " escaped. */
const quoted = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ').trim() : '');

/** Checks the form; problems in plain words, or the cleaned spec. */
export function checkNewAdvisor(input: unknown, knownRules: Iterable<string>): { spec?: NewAdvisor; problems: string[] } {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const name = oneLine(v.name);
  const status = oneLine(v.status);
  const goal = oneLine(v.goal).toLowerCase();
  const voice = typeof v.voice === 'string' ? v.voice.replace(/\r\n/g, '\n').trim() : '';
  if (!name) problems.push('Give it a name.');
  else if (name.length > LIMITS.name) problems.push(`Its name is at most ${LIMITS.name} characters.`);
  else if (!ID.test(advisorId(name))) problems.push('Its name needs a letter to start with.');
  if (!status) problems.push('Give it a status line: its goal in plain words.');
  else if (status.length > LIMITS.status) problems.push(`The status line is at most ${LIMITS.status} characters.`);
  if (!ID.test(goal) || goal.length > LIMITS.goal) problems.push('The goal is an id: lowercase letters, digits and dashes, starting with a letter (e.g. fewer-retries).');
  if (voice.length > LIMITS.voice) problems.push(`Its voice is at most ${LIMITS.voice} characters.`);
  if (/^---\s*$/m.test(voice)) problems.push('Its voice cannot contain a line of only ---.');
  const list = (key: string) => (Array.isArray(v[key]) ? (v[key] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const measures = [...new Set(list('measures'))];
  const unknownMeasures = measures.filter((m) => !(m in MEASURES));
  if (!measures.length) problems.push('Pick at least one measure.');
  if (measures.length > LIMITS.list) problems.push(`At most ${LIMITS.list} measures.`);
  if (unknownMeasures.length) problems.push(`No such measure: ${unknownMeasures.join(', ')}.`);
  const known = new Set(knownRules);
  const rules = [...new Set(list('rules'))];
  const unknownRules = rules.filter((r) => !known.has(r));
  if (rules.length > LIMITS.list) problems.push(`At most ${LIMITS.list} rules.`);
  if (unknownRules.length) problems.push(`No such heuristic or rule: ${unknownRules.join(', ')}.`);
  const maxPerHour = Number(v.maxPerHour);
  if (!Number.isInteger(maxPerHour) || maxPerHour < 0 || maxPerHour > LIMITS.maxPerHour) problems.push(`Notifications an hour: a whole number from 0 to ${LIMITS.maxPerHour}.`);
  const color = CUE_COLORS.find((c) => c === v.color);
  const icon = CUE_ICONS.find((c) => c === v.icon);
  if (!color) problems.push(`Pick a color: ${CUE_COLORS.join(', ')}.`);
  if (!icon) problems.push(`Pick an icon: ${CUE_ICONS.join(', ')}.`);
  if (problems.length) return { problems };
  return { spec: { name, status, goal, measures, rules, maxPerHour, color: color!, icon: icon!, voice }, problems };
}

/** persona.md for a new advisor. */
export function personaText(spec: NewAdvisor): string {
  const lines = [
    '---',
    `id: ${advisorId(spec.name)}`,
    `name: ${quoted(spec.name)}`,
    `goal: ${spec.goal}`,
    `status: ${quoted(spec.status)}`,
    `measures: [${spec.measures.join(', ')}]`,
    'reads: [events, findings, outcomes]',
    'may_change: [rules]',
    'notify:',
    `  rules: [${spec.rules.join(', ')}]`,
    `  max_per_hour: ${spec.maxPerHour}`,
    `cue: { icon: ${spec.icon}, color: ${spec.color} }`,
    '---',
    spec.voice || `You watch this project for ${spec.status.charAt(0).toLowerCase()}${spec.status.slice(1)}. Say plainly what you see, with the session, turn and numbers behind it.`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Writes the new advisor's persona.md, in a new folder only. Throws with a
 * plain-words message when the id is taken (a built-in, or a folder already there).
 */
export function writeNewAdvisor(advisorsDir: string, spec: NewAdvisor): AdvisorGoal {
  const id = advisorId(spec.name);
  if (id in DEFAULT_PERSONAS) throw new Error(`${spec.name} is a built-in advisor's name; pick another, or edit its persona.md.`);
  const dir = path.join(advisorsDir, id);
  const text = personaText(spec);
  const parsed = parseAdvisor(text, path.join(dir, 'persona.md'), id);
  if (!parsed.advisor || parsed.problems.length) throw new Error(`couldn't write that advisor: ${parsed.problems.join('; ') || 'its front matter did not read back'}`);
  fs.mkdirSync(advisorsDir, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`An advisor called ${id} already exists; edit its persona.md (${path.join(dir, 'persona.md')}) instead.`);
    throw err;
  }
  fs.writeFileSync(path.join(dir, 'persona.md'), text, { mode: 0o600, flag: 'wx' });
  return parsed.advisor;
}

/** The built-ins as starting points for the form. */
export function advisorTemplates(builtIns: AdvisorGoal[]): Array<Omit<NewAdvisor, 'name'> & { from: string; name: string }> {
  return builtIns.map((a) => ({
    from: a.id,
    name: a.name,
    status: a.status,
    goal: a.goal,
    measures: a.measures,
    rules: a.notify.rules,
    maxPerHour: a.notify.maxPerHour ?? 0,
    color: (CUE_COLORS as readonly string[]).includes(a.cue?.color ?? '') ? (a.cue!.color as NewAdvisor['color']) : 'blue',
    icon: (CUE_ICONS as readonly string[]).includes(a.cue?.icon ?? '') ? (a.cue!.icon as NewAdvisor['icon']) : 'compass',
    voice: a.voice,
  }));
}
