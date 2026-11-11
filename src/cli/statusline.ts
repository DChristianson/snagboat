/**
 * `snagboat statusline` (RFC step 5d): one line for Claude Code's status line, from the running core:
 * how many findings are showing in the workspace, today's tokens, cache rate and milestones. It never
 * starts the core (the status line runs often) and never fails: with no core, or no workspace recorded
 * for the folder, it says so in a few words.
 */

export interface Today {
  tokens: number;
  cacheRate?: number;
  milestones: number;
  findings: number;
  warnings: number;
}

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function statusLine(today: Today | 'no-core' | 'no-workspace'): string {
  if (today === 'no-core') return 'Snagboat: core not running';
  if (today === 'no-workspace') return 'Snagboat: not recording this folder';
  const parts: string[] = [];
  if (today.findings > 0) parts.push(`⚑ ${today.findings} finding${today.findings === 1 ? '' : 's'}${today.warnings > 0 ? ` (${today.warnings} warn)` : ''}`);
  parts.push(`${compact(today.tokens)} tok today`);
  if (today.cacheRate !== undefined) parts.push(`${Math.round(today.cacheRate)}% cache`);
  if (today.milestones > 0) parts.push(`${today.milestones} milestone${today.milestones === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The folder Claude Code is in, from the status line's JSON on stdin (workspace.current_dir, else cwd). */
export function statusLineDir(stdin: string): string | undefined {
  try {
    const v = JSON.parse(stdin) as { cwd?: unknown; workspace?: { current_dir?: unknown } };
    const dir = v.workspace?.current_dir ?? v.cwd;
    return typeof dir === 'string' && dir ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Reads stdin to its end, or gives up after timeoutMs (a terminal with nothing piped in). */
export function readStdin(timeoutMs = 500): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => (text += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
