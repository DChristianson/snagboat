import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Advisors as goals (RFC step 4c, docs/design/architecture-rfc.md "Advisors
 * and measurable outcomes"): an advisor is one measurement goal plus the
 * rules, and the voice, that serve it. Its persona.md holds both: front matter
 * for the goal, the body for the voice.
 *
 *   ---
 *   id: purser
 *   name: Purser
 *   goal: token-cost-down
 *   measures: [tokens_per_milestone, tokens_per_accepted_change, cache_hit_rate]
 *   reads: [events, findings, outcomes]
 *   may_change: [rules]
 *   notify:
 *     rules: [token-budget, cache-thrash]
 *     max_per_hour: 2
 *   cue: { icon: coin, color: amber, mood: frugal }
 *   ---
 *   You watch what this project spends on tokens ...
 *
 * Purser, Navigator, Bosun and Lookout are built in; a persona.md with front
 * matter in ~/.snagboat/advisors/<id>/ replaces the built-in of that id, or
 * adds an advisor. They need no model: their measures and notification limits
 * work without one. A model advisor (snagboat.advisors) with the same id uses
 * the body as its voice (prompts.ts drops the front matter before sending).
 * Each advisor is versioned by a hash of its persona.md, so an experiment can
 * name the version it ran with.
 */

export interface AdvisorGoal {
  id: string;
  name: string;
  /** What it works toward, e.g. token-cost-down. */
  goal: string;
  /** Measure ids (measures.ts), in the order to show them. */
  measures: string[];
  reads: string[];
  /** What it may propose changing; it never edits code. */
  mayChange: string[];
  /** Notifications: which heuristics or rules it speaks for, and at most how many an hour. */
  notify: { rules: string[]; maxPerHour?: number };
  cue?: { icon?: string; color?: string; mood?: string };
  /** Bosun: extra risky-command patterns (regular expressions), on top of the built-in ones. */
  riskyCommands: string[];
  /** The body: who it is and its tone. */
  voice: string;
  /** Built in, or the persona.md it came from. */
  source: string;
  /** sha256 of its persona.md text, the first 12 hex digits. */
  version: string;
}

type Value = string | number | boolean | Value[] | { [key: string]: Value };

/** "[a, b]" -> list, "{ k: v }" -> map, numbers and booleans, else the string (quotes removed). */
function scalar(text: string): Value {
  const t = text.trim();
  if (t.startsWith('[') && t.endsWith(']')) return splitTop(t.slice(1, -1)).filter((x) => x.trim()).map(scalar);
  if (t.startsWith('{') && t.endsWith('}')) {
    const out: Record<string, Value> = {};
    for (const part of splitTop(t.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
    }
    return out;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  return t.replace(/^(['"])(.*)\1$/, '$2');
}

/** Splits on commas outside brackets and quotes. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * The front matter between the first two `---` lines: `key: value` lines, with
 * one level of indented keys under a key with no value. A small YAML subset,
 * enough for persona.md; anything else is reported.
 */
export function parseFrontMatter(text: string): { data?: Record<string, Value>; body: string; problems: string[] } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text, problems: [] };
  const data: Record<string, Value> = {};
  const problems: string[] = [];
  let parent: Record<string, Value> | undefined;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      problems.push(`front matter line not understood: ${raw.trim()}`);
      continue;
    }
    const [, indent, key, value] = kv;
    if (indent && parent) {
      parent[key] = scalar(value);
    } else if (!value.trim()) {
      parent = {};
      data[key] = parent;
    } else {
      parent = undefined;
      data[key] = scalar(value);
    }
  }
  return { data, body: text.slice(m[0].length), problems };
}

const strings = (v: Value | undefined): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

/** An advisor from persona.md text; undefined (with problems) when it has no usable front matter. */
export function parseAdvisor(text: string, source: string, fallbackId?: string): { advisor?: AdvisorGoal; problems: string[] } {
  const { data, body, problems } = parseFrontMatter(text);
  if (!data) return { problems };
  const id = typeof data.id === 'string' && data.id ? data.id : fallbackId;
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) return { problems: [...problems, `${source}: "id" must be lower-case letters, digits and dashes`] };
  if (typeof data.goal !== 'string' || !data.goal) return { problems: [...problems, `${source}: no "goal"`] };
  const notify = (typeof data.notify === 'object' && !Array.isArray(data.notify) ? data.notify : {}) as Record<string, Value>;
  const cue = typeof data.cue === 'object' && !Array.isArray(data.cue) ? (data.cue as Record<string, Value>) : undefined;
  const maxPerHour = typeof notify.max_per_hour === 'number' && notify.max_per_hour >= 0 ? notify.max_per_hour : undefined;
  return {
    problems,
    advisor: {
      id,
      name: typeof data.name === 'string' && data.name ? data.name : id[0].toUpperCase() + id.slice(1),
      goal: data.goal,
      measures: strings(data.measures),
      reads: strings(data.reads),
      mayChange: strings(data.may_change),
      notify: { rules: strings(notify.rules), ...(maxPerHour !== undefined ? { maxPerHour } : {}) },
      ...(cue ? { cue: { icon: cue.icon === undefined ? undefined : String(cue.icon), color: cue.color === undefined ? undefined : String(cue.color), mood: cue.mood === undefined ? undefined : String(cue.mood) } } : {}),
      riskyCommands: strings(data.risky_commands),
      voice: body.replace(/<!--[\s\S]*?-->/g, '').trim(),
      source,
      version: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
    },
  };
}

/** The four built-in advisors' persona.md files. */
export const DEFAULT_PERSONAS: Record<string, string> = {
  purser: `---
id: purser
name: Purser
goal: token-cost-down
measures: [tokens_per_milestone, tokens_per_accepted_change, cache_hit_rate]
reads: [events, findings, outcomes]
may_change: [rules]
notify:
  rules: [token-budget, cache-thrash, context-pressure]
  max_per_hour: 2
cue: { icon: coin, color: amber, mood: frugal }
---
You watch what this project spends on tokens, and whether it buys finished work. You notice repeated reads of the same files, caches that keep missing, and long sessions that end without a commit, and you say plainly what each cost and what would have been cheaper. Be blunt and specific: name turns and token counts.
`,
  navigator: `---
id: navigator
name: Navigator
goal: clock-time-not-wasted
measures: [milestones_per_session, minutes_per_milestone, minutes_to_green, stall_minutes]
reads: [events, findings, outcomes]
may_change: [rules]
notify:
  rules: [stalled, runaway-turn, backtracking]
  max_per_hour: 3
cue: { icon: compass, color: blue, mood: steady }
---
You watch where the clock goes: how long work takes to reach a passing test and a commit, where an agent stalls or circles back, and what the human waits on. You say which turns cost the most time and what would have shortened them. Name the turn and the minutes.
`,
  bosun: `---
id: bosun
name: Bosun
goal: unsafe-tool-use-limited
measures: [risky_commands, risky_commands_per_session, approvals_per_session]
reads: [events, findings]
may_change: [rules]
notify:
  rules: [tool-churn]
  max_per_hour: 2
cue: { icon: anchor, color: red, mood: careful }
---
You watch what the agents do to the machine and the repository: destructive deletes, force pushes, hard resets, piping downloads into a shell, running as root, publishing. You say which command did it, in which session, and what a safer form would have been. Never alarmist; precise.
`,
  lookout: `---
id: lookout
name: Lookout
goal: user-not-overly-distracted
measures: [notifications_per_hour, dismiss_rate, useful_share]
reads: [findings, outcomes]
may_change: [rules]
notify:
  rules: []
  max_per_hour: 0
cue: { icon: telescope, color: teal, mood: quiet }
---
You watch Snagboat itself: how often it interrupts, and whether the interruptions help. You say which findings get muted or ignored and which get marked useful, and you propose raising thresholds or quieting rules that nobody acts on. You never add a notification of your own.
`,
};

/**
 * Every advisor: the built-ins, each replaced by ~/.snagboat/advisors/<id>/persona.md
 * when that file has front matter, plus any other folder there whose persona.md does.
 * A persona.md without front matter only gives a model advisor its voice.
 */
export function loadAdvisorGoals(advisorsDir: string, read: (file: string) => string | undefined = readIfExists): { advisors: AdvisorGoal[]; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map<string, AdvisorGoal>();
  for (const [id, text] of Object.entries(DEFAULT_PERSONAS)) {
    const { advisor } = parseAdvisor(text, 'built-in', id);
    if (advisor) byId.set(id, advisor);
  }
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(advisorsDir).filter((d) => !d.startsWith('.'));
  } catch {
    // no advisors folder
  }
  for (const dir of dirs.sort()) {
    const file = path.join(advisorsDir, dir, 'persona.md');
    const text = read(file);
    if (text === undefined) continue;
    const parsed = parseAdvisor(text, file, dir);
    problems.push(...parsed.problems.map((p) => (p.startsWith(file) ? p : `${file}: ${p}`)));
    if (parsed.advisor) byId.set(parsed.advisor.id, parsed.advisor);
  }
  const order = Object.keys(DEFAULT_PERSONAS);
  const advisors = [...byId.values()].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
  return { advisors, problems };
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
