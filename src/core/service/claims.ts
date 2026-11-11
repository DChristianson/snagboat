import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from '../processes';

/**
 * A VS Code window's claim on a workspace's folder in the per-user store
 * (docs/design/handoff-3c.md, 3c-2): while a window writes the folder itself
 * (snagboat.storage.perUserStore, until 3c-3 makes the extension a client of
 * the core), the core must not write there too, or one's retention and
 * rewrites could lose the other's events. The window writes writer.json with
 * its pid; the core spools events for a claimed workspace instead
 * (eventSpool.ts) and ingests them once the claim is gone. A claim whose
 * process has exited counts as gone.
 */

export const CLAIM_FILE = 'writer.json';

export interface Claim {
  pid: number;
  since: string;
}

function readClaim(storeDir: string): Claim | undefined {
  try {
    const claim = JSON.parse(fs.readFileSync(path.join(storeDir, CLAIM_FILE), 'utf8')) as Claim;
    return Number.isInteger(claim.pid) ? claim : undefined;
  } catch {
    return undefined;
  }
}

/** Claims the workspace's folder for this process (atomic write; a later window's claim replaces an earlier one). */
export function claimWorkspace(storeDir: string, pid = process.pid): void {
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, CLAIM_FILE);
  const temp = `${file}.${pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ pid, since: new Date().toISOString() } satisfies Claim) + '\n');
  fs.renameSync(temp, file);
}

/** Removes the claim if it's still this process's. Synchronous, so it completes during deactivate. */
export function releaseClaim(storeDir: string, pid = process.pid): void {
  if (readClaim(storeDir)?.pid === pid) fs.rmSync(path.join(storeDir, CLAIM_FILE), { force: true });
}

/** The pid of the live process that claims the folder, if any. */
export function claimedBy(storeDir: string): number | undefined {
  const claim = readClaim(storeDir);
  return claim && isProcessAlive(claim.pid) ? claim.pid : undefined;
}
