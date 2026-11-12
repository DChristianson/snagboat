import * as fs from 'fs';
import * as path from 'path';

/**
 * Which advisors you approved, and for which address and sending rules (advisors.ts approvalKey):
 * before an advisor's first request, you see the exact payload and approve it. Kept in
 * <snagboat home>/advisor-approvals.json so the advisor UI (through the core, RFC step 5c-2b) and a
 * VS Code window with the per-user store on share one record.
 */

const FILE = 'advisor-approvals.json';

export function readApprovals(home: string): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, FILE), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

export function writeApprovals(home: string, approvals: Record<string, string>): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(approvals, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
