import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { normalizeHookPayload } from '../../adapters/claude-code/normalize';
import { isCopilotSession } from '../../adapters/copilot/cliSessions';
import { isProcessAlive } from '../processes';
import { userDataDir } from '../userStore';

/**
 * Claude Code hooks at the core (3c-2b). The hook script (hookRoutes.ts) posts
 * them to the core through ~/.snagboat/core.route; with no core running, it
 * leaves the payload in the hook spool, which the core reads when it starts.
 * VS Code windows receive no hooks: they only add the hook entries.
 *
 * The core records a hook under the workspace its project belongs to
 * (workspaces.ts): every project, unless its settings say not to.
 */

/**
 * The project dir the hook script sent. Header values arrive as raw bytes read
 * as latin1, so re-decode them as UTF-8 for non-ASCII paths. On Windows the
 * script sends it hex-encoded instead (X-Snagboat-Project-Dir-Hex): curl there
 * takes its arguments in the ANSI code page, which mangles non-ASCII
 * characters, while hex digits survive any encoding.
 */
export function projectDirHeader(value: string | string[] | undefined, hex: string | string[] | undefined): string | undefined {
  const hexRaw = Array.isArray(hex) ? hex[0] : hex;
  if (hexRaw !== undefined && /^([0-9a-f]{2})+$/i.test(hexRaw)) return Buffer.from(hexRaw, 'hex').toString('utf8');
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? undefined : Buffer.from(raw, 'latin1').toString('utf8');
}

export function hookSpoolDir(home: string): string {
  return path.join(userDataDir(home), 'spool', 'hooks');
}

/** The event a hook payload stands for; undefined if it maps to none, or its session is Copilot's (its own log covers it). */
/** captureContent: whether the project keeps captured text (a TodoWrite call's items, a task tool's subjects). */
export function hookEvent(payload: unknown, receivedAt?: string, captureContent = false): NormalizedEvent | undefined {
  const event = normalizeHookPayload(payload, undefined, receivedAt, captureContent);
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
