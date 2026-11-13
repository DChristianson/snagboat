import * as path from 'path';

/**
 * Where a file the extension found or wrote should be opened from.
 *
 * The extension runs on the host even in a remote (dev container) window
 * (extensionKind "ui"), so its paths name the host's disk. In a remote window
 * VS Code reads `file:` URIs from the remote side, though, so:
 *  - a file inside a workspace folder opens through that folder's own URI (a
 *    dev container mounts the project at the same path, so the path still
 *    names the same file);
 *  - any other file (~/.snagboat, the event log) opens from the host's disk.
 * In a local window everything is a plain `file:` URI.
 */
export type HostFileRef =
  | { kind: 'file' }
  | { kind: 'folder'; folder: number; relative: string[] }
  | { kind: 'host' };

export function hostFileRef(file: string, remote: boolean, folders: string[]): HostFileRef {
  if (!remote) return { kind: 'file' };
  for (let i = 0; i < folders.length; i++) {
    const rel = path.relative(folders[i], file);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return { kind: 'folder', folder: i, relative: rel === '' ? [] : rel.split(path.sep) };
    }
  }
  return { kind: 'host' };
}
