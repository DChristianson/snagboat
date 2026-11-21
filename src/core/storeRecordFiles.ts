import * as fs from 'fs';
import * as path from 'path';
import { foldStoreRecords, StoreRecord, storeRecordKey } from '@snagboat/schema';

/**
 * Reading, appending to and pruning the store's record files (git.jsonl, and later plan.jsonl,
 * links.jsonl and findings.jsonl: packages/schema/src/storeRecords.ts). The files are append
 * only: a job appends a record again when it changes, and the latest line with a key is the
 * record. Only retention rewrites a file, through a temporary file and a rename.
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
 * branch's deletion. undefined keeps it: a branch that still exists, or a record type this
 * doesn't know.
 */
export function storeRecordTime(r: StoreRecord): string | undefined {
  switch (r.record) {
    case 'commit':
      return r.committedAt;
    case 'checkout':
      return r.at;
    case 'branch':
      return r.deletedAt;
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
  const kept = lines.filter((r) => !expired.has(storeRecordKey(r)));
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, kept.map((r) => JSON.stringify(r) + '\n').join(''), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temp, file);
  return expired.size;
}
