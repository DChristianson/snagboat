import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { normalizeHookPayload } from '../../adapters/claude-code/normalize';
import { isCopilotSession } from '../../adapters/copilot/cliSessions';
import { isWithinFolders, withRealPaths } from '../paths';
import { isProcessAlive } from '../processes';
import { userDataDir } from '../userStore';

/**
 * Claude Code hooks at the core (3c-2b). The hook script tries the VS Code
 * window that routes the project first, as before; with none, or one that
 * refuses it, it posts to the core through ~/.snagboat/core.route; and with no
 * core running, it leaves the payload in the hook spool, which the core reads
 * when it starts. Once windows stop collecting (3c-3) the script goes straight
 * to the core.
 *
 * The core records a hook only for a project inside a workspace it knows
 * (one with a folder in the per-user store, or one a client registered with a
 * token): it doesn't start recording projects that were never opened.
 */

export function hookSpoolDir(home: string): string {
  return path.join(userDataDir(home), 'spool', 'hooks');
}

/** The workspace folder that contains projectDir, the nearest when folders nest. */
export function workspaceForProject(projectDir: string, folders: string[]): string | undefined {
  const containing = folders.filter((f) => isWithinFolders(projectDir, withRealPaths([f])));
  return containing.sort((a, b) => b.length - a.length)[0];
}

/** The event a hook payload stands for; undefined if it maps to none, or its session is Copilot's (its own log covers it). */
export function hookEvent(payload: unknown, receivedAt?: string): NormalizedEvent | undefined {
  const event = normalizeHookPayload(payload, undefined, receivedAt);
  if (!event || isCopilotSession(event.sessionId)) return undefined;
  return event;
}

export type HookDelivery = (projectDir: string, payload: unknown, receivedAt: string) => Promise<void>;

/** Creates the spool folder (owner-only). Its existence is what tells the hook script a core will read what it leaves there. */
export function openHookSpool(home: string): void {
  fs.mkdirSync(hookSpoolDir(home), { recursive: true, mode: 0o700 });
}

/** Removes payload copies (~/.snagboat/.hook-in.<pid>) left by hook scripts that were killed mid-run. */
function removeLeftOverPayloads(home: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^\.hook-in\.(\d+)$/.exec(name);
    if (m && !isProcessAlive(Number(m[1]))) fs.rmSync(path.join(home, name), { force: true });
  }
}

/**
 * Reads the hook spool: each <epoch seconds>-<pid>.hook file holds the project
 * dir on its first line and the payload after it. Each is delivered, then
 * deleted (a malformed one is deleted unread). Files a script was still writing
 * (.<pid>.tmp) are left alone, unless their process is gone.
 */
export async function ingestHookSpool(home: string, deliver: HookDelivery): Promise<number> {
  removeLeftOverPayloads(home);
  const dir = hookSpoolDir(home);
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).sort();
  } catch {
    return 0;
  }
  let delivered = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const partial = /^\.(\d+)\.tmp$/.exec(name);
    if (partial) {
      if (!isProcessAlive(Number(partial[1]))) await fs.promises.rm(file, { force: true });
      continue;
    }
    const m = /^(\d+)-\d+\.hook$/.exec(name);
    if (!m) continue;
    let projectDir: string;
    let payload: unknown;
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      const newline = text.indexOf('\n');
      if (newline <= 0) throw new Error('no project dir');
      projectDir = text.slice(0, newline);
      payload = JSON.parse(text.slice(newline + 1));
    } catch {
      await fs.promises.rm(file, { force: true }); // malformed: nothing to deliver
      continue;
    }
    // A delivery that fails (the store can't be written) leaves the file for the next pass.
    await deliver(projectDir, payload, new Date(Number(m[1]) * 1000).toISOString());
    await fs.promises.rm(file, { force: true });
    delivered += 1;
  }
  return delivered;
}
