import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKSPACE_NO_FOLDER } from '@snagboat/schema';
import { listUserStores, readWorkspaceJson } from '../core/userStore';

/**
 * Finds the event stores the VS Code extension writes, so the CLI can read
 * them without VS Code running (docs/design/architecture-rfc.md, step 3).
 *
 * Each VS Code window keeps its log in its workspace storage, unless
 * snagboat.storage.perUserStore is on (then see findUserStores): <user dir>/workspaceStorage/<hash>/dchristianson.snagboat/events/,
 * with <hash>/workspace.json naming the folder or .code-workspace file. A window
 * with no folder open uses globalStorage/dchristianson.snagboat instead.
 *
 * The user dir is the desktop app's (~/.config/Code/User and the like) or, in a
 * dev container or over Remote-SSH, the VS Code server's (~/.vscode-server/data/User),
 * where the extension runs on the remote side. The server writes no
 * workspace.json, so its stores don't say which workspace they belong to.
 *
 * Read-only: nothing here writes to a store (core/migrate.ts copies them).
 */

export const EXTENSION_ID = 'dchristianson.snagboat';

/** VS Code and its forks that install VS Code extensions under the same layout. */
const APPS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];

/** Their remote servers' folders in the home folder (serverDataFolderName in each product.json), with the same layout under data/User. */
const SERVERS: Array<[app: string, folder: string]> = [
  ['Code', '.vscode-server'],
  ['Code - Insiders', '.vscode-server-insiders'],
  ['VSCodium', '.vscodium-server'],
  ['Cursor', '.cursor-server'],
  ['Windsurf', '.windsurf-server'],
];

export interface Store {
  /** vscode: a VS Code window's storage; user: a workspace's folder in the per-user store (~/.snagboat/data). */
  kind: 'vscode' | 'user';
  /** The folder holding events/. */
  dir: string;
  /** Which app wrote it, e.g. Code; snagboat for the per-user store. */
  app: string;
  /** The workspace folder, when the store belongs to one. */
  folder?: string;
  /** The .code-workspace file, for a multi-root window. */
  workspaceFile?: string;
  /** A remote window's workspace, which isn't a local path. */
  uri?: string;
  /** Per-user stores: the workspace their events are tagged with. */
  workspace?: string;
  /** True for the global store a window with no folder uses. */
  global: boolean;
}

/**
 * Where each app keeps its User folder on this platform, then each app's
 * remote server (labelled e.g. "Code (server)"). The server's folder is in the
 * home folder on every platform, Windows included (Remote-SSH to a Windows
 * host); VSCODE_AGENT_FOLDER moves VS Code's.
 */
export function userDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Array<{ app: string; dir: string }> {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
        : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const desktop = APPS.map((app) => ({ app, dir: path.join(base, app, 'User') }));
  const servers = SERVERS.map(([app, folder]) => ({
    app: `${app} (server)`,
    dir: path.join(app === 'Code' && env.VSCODE_AGENT_FOLDER ? env.VSCODE_AGENT_FOLDER : path.join(home, folder), 'data', 'User'),
  }));
  return [...desktop, ...servers];
}

const hasEvents = (dir: string) => fs.existsSync(path.join(dir, 'events'));

/**
 * Every store on this machine. SNAGBOAT_STORE points at one store directly
 * (a folder holding events/), for tests and for reading a copied store.
 */
export function findStores(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): Store[] {
  const env = opts.env ?? process.env;
  if (env.SNAGBOAT_STORE) {
    return hasEvents(env.SNAGBOAT_STORE) ? [{ kind: 'vscode', dir: env.SNAGBOAT_STORE, app: 'SNAGBOAT_STORE', global: false }] : [];
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
      stores.push({ kind: 'vscode', dir: storeDir, app, global: false, ...readWorkspaceJson(path.join(workspaces, hash, 'workspace.json')) });
    }
    const globalDir = path.join(dir, 'globalStorage', EXTENSION_ID);
    if (hasEvents(globalDir)) stores.push({ kind: 'vscode', dir: globalDir, app, global: true });
  }
  return stores;
}

/** Each app's global storage folder for Snagboat that exists, VS Code first: where rules.json and the other shared files are. */
export function findGlobalDirs(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string[] {
  return userDirs(opts.platform, opts.env ?? process.env, opts.home)
    .map(({ dir }) => path.join(dir, 'globalStorage', EXTENSION_ID))
    .filter((dir) => fs.existsSync(dir));
}

/** The per-user store's home: SNAGBOAT_HOME, else ~/.snagboat. */
export function userHome(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  return (opts.env ?? process.env).SNAGBOAT_HOME ?? path.join(opts.home ?? os.homedir(), '.snagboat');
}

/** Every workspace's store in the per-user store (~/.snagboat/data/workspaces). */
export function findUserStores(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): Store[] {
  return listUserStores(userHome(opts))
    .filter((s) => hasEvents(s.dir))
    .map((s) => ({ kind: 'user', dir: s.dir, app: 'snagboat', folder: s.folder, workspaceFile: s.workspaceFile, workspace: s.workspace, global: s.workspace === WORKSPACE_NO_FOLDER }));
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
