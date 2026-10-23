import * as fs from 'fs';
import * as path from 'path';

/** Whether dir is one of the folders or inside one. */
export function isWithinFolders(dir: string, folders: string[]): boolean {
  return folders.some((folder) => {
    const rel = path.relative(folder, dir);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * Each folder plus its resolved real path when different (on macOS /tmp and
 * /var are symlinks into /private), so a route is found and a payload's cwd
 * accepted whichever spelling Claude Code reports.
 */
export function withRealPaths(folders: string[]): string[] {
  const all = new Set<string>();
  for (const folder of folders) {
    all.add(folder);
    try {
      all.add(fs.realpathSync(folder));
    } catch {
      // folder missing; keep the path as given
    }
  }
  return [...all];
}
