import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  ts: string;
  provider: string;
  baseUrl: string;
  model: string;
  capability: string;
  /** Request body size in bytes, and its SHA-256, so a kept payload can be matched to its entry. */
  bytes: number;
  sha256: string;
  outcome: 'ok' | 'error';
  /** The request body, only when snagboat.advisor.auditPayloads is on. */
  payload?: string;
}

/**
 * Every request to a hosted provider, one JSON line each, in global storage
 * (providers are shared by every workspace). Payloads are kept only if you
 * opt in, and entries go after the raw-event retention.
 */
export class AuditLog {
  readonly file: string;

  constructor(globalStorageDir: string) {
    this.file = path.join(globalStorageDir, 'advisor-audit.jsonl');
  }

  static entryFor(body: string, fields: Omit<AuditEntry, 'bytes' | 'sha256' | 'payload'>, keepPayload: boolean): AuditEntry {
    return { ...fields, bytes: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex'), ...(keepPayload ? { payload: body } : {}) };
  }

  async append(entry: AuditEntry): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.appendFile(this.file, `${JSON.stringify(entry)}\n`);
  }

  /** Drops entries older than `days`; rewrites only when something goes. */
  async prune(days: number, now: string): Promise<void> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const lines = text.split('\n').filter(Boolean);
    const kept = lines.filter((l) => {
      try {
        return (JSON.parse(l) as AuditEntry).ts >= cutoff;
      } catch {
        return false;
      }
    });
    if (kept.length === lines.length) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, kept.map((l) => `${l}\n`).join(''));
    await fs.promises.rename(tmp, this.file);
  }
}
