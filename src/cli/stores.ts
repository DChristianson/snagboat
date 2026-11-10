import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Finds the event stores the VS Code extension writes, so the CLI can read
 * them without VS Code running (docs/design/architecture-rfc.md, step 3).
 *
 * Until storage moves to ~/.snagboat/data, each VS Code window keeps its log in
 * its workspace storage: <user dir>/workspaceStorage/<hash>/dchristianson.snagboat/events/,
 * with <hash>/workspace.json naming the folder or .code-workspace file. A window
 * with no folder open uses globalStorage/dchristianson.snagboat instead.
 *
 * Read-only: nothing here writes to a store.
 */

export const EXTENSION_ID = 'dchristianson.snagboat';

/** VS Code and its forks that install VS Code extensions under the same layout. */
const APPS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];

export interface Store {
  /** The folder holding events/ (the extension's storage folder). */
  dir: string;
  /** Which app wrote it, e.g. Code. */
  app: string;
  /** The workspace folder, when the store belongs to one. */
  folder?: string;
  /** The .code-workspace file, for a multi-root window. */
  workspaceFile?: string;
  /** True for the global store a window with no folder uses. */
  global: boolean;
}

/** Where each app keeps its User folder on this platform. */
export function userDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Array<{ app: string; dir: string }> {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
        : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return APPS.map((app) => ({ app, dir: path.join(base, app, 'User') }));
}

function readWorkspaceJson(file: string): { folder?: string; workspaceFile?: string } {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { folder?: string; workspace?: string };
    const toPath = (uri?: string) => {
      if (!uri || !uri.startsWith('file:')) return undefined;
      try {
        return fileURLToPath(uri);
      } catch {
        return undefined;
      }
    };
    return { folder: toPath(json.folder), workspaceFile: toPath(json.workspace) };
  } catch {
    return {};
  }
}

const hasEvents = (dir: string) => fs.existsSync(path.join(dir, 'events'));

/**
 * Every store on this machine. SNAGBOAT_STORE points at one store directly
 * (a folder holding events/), for tests and for reading a copied store.
 */
export function findStores(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): Store[] {
  const env = opts.env ?? process.env;
  if (env.SNAGBOAT_STORE) {
    return hasEvents(env.SNAGBOAT_STORE) ? [{ dir: env.SNAGBOAT_STORE, app: 'SNAGBOAT_STORE', global: false }] : [];
  }
  const stores: Store[] = [];
  for (const { app, dir } of userDirs(opts.platform, env, opts.home)) {
    const workspaces = path.join(dir, 'workspaceStorage');
    let hashes: string[] = [];
    try {
      hashes = fs.readdirSync(workspaces);
    } catch {
      // app not installed
    }
    for (const hash of hashes) {
      const storeDir = path.join(workspaces, hash, EXTENSION_ID);
      if (!hasEvents(storeDir)) continue;
      stores.push({ dir: storeDir, app, global: false, ...readWorkspaceJson(path.join(workspaces, hash, 'workspace.json')) });
    }
    const globalDir = path.join(dir, 'globalStorage', EXTENSION_ID);
    if (hasEvents(globalDir)) stores.push({ dir: globalDir, app, global: true });
  }
  return stores;
}

/** Whether dir is folder or inside it (case-insensitive on Windows and macOS's default file system). */
export function isInside(dir: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  // The platform's own path rules, not the host's: win32's are case-insensitive by themselves.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x: string) => (platform === 'darwin' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const rel = p.relative(norm(folder), norm(dir));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * The stores a command may read. By default only the store for the workspace
 * that contains cwd, the nearest one when folders nest: a workspace's data
 * stays with that workspace (the RFC's per-workspace isolation). `all` is the
 * explicit cross-workspace scope.
 */
export function selectStores(stores: Store[], cwd: string, all: boolean): Store[] {
  if (all) return stores;
  const matching = stores.filter((s) => s.folder && isInside(cwd, s.folder));
  if (matching.length === 0) return [];
  const depth = (s: Store) => path.resolve(s.folder!).length;
  const nearest = Math.max(...matching.map(depth));
  return matching.filter((s) => depth(s) === nearest);
}
