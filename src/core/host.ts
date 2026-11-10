/**
 * What the engine needs from whatever runs it: VS Code today, the local core
 * service later (docs/design/architecture-rfc.md, step 2). The engine reads
 * settings and workspace folders through this interface instead of importing
 * `vscode`, so it can run outside the extension.
 *
 * The extension installs its implementation with `setHost` at activation. Until
 * then, and in unit tests, the default host has no settings (every read gets its
 * fallback) and no workspace folders.
 */
export interface HostDisposable {
  dispose(): void;
}

export interface Host {
  /** One settings section as a plain object of its values, e.g. `snagboat.heuristics.loop`. */
  section(section: string): Record<string, unknown>;
  /** One setting, `key` relative to `section` (dotted keys allowed); `scope` is a folder for per-folder settings. */
  get<T>(section: string, key: string, fallback: T, scope?: string): T;
  /** Absolute paths of the open workspace folders. */
  workspaceFolders(): string[];
  onWorkspaceFoldersChanged(listener: () => void): HostDisposable;
  /** Calls back when a setting, given by its full name, changes for any scope. */
  onSettingChanged(fullKey: string, listener: () => void): HostDisposable;
}

const noop: HostDisposable = { dispose: () => undefined };

const defaultHost: Host = {
  section: () => ({}),
  get: <T>(_section: string, _key: string, fallback: T) => fallback,
  workspaceFolders: () => [],
  onWorkspaceFoldersChanged: () => noop,
  onSettingChanged: () => noop,
};

let current: Host = defaultHost;

export function setHost(host: Host): void {
  current = host;
}

export function host(): Host {
  return current;
}
