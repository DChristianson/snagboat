import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewItem } from './engine';
import type { Decision } from './types';

/**
 * Decisions on values, kept per workspace in its folder of the store (docs/design/export.md,
 * "Decisions"), and the review file that asks for them. The caller passes the folder; nothing
 * here knows what an export is.
 *
 * - export-decisions.json: every decision, keyed by decisionId(rule, value), a hash, so the file
 *   never holds the values. A later run asks only about values not decided before.
 * - export-review.json: the values still to decide, with the values and snippets (so it's in
 *   the store, never in a project). The user sets each item's decision and runs again;
 *   foldReviewFile moves what they decided into the decisions.
 */

export const DECISIONS_FILE = 'export-decisions.json';
export const REVIEW_FILE = 'export-review.json';

/** A decision's key: a hash of the rule and the value, never the value. */
export function decisionId(rule: string, value: string): string {
  return crypto.createHash('sha256').update(`${rule}\0${value}`).digest('hex').slice(0, 32);
}

export interface DecisionsFile {
  version: 1;
  decisions: Record<string, { rule: string; decision: Decision; decidedAt: string }>;
}

export interface ReviewFile {
  version: 1;
  /** The project the export was for. */
  project: string;
  createdAt: string;
  help: string;
  items: ReviewItem[];
}

const isDecision = (d: unknown): d is Decision => d === 'rewrite' || d === 'keep';

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${file} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Writes a file owner-only, through a temporary file and a rename, so a reader never sees half of it. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The decisions kept in dir, by id. */
export function loadDecisions(dir: string): Map<string, Decision> {
  const raw = readJson(path.join(dir, DECISIONS_FILE)) as Partial<DecisionsFile> | undefined;
  const out = new Map<string, Decision>();
  for (const [id, d] of Object.entries(raw?.decisions ?? {})) if (d && isDecision(d.decision)) out.set(id, d.decision);
  return out;
}

/** Adds decisions to dir's file (a later one for the same id replaces it). */
export function saveDecisions(dir: string, add: Array<{ id: string; rule: string; decision: Decision }>, now: Date): void {
  if (add.length === 0) return;
  const file = path.join(dir, DECISIONS_FILE);
  const raw = (readJson(file) as Partial<DecisionsFile> | undefined) ?? {};
  const decisions: DecisionsFile['decisions'] = { ...(raw.decisions ?? {}) };
  for (const d of add) decisions[d.id] = { rule: d.rule, decision: d.decision, decidedAt: now.toISOString() };
  writeJson(file, { version: 1, decisions } satisfies DecisionsFile);
}

export const REVIEW_HELP =
  'Set each item\'s "decision" to "rewrite" or "keep", then run the export again. Decisions are kept (by a hash of the rule and value, never the value), so later exports ask only about new values. To decide a whole rule instead, use --rule <rule>=rewrite (or keep), or "export.rules" in ~/.snagboat/config.json; --rewrite-all rewrites everything found.';

/** Writes the review file for the pending items; returns its path. */
export function writeReviewFile(dir: string, project: string, items: ReviewItem[], now: Date): string {
  const file = path.join(dir, REVIEW_FILE);
  writeJson(file, { version: 1, project, createdAt: now.toISOString(), help: REVIEW_HELP, items: items.map((i) => ({ ...i, decision: null })) } satisfies ReviewFile);
  return file;
}

export function reviewFilePath(dir: string): string {
  return path.join(dir, REVIEW_FILE);
}

/**
 * Moves the decisions made in dir's review file into its decisions file. Items still null stay
 * undecided; a decision that's neither "rewrite" nor "keep" is a problem, and ignored. The review
 * file itself is left for the caller to rewrite or remove.
 */
export function foldReviewFile(dir: string, now: Date): { folded: number; problems: string[] } {
  const file = path.join(dir, REVIEW_FILE);
  let raw: Partial<ReviewFile> | undefined;
  try {
    raw = readJson(file) as Partial<ReviewFile> | undefined;
  } catch (err) {
    return { folded: 0, problems: [err instanceof Error ? err.message : String(err)] };
  }
  if (!raw) return { folded: 0, problems: [] };
  const problems: string[] = [];
  const add: Array<{ id: string; rule: string; decision: Decision }> = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!item || typeof item.id !== 'string' || typeof item.rule !== 'string') continue;
    const d: unknown = item.decision;
    if (d === null || d === undefined) continue;
    if (!isDecision(d)) {
      problems.push(`${file}: a ${item.rule} item's decision is ${JSON.stringify(d)}; it takes "rewrite" or "keep"`);
      continue;
    }
    add.push({ id: item.id, rule: item.rule, decision: d });
  }
  saveDecisions(dir, add, now);
  return { folded: add.length, problems };
}

export function removeReviewFile(dir: string): void {
  fs.rmSync(path.join(dir, REVIEW_FILE), { force: true });
}
