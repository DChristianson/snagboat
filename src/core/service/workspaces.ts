import * as fs from 'fs';
import * as path from 'path';
import { effectiveSettings, loadConfig } from '../config';
import { isWithinFolders, withRealPaths } from '../paths';
import { listUserStores, workspaceInfoOf } from '../userStore';

/**
 * Which workspace a project folder's activity belongs to, and whether the
 * core records it at all (3c-3b). The core collects every Claude Code project
 * on the machine (decided with Dave, bead snagboat-79f.3), so a project needn't
 * be open in VS Code:
 *
 *   1. the nearest known workspace folder containing it: one with a folder in
 *      the per-user store, one in config.json's "projects", or one a client
 *      registered with a token;
 *   2. otherwise the repository it's in (the nearest folder with .git);
 *   3. otherwise the folder itself.
 *
 * It's not recorded when its settings say "collect": false, or when it's in no
 * known workspace and config.json's defaults say "collect.unopened": false.
 */

/** Folders the core knows as workspaces, from the per-user store and config.json, plus `extra` (token workspaces). */
export function knownWorkspaceFolders(home: string, extra: string[] = []): string[] {
  const fromStores = listUserStores(home).map((s) => s.folder);
  const fromConfig = Object.keys(loadConfig(home).config.projects);
  const fromExtra = extra.map((w) => workspaceInfoOf(w).folder);
  return [...new Set([...fromStores, ...fromConfig, ...fromExtra].filter((f): f is string => !!f))];
}

function repositoryRoot(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface ProjectWorkspace {
  workspace: string;
  /** In a known workspace (step 1), not one inferred from the repository or folder. */
  known: boolean;
}

/**
 * The workspace a project folder belongs to (steps 1 to 3 above). aliases maps
 * a folder to the workspace it's part of when that isn't the folder itself: a
 * saved multi-root workspace (.code-workspace) whose window is a client.
 */
export function workspaceOfProject(projectDir: string, knownFolders: string[], aliases: Map<string, string> = new Map()): ProjectWorkspace {
  const containing = [...knownFolders, ...aliases.keys()].filter((f) => isWithinFolders(projectDir, withRealPaths([f])));
  const nearest = containing.sort((a, b) => b.length - a.length)[0];
  if (nearest) return { workspace: aliases.get(nearest) ?? nearest, known: true };
  return { workspace: repositoryRoot(projectDir) ?? path.resolve(projectDir), known: false };
}

/** The workspace to record a project's activity under, or undefined when its settings say not to record it. */
export function collectedWorkspace(home: string, projectDir: string, knownFolders: string[], aliases?: Map<string, string>): string | undefined {
  const { workspace, known } = workspaceOfProject(projectDir, knownFolders, aliases);
  const settings = effectiveSettings(home, projectDir).values;
  if (settings.collect === false) return undefined;
  if (!known && loadConfig(home).config.defaults['collect.unopened'] === false) return undefined;
  return workspace;
}
