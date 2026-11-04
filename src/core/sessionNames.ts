import * as crypto from 'crypto';

/** Same session and name, same id: a name repeated (Claude Code repeats titles; a restart re-reads them) is dropped as already logged. */
export function sessionNameId(agent: string, sessionId: string, name: string): string {
  return `${agent}:session-name:${sessionId}:${crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}
