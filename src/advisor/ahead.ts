import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Navigator's "Ahead" line (RFC step 5a, the design pass): the work still to
 * do, read from the workspace's Beads issues when it has a .beads folder and
 * `bd` is installed. Read only: every command runs with --readonly (writes
 * blocked) and --sandbox (no Dolt auto-push), and Navigator never closes or
 * edits a bead. Without Beads the line is left out; the session's plan or todo
 * list as a fallback comes later (snagboat-79f.6 follow-up).
 */

export interface Bead {
  id: string;
  title: string;
}

export interface Ahead {
  source: 'beads';
  /** Issues being worked on now. */
  inProgress: Bead[];
  /** The next ready issue (not an epic), highest priority first. */
  next?: Bead;
  /** Issues waiting on others, and what the first waits on. */
  blocked: number;
  firstBlocked?: Bead & { blockedBy: string[] };
  /** Issues closed in the last 7 days: the pace. */
  closedThisWeek: number;
}

export type BdRunner = (args: string[], cwd: string) => Promise<string>;

export const runBd: BdRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('bd', ['--readonly', '--sandbox', ...args], { cwd, timeout: 8_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

interface Issue {
  id: string;
  title: string;
  issue_type?: string;
  priority?: number;
  closed_at?: string;
  blocked_by?: string[];
}

const parse = (text: string): Issue[] => {
  const v = JSON.parse(text) as unknown;
  return Array.isArray(v) ? (v as Issue[]) : [];
};
const bead = (i: Issue): Bead => ({ id: i.id, title: i.title });

/** What's ahead in this folder's Beads, or undefined when it has none (or bd isn't installed, or fails). */
export async function beadsAhead(folder: string, now = Date.now(), bd: BdRunner = runBd): Promise<Ahead | undefined> {
  if (!fs.existsSync(path.join(folder, '.beads'))) return undefined;
  try {
    const [ready, blocked, inProgress, closed] = await Promise.all([
      bd(['ready', '--json'], folder).then(parse),
      bd(['blocked', '--json'], folder).then(parse),
      bd(['list', '--status=in_progress', '--json'], folder).then(parse),
      bd(['list', '--status=closed', '--json'], folder).then(parse),
    ]);
    const tasks = ready.filter((i) => i.issue_type !== 'epic').sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
    const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
    return {
      source: 'beads',
      inProgress: inProgress.filter((i) => i.issue_type !== 'epic').slice(0, 3).map(bead),
      ...(tasks[0] ? { next: bead(tasks[0]) } : {}),
      blocked: blocked.length,
      ...(blocked[0] ? { firstBlocked: { ...bead(blocked[0]), blockedBy: blocked[0].blocked_by ?? [] } } : {}),
      closedThisWeek: closed.filter((i) => (i.closed_at ?? '') >= weekAgo).length,
    };
  } catch {
    return undefined;
  }
}
