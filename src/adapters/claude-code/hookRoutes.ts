import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-window routing for Claude Code hooks. Every project's .claude/settings.json
 * runs one stable script (HOOK_SCRIPT); each VS Code window listens on its own
 * free port and publishes a route file per workspace folder, so the script can
 * deliver a hook to the window that owns the Claude Code project, with that
 * window's auth token. Mirrors the discovery-file pattern Claude Code's own IDE
 * integration uses (~/.claude/ide/<port>.lock).
 *
 * Layout under snagboatHome() (default ~/.snagboat):
 *   bin/snagboat-hook          the forwarder script (rewritten on every activation)
 *   routes/<folder key>        "<port> <token> <pid>\n" for one workspace folder
 */

// Shared with the per-user store; re-exported for the adapter's callers.
export { snagboatHome } from '../../core/userStore';

/**
 * Route file name for a folder. Must match the script's `tr '/\\:' '---'`:
 * separators and a Windows drive's colon (not allowed in file names) become dashes.
 */
export function routeKey(folder: string): string {
  return folder.replace(/[\\/:]/g, '-');
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface Route {
  port: number;
  token: string;
  pid: number;
}

function routesDir(home: string): string {
  return path.join(home, 'routes');
}

/** Atomic write (temp file + rename), so a concurrently running hook never reads half a file. */
function writeFileAtomic(file: string, contents: string, mode: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, file);
}

function readRoute(file: string): Route | undefined {
  try {
    const [port, token, pid] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
    const route = { port: Number(port), token, pid: Number(pid) };
    return Number.isInteger(route.port) && Number.isInteger(route.pid) && route.token ? route : undefined;
  } catch {
    return undefined;
  }
}

import { isProcessAlive } from '../../core/processes';
export { isProcessAlive };

/** Publishes this window as the hook destination for each of its workspace folders. Files are owner-only: they hold the token. */
export function writeRoutes(home: string, folders: string[], route: Route): void {
  fs.mkdirSync(routesDir(home), { recursive: true, mode: 0o700 });
  for (const folder of folders) {
    writeFileAtomic(path.join(routesDir(home), routeKey(folder)), `${route.port} ${route.token} ${route.pid}\n`, 0o600);
  }
}

/** Removes this window's routes, leaving any that another window has since claimed. Synchronous so it completes during deactivate. */
export function removeRoutes(home: string, folders: string[], pid: number): void {
  for (const folder of folders) {
    const file = path.join(routesDir(home), routeKey(folder));
    if (readRoute(file)?.pid === pid) fs.rmSync(file, { force: true });
  }
}

/**
 * Moves this window's routes from one set of workspace folders to another (a
 * folder added or removed while the window is open). Routes for folders no
 * longer open are removed if still this window's; folders kept are left
 * alone, so a route another window has since claimed isn't taken back.
 * Returns the folders newly routed.
 */
export function updateRoutes(home: string, before: string[], after: string[], route: Route): string[] {
  removeRoutes(home, before.filter((f) => !after.includes(f)), route.pid);
  const added = after.filter((f) => !before.includes(f));
  writeRoutes(home, added, route);
  return added;
}

/** Deletes route files left behind by windows that exited without deactivating (a crash, a force quit). */
export function pruneStaleRoutes(home: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(routesDir(home));
  } catch {
    return;
  }
  for (const name of files) {
    const file = path.join(routesDir(home), name);
    const route = readRoute(file);
    if (!route || !isProcessAlive(route.pid)) fs.rmSync(file, { force: true });
  }
}

