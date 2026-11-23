import * as crypto from 'crypto';
import * as path from 'path';
import { FindingRecord } from '@snagboat/schema';
import { foldStoreFile } from './storeRecordFiles';

/**
 * findings.jsonl (docs/design/export.md, "Findings: findings.jsonl"): each finding episode as it
 * was shown, written by the core's findings service when the episode closes, and again under the
 * same id when a response to it lands later. Kept for retention.rawDays by lastTs.
 */

export const FINDINGS_FILE = 'findings.jsonl';

/** 'finding-' + 16 hex of SHA-256 of `${heuristicId}\n${sessionId ?? ''}\n${firstTs}` (storeRecords.ts). */
export function findingId(heuristicId: string, sessionId: string | undefined, firstTs: string): string {
  return `finding-${crypto.createHash('sha256').update(`${heuristicId}\n${sessionId ?? ''}\n${firstTs}`).digest('hex').slice(0, 16)}`;
}

/** A saved rule's version: 16 hex of SHA-256 of its definition's JSON (as parsed, so formatting doesn't count). */
export function ruleVersion(rule: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 16);
}

/** A workspace store's findings, by id: the latest line of each. */
export function readFindings(storeDir: string): Map<string, FindingRecord> {
  const out = new Map<string, FindingRecord>();
  for (const r of foldStoreFile<FindingRecord>(path.join(storeDir, FINDINGS_FILE)).values()) if (r.record === 'finding') out.set(r.id, r);
  return out;
}
