import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WORKSPACE_NO_FOLDER } from '@snagboat/schema';

/**
 * The per-user store (docs/design/handoff-3c.md, step 3c-1): one place for every
 * workspace's data, instead of each VS Code window's own storage.
 *
 * Layout under snagboatHome() (default ~/.snagboat):
 *   rules.json                         saved rules (was VS Code global storage)
 *   data/context-limits.json           (was VS Code global storage)
 *   data/advisor-audit.jsonl           (was VS Code global storage)
 *   data/copilot-structure/            (was VS Code global storage)
 *   data/workspaces/<key>/             one workspace's store, as a window's storage was:
 *     workspace.json                   { workspace, folder?, workspaceFile? }
 *     events/<day>.jsonl, aggregates/, checkpoints/, finding-responses.jsonl
 *   data/migrated/<source key>.json    one marker per migrated VS Code store
 *
 * Until the core service (step 3c-2) is the single writer, each workspace keeps
 * its own folder, so each window is still the only writer of its files.
 */

export function snagboatHome(): string {
  return process.env.SNAGBOAT_HOME ?? path.join(os.homedir(), '.snagboat');
}

export function userDataDir(home: string): string {
  return path.join(home, 'data');
}

/** Who a store belongs to. `workspace` is the identity; the rest is for people reading workspace.json. */
export interface WorkspaceInfo {
  workspace: string;
  folder?: string;
  workspaceFile?: string;
}

/**
 * VS Code reports a Windows drive letter in lower case (c:\), Node's
 * fileURLToPath in upper case (C:\). Lower-cased, the extension and the CLI
 * name the same workspace the same way.
 */
function normalize(p: string): string {
  return /^[A-Z]:[\\/]/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

/**
 * What a VS Code workspaceStorage/<hash>/workspace.json names, as paths the way
 * Node spells them (see workspaceOfVsCodeStore for the identity): a folder, a
 * .code-workspace file, or (for a remote window) a URI that isn't a local path.
 */
export function readWorkspaceJson(file: string): { folder?: string; workspaceFile?: string; uri?: string } {
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
    const folder = toPath(json.folder);
    const workspaceFile = toPath(json.workspace);
    const raw = json.workspace ?? json.folder;
    return { folder, workspaceFile, uri: !folder && !workspaceFile && raw ? raw : undefined };
  } catch {
    return {};
  }
}

/**
 * The workspace a VS Code storage folder belongs to: its .code-workspace file,
 * else its folder, else its non-local URI; a window with no folder (global
 * storage) is WORKSPACE_NO_FOLDER. undefined when workspace.json can't be read.
 * Paths are spelled as VS Code spells them (a lower-case drive letter), so the
 * extension and the CLI name a workspace the same way.
 */
export function workspaceOfVsCodeStore(storeDir: string, global: boolean): WorkspaceInfo | undefined {
  if (global) return { workspace: WORKSPACE_NO_FOLDER };
  const json = readWorkspaceJson(path.join(path.dirname(storeDir), 'workspace.json'));
  const folder = json.folder && normalize(json.folder);
  const workspaceFile = json.workspaceFile && normalize(json.workspaceFile);
  const workspace = workspaceFile ?? folder ?? json.uri;
  return workspace ? { workspace, folder, workspaceFile } : undefined;
}

/** A workspace's folder name under data/workspaces: readable, and unique by a hash of the identity. */
export function workspaceKey(workspace: string): string {
  if (workspace === WORKSPACE_NO_FOLDER) return 'no-folder';
  const base = (workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').replace(/\.code-workspace$/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  const hash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 12);
  return `${base || 'workspace'}-${hash}`;
}

export function workspaceStoreDir(home: string, workspace: string): string {
  return path.join(userDataDir(home), 'workspaces', workspaceKey(workspace));
}

/** Creates the workspace's store folder and its workspace.json if missing; returns the folder. */
export async function openWorkspaceStore(home: string, info: WorkspaceInfo): Promise<string> {
  const dir = workspaceStoreDir(home, info.workspace);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'workspace.json');
  if (!fs.existsSync(file)) {
    const temp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(info, null, 2) + '\n', 'utf8');
    await fs.promises.rename(temp, file);
  }
  return dir;
}

export interface UserStore extends WorkspaceInfo {
  dir: string;
}

/** Every workspace store under data/workspaces that has a workspace.json. */
export function listUserStores(home: string): UserStore[] {
  const root = path.join(userDataDir(home), 'workspaces');
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return [];
  }
  const stores: UserStore[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')) as WorkspaceInfo;
      if (typeof info.workspace === 'string') stores.push({ dir, workspace: info.workspace, folder: info.folder, workspaceFile: info.workspaceFile });
    } catch {
      // not a store
    }
  }
  return stores;
}
