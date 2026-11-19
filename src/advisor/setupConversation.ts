import { SetupProposal, SetupTurn } from '@snagboat/schema';
import { HEURISTIC_GLOSSARY } from './glossary';
import { ADVISOR_PERIODS } from './goals';
import { advisorId, checkNewAdvisor, CUE_COLORS, CUE_ICONS } from './newAdvisor';
import { PromptLayers, systemPrompt } from './prompts';
import { ChatMessage } from './providers';

/**
 * Setting up an advisor by conversation (docs/design/goal-tracking-lifecycle.md, "You set a goal";
 * snagboat-79f.7.15): the prompt for one model turn, and the checks on its answer. The model is sent
 * the conversation (what you typed, and its own earlier answers) and Snagboat's lists to choose from:
 * the measures, the rules an advisor can speak for (ids and titles), periods, colors, icons, and the
 * advisor names already taken. Nothing from your sessions is sent. It answers with a reply and, once it
 * knows enough, a proposed advisor, which is checked as the + form is (checkNewAdvisor): ids not on the
 * lists are dropped with a reason, and a proposal that still doesn't pass is kept out, its problems
 * recorded, so you can ask it to fix them.
 */

export interface SetupCatalog {
  measures: Array<{ id: string; label: string; unit: string }>;
  rules: Array<{ id: string; title?: string }>;
  /** Advisor ids already in use (built-ins and yours). */
  taken: string[];
}

/** What each built-in rule reports, by id (the glossary's lines), for rules that have no title of their own. */
const RULE_MEANINGS: Record<string, string> = Object.fromEntries(
  HEURISTIC_GLOSSARY.split('\n')
    .map((l) => /^- ([a-z-]+): (.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]])
);

/**
 * What Snagboat tells the model when its proposal was kept out: the problems, and the lists again in a
 * line each, since small models invent ids and reuse names the long list didn't stop them using.
 */
export function repairNote(problems: string[], catalog: SetupCatalog): string {
  return [
    `(From Snagboat, not the person.) Your proposal couldn't be used: ${problems.join(' ')}`,
    `Answer again with a corrected proposal. measures must come from exactly these ids: ${catalog.measures.map((m) => m.id).join(', ')}.`,
    `rules must come from exactly these ids: ${catalog.rules.map((r) => r.id).join(', ')}.`,
    `The name must not be any of: ${catalog.taken.join(', ')}.`,
  ].join(' ');
}

/** The messages for the model's next turn. */
export function setupMessages(turns: SetupTurn[], catalog: SetupCatalog, prompts: PromptLayers = {}): ChatMessage[] {
  const data = {
    measures: catalog.measures.map((m) => ({ id: m.id, label: m.label, unit: m.unit })),
    rules: catalog.rules.map((r) => {
      const title = r.title ?? RULE_MEANINGS[r.id];
      return { id: r.id, ...(title ? { title } : {}) };
    }),
    periods: ADVISOR_PERIODS,
    colors: CUE_COLORS,
    icons: CUE_ICONS,
    taken: catalog.taken,
  };
  const messages: ChatMessage[] = [{ role: 'system', content: `${systemPrompt('set-up-advisor', prompts)}\n\nWhat you may choose from:\n${JSON.stringify(data)}` }];
  for (const t of turns) {
    if (t.from === 'you') {
      if (!t.text) continue; // a model switch, with no words
      messages.push({ role: 'user', content: t.revise ? `A note on your last proposal; answer it with a revised proposal: ${t.text}` : t.text });
    } else {
      const { model: _model, ...proposal } = t.proposal ?? ({} as Partial<SetupProposal>);
      messages.push({ role: 'assistant', content: JSON.stringify({ reply: t.text, proposal: t.proposal ? proposal : null }) });
      // Its proposal was kept out: say why, so the next answer can fix it.
      if (!t.proposal && t.problems?.length) messages.push({ role: 'user', content: repairNote(t.problems, catalog) });
    }
  }
  return messages;
}

/** The first JSON object in a model's answer, allowing for code fences or text around it. */
function firstObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(body.slice(start, end + 1)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface SetupAnswer {
  reply: string;
  /** A proposal that passes the + form's checks, with the answering model as its model. */
  proposal?: SetupProposal;
  /** What was dropped from the answer, and why. */
  problems: string[];
  /** It proposed an advisor, but the proposal didn't pass the checks and was kept out. */
  rejected?: boolean;
}

const MAX_REPLY = 4000;

/**
 * Checks a model's answer. model: the model advisor that answered, which becomes the proposed advisor's
 * model (it must be one the + form would accept, so it's in knownModels).
 */
export function parseSetupAnswer(text: string, catalog: SetupCatalog, model: string, knownModels: string[]): SetupAnswer {
  const problems: string[] = [];
  const v = firstObject(text);
  if (!v) {
    // A model that ignored the shape and just talked: its words are the reply.
    const reply = text.trim().slice(0, MAX_REPLY);
    return { reply: reply || '(no answer)', problems: reply ? ['the answer was not the JSON asked for; kept as a reply'] : ['the answer was empty'] };
  }
  const reply = typeof v.reply === 'string' && v.reply.trim() ? v.reply.trim().slice(0, MAX_REPLY) : '';
  const p = v.proposal;
  if (p === null || p === undefined) {
    if (!reply) problems.push('the answer had no reply and no proposal');
    return { reply: reply || '(no answer)', problems };
  }
  if (typeof p !== 'object' || Array.isArray(p)) {
    problems.push('its proposal was not an object');
    return { reply: reply || '(no answer)', problems };
  }
  const raw = p as Record<string, unknown>;
  const ids = (key: string, known: Set<string>, what: string): string[] => {
    const list = Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const unknown = list.filter((x) => !known.has(x));
    if (unknown.length) problems.push(`dropped ${what} not on the list: ${unknown.join(', ')}`);
    return list.filter((x) => known.has(x));
  };
  const input = {
    ...raw,
    measures: ids('measures', new Set(catalog.measures.map((m) => m.id)), 'measures'),
    rules: ids('rules', new Set(catalog.rules.map((r) => r.id)), 'rules'),
    // Small models leave these out; the + form's defaults stand in.
    maxPerHour: raw.maxPerHour ?? 2,
    color: (CUE_COLORS as readonly unknown[]).includes(raw.color) ? raw.color : 'blue',
    icon: (CUE_ICONS as readonly unknown[]).includes(raw.icon) ? raw.icon : 'compass',
    model,
  };
  const checked = checkNewAdvisor(input, catalog.rules.map((r) => r.id), knownModels);
  if (checked.spec && catalog.taken.includes(advisorId(checked.spec.name))) checked.problems.push(`An advisor called ${advisorId(checked.spec.name)} already exists; it needs another name.`);
  if (!checked.spec || checked.problems.length) {
    problems.push(...checked.problems);
    return { reply: reply || 'I proposed an advisor, but it did not pass the checks.', problems, rejected: true };
  }
  return { reply: reply || `I propose ${checked.spec.name}: ${checked.spec.status}.`, proposal: checked.spec, problems };
}