/**
 * POSIX sh + curl rather than node: it runs before Claude Code continues after
 * every tool call, sh+curl starts in ~12ms versus ~60ms for node, and node
 * isn't reliably on PATH where hooks run. The same script serves Windows:
 * Claude Code runs hook commands through Git Bash there (it needs Git Bash to
 * start), which has sh, curl and cygpath. Under Git Bash (MSYSTEM set) the
 * project dir is converted to C:/x/y form for the walk, and the pid check is
 * skipped because kill there doesn't know Windows process ids; a dead
 * window's port just refuses the connection.
 *
 * Where a hook goes, in order (3c-2b):
 * 1. The window routing the project. Routes on CLAUDE_PROJECT_DIR, which
 *    Claude Code sets for hooks to the project root where the session started
 *    (unlike the payload's cwd, which follows Claude into other directories and
 *    worktrees), walking up to the nearest route so a session started in a
 *    subfolder still reaches the window for the enclosing workspace. Sends that
 *    project dir along so the receiver can confirm it's really one of its own:
 *    route names are ambiguous ('/w/x-y' and '/w/x/y' both map to '-w-x-y').
 * 2. If there's no such window, it's gone, or it refuses the hook: the core,
 *    through core.route (core/service/hooks.ts), which records it for the
 *    known workspace containing the project.
 * 3. If neither takes it: the hook spool, data/spool/hooks/<epoch>-<pid>.hook
 *    (project dir, then payload), which the core reads when it starts. Only
 *    if that folder exists, which the core creates: without a core, nothing
 *    would ever read the spool, so a hook is dropped as before.
 * The payload is saved first (owner-only, umask 077, ~/.snagboat/.hook-in.<pid>)
 * so it can be tried twice.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Snagboat Claude Code hook forwarder. Generated by Snagboat on every
# activation; local edits are overwritten.
# Sends the hook payload on stdin to the VS Code window whose workspace
# contains this Claude Code project; failing that, to the Snagboat core
# (core.route); failing that, if the core has ever run (it creates the spool
# folder), leaves it there for the core to read when it next starts. Always
# exits 0, so it can never block or fail a Claude Code session.
home="\${SNAGBOAT_HOME:-$HOME/.snagboat}"
routes="$home/routes"
spool="$home/data/spool/hooks"
project="\${CLAUDE_PROJECT_DIR:-$PWD}"
dir="$project"
umask 077
if [ -n "$MSYSTEM" ]; then
  # Git Bash started by Claude Code may have no locale; file names and the header need UTF-8.
  export LC_ALL=C.UTF-8
  command -v cygpath >/dev/null 2>&1 && dir=$(cygpath -m "$project")
  # curl.exe reads its arguments in the ANSI code page, so send the dir as hex.
  header="X-Snagboat-Project-Dir-Hex: $(printf '%s' "$project" | od -An -tx1 | tr -d ' \\n')"
else
  header="X-Snagboat-Project-Dir: $project"
fi
payload="$home/.hook-in.$$"
cat > "$payload" 2>/dev/null || { rm -f "$payload"; exit 0; }
data="$payload"
[ -n "$MSYSTEM" ] && command -v cygpath >/dev/null 2>&1 && data=$(cygpath -m "$payload")
# Posts the payload to the destination in a route file; succeeds only if it was accepted.
post() {
  read -r port token pid < "$1" || return 1
  [ -n "$pid" ] || return 1
  if [ -z "$MSYSTEM" ] && ! kill -0 "$pid" 2>/dev/null; then return 1; fi
  curl -s -f -m 2 -o /dev/null -X POST "http://127.0.0.1:$port/hook" \\
    -H "Content-Type: application/json" -H "Authorization: Bearer $token" \\
    -H "$header" --data-binary @"$data" >/dev/null 2>&1
}
delivered=
while [ -n "$dir" ]; do
  route="$routes/$(printf '%s' "$dir" | tr '/\\\\:' '---')"
  if [ -f "$route" ]; then
    post "$route" && delivered=1
    break
  fi
  [ "$dir" = "/" ] && break
  parent=$(dirname "$dir")
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done
[ -z "$delivered" ] && [ -f "$home/core.route" ] && post "$home/core.route" && delivered=1
if [ -z "$delivered" ] && [ -d "$spool" ]; then
  # Nobody took it: keep it for the core, the project dir on the first line.
  { printf '%s\\n' "$project"; cat "$payload"; } > "$spool/.$$.tmp" 2>/dev/null && mv "$spool/.$$.tmp" "$spool/$(date +%s)-$$.hook" 2>/dev/null
  rm -f "$spool/.$$.tmp"
fi
rm -f "$payload"
exit 0
`;

export function hookScriptPath(home: string): string {
  return path.join(home, 'bin', 'snagboat-hook');
}

export function installHookScript(home: string): string {
  const file = hookScriptPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, HOOK_SCRIPT, 0o755);
  return file;
}
