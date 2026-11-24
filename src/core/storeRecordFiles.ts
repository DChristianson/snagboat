import * as fs from 'fs';
import * as path from 'path';
import { foldStoreRecords, StoreRecord, storeRecordKey } from '@snagboat/schema';

/**
 * Reading, appending to and pruning the store's record files (git.jsonl, and later plan.jsonl,
 * links.jsonl and findings.jsonl: packages/schema/src/storeRecords.ts). The files are append
 * only: a job appends a record again when it changes, and the latest line with a key is the
 * record. Only retention and Remove Captured Text rewrite a file, through a temporary file and a
 * rename.
 */

/** Every record in a store file, in order; a torn line (a crash mid-append) is skipped. Missing file: []. */
export function readStoreRecordLines<T extends StoreRecord = StoreRecord>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as T;
      if (r && typeof r === 'object' && typeof r.record === 'string') out.push(r);
    } catch {
      // torn line
    }
  }
  return out;
}

/** A store file's current records by key (storeRecordKey). */
export function foldStoreFile<T extends StoreRecord = StoreRecord>(file: string): Map<string, T> {
  return new Map(foldStoreRecords(readStoreRecordLines<T>(file)).map((r) => [storeRecordKey(r), r]));
}

/**
 * Appends records as whole lines in one write. A file whose last line was torn gets a newline
 * first, so the torn line stays one bad line and the new ones parse.
 */
export async function appendStoreRecords(file: string, records: StoreRecord[]): Promise<void> {
  if (records.length === 0) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
    } finally {
      await handle.close();
    }
  } catch {
    // no file yet
  }
  await fs.promises.appendFile(file, prefix + records.map((r) => JSON.stringify(r) + '\n').join(''), { encoding: 'utf8', mode: 0o600 });
}

/**
 * When a record happened, for retention: a commit's commit time, a checkout's time, a deleted
 * branch's deletion, a plan item's closing, a transition's time, a link's `at`, a finding's lastTs. undefined keeps it: a branch
 * that still exists, a plan item still open, or a record type this doesn't know.
 */
export function storeRecordTime(r: StoreRecord): string | undefined {
  switch (r.record) {
    case 'commit':
      return r.committedAt;
    case 'checkout':
      return r.at;
    case 'branch':
      return r.deletedAt;
    case 'item':
      return r.closed;
    case 'transition':
      return r.at;
    case 'link':
      return r.at;
    case 'finding':
      return r.lastTs;
    default:
      return undefined;
  }
}

/**
 * Drops every line of each record whose time (storeRecordTime, of its latest line) is before
 * `cutoff` (ISO 8601), rewriting the file through a temporary file. Returns how many records went.
 */
export async function pruneStoreFile(file: string, cutoff: string): Promise<number> {
  const lines = readStoreRecordLines(file);
  if (lines.length === 0) return 0;
  const expired = new Set<string>();
  for (const [key, r] of foldStoreRecords(lines).map((r) => [storeRecordKey(r), r] as const)) {
    const at = storeRecordTime(r);
    if (at !== undefined && at < cutoff) expired.add(key);
  }
  if (expired.size === 0) return 0;
  await rewriteStoreFile(file, lines.filter((r) => !expired.has(storeRecordKey(r))));
  return expired.size;
}

/** Whether a record carries captured text: a commit's body, a plan item's text. */
export function hasStoreText(r: StoreRecord): boolean {
  return (r.record === 'commit' && r.body !== undefined) || (r.record === 'item' && r.text !== undefined);
}

/** A record without its captured text (a commit's body, a plan item's text); everything else stays, the subject and title included. */
export function withoutStoreText<T extends StoreRecord>(r: T): T {
  if (r.record === 'commit' && r.body !== undefined) {
    const { body: _body, ...rest } = r;
    return rest as T;
  }
  if (r.record === 'item' && r.text !== undefined) {
    const { text: _text, ...rest } = r;
    return rest as T;
  }
  return r;
}

/**
 * Drops every line of the records with these keys (storeRecordKey), rewriting the file through a
 * temporary file. Returns how many lines went.
 */
export async function removeStoreRecords(file: string, keys: ReadonlySet<string>): Promise<number> {
  const lines = readStoreRecordLines(file);
  const kept = lines.filter((r) => !keys.has(storeRecordKey(r)));
  if (kept.length === lines.length) return 0;
  await rewriteStoreFile(file, kept);
  return lines.length - kept.length;
}

/**
 * Whether a job should append `wanted` over the stored `have`: not when they're the same, nor
 * when the only difference is text the stored copy lost (to Remove Captured Text): a record that
 * hasn't changed doesn't get its text back, and one that changes is stored whole again.
 */
export function storeRecordChanged(have: StoreRecord | undefined, wanted: StoreRecord): boolean {
  if (!have) return true;
  const stored = JSON.stringify(have);
  if (stored === JSON.stringify(wanted)) return false;
  return hasStoreText(have) || !hasStoreText(wanted) || stored !== JSON.stringify(withoutStoreText(wanted));
}

/** The time text retention goes by: a commit's commit time, a plan item's last update. */
function textTime(r: StoreRecord): string | undefined {
  return r.record === 'commit' ? r.committedAt : r.record === 'item' ? r.updated : undefined;
}

/** Replaces a store file's lines with `lines` through a temporary file and a rename, so a reader never sees half of it. */
async function rewriteStoreFile(file: string, lines: StoreRecord[]): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, lines.map((r) => JSON.stringify(r) + '\n').join(''), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temp, file);
}

/**
 * Removes captured text (withoutStoreText) from every line of a store file that `strip` picks,
 * rewriting the file only when one had text. Returns how many lines lost their text.
 */
async function stripLines(file: string, strip: (r: StoreRecord) => boolean): Promise<number> {
  const lines = readStoreRecordLines(file);
  let stripped = 0;
  const kept = lines.map((r) => {
    if (!hasStoreText(r) || !strip(r)) return r;
    stripped++;
    return withoutStoreText(r);
  });
  if (stripped > 0) await rewriteStoreFile(file, kept);
  return stripped;
}

/**
 * Text retention (retention.textDays) for a store file: removes a commit's body from every line
 * committed before `cutoff` (ISO 8601), and a plan item's text from every line updated before it.
 * The records, their subjects and titles stay. Returns how many lines lost their text.
 */
export function stripStoreText(file: string, cutoff: string): Promise<number> {
  return stripLines(file, (r) => {
    const at = textTime(r);
    return at !== undefined && at < cutoff;
  });
}

/** Snagboat: Remove Captured Text for a store file: every commit body and plan item text, from every line. Returns how many lines lost their text. */
export function removeStoreText(file: string): Promise<number> {
  return stripLines(file, () => true);
}
