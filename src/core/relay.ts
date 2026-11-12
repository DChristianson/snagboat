import * as path from 'path';

/**
 * The relay folder (bead snagboat-xe5): how a Snagboat core inside a dev
 * container hands its events to the core on the host, through the
 * bind-mounted project folder. The container writes; the host reads, and only
 * for folders you allowed in ~/.snagboat/config.json ("relay": {"allow": [...]}).
 *
 *   <project root>/.snagboat/relay/
 *     .gitignore      "*": the folder ignores itself
 *     relay.json      RelayInfo: {"version": 1, "root": "<container path of the project root>", "host": "<container hostname>"}
 *     outbox/         <epoch ms>-<pid>-<seq>.jsonl, complete files only (written as .<name>.tmp, then renamed);
 *                     one NormalizedEvent (schema v3) per line, workspace the container-side path
 *     checkpoints/    the container core's own state; the host ignores it
 *
 * Both sides import this module; keep it free of anything but path.
 */

export const RELAY_VERSION = 1;
/** The relay folder's path inside the project root, one segment each. */
export const RELAY_SEGMENTS: readonly string[] = ['.snagboat', 'relay'];
export const RELAY_INFO_FILE = 'relay.json';
export const RELAY_GITIGNORE_FILE = '.gitignore';
export const RELAY_GITIGNORE = '*\n';
export const RELAY_OUTBOX_DIR = 'outbox';
export const RELAY_CHECKPOINTS_DIR = 'checkpoints';
/** The host ignores (and deletes) an outbox file larger than this; a writer should start a new file well before. */
export const RELAY_MAX_FILE_BYTES = 16 * 1024 * 1024;
/** The host skips a line longer than this. */
export const RELAY_MAX_LINE_BYTES = 1024 * 1024;
/** The longest relay.json the host reads. */
export const RELAY_MAX_INFO_BYTES = 64 * 1024;

export interface RelayInfo {
  version: 1;
  /** The project root as the container sees it (absolute, POSIX), e.g. /workspaces/snagboat. */
  root: string;
  /** The container's hostname, for people. */
  host: string;
}

/** <projectRoot>/.snagboat/relay */
export function relayDir(projectRoot: string): string {
  return path.join(projectRoot, ...RELAY_SEGMENTS);
}

export function relayInfoPath(projectRoot: string): string {
  return path.join(relayDir(projectRoot), RELAY_INFO_FILE);
}

export function relayOutboxDir(projectRoot: string): string {
  return path.join(relayDir(projectRoot), RELAY_OUTBOX_DIR);
}

export function relayCheckpointsDir(projectRoot: string): string {
  return path.join(relayDir(projectRoot), RELAY_CHECKPOINTS_DIR);
}

/** A complete outbox file's name: <epoch ms>-<pid>-<seq>.jsonl. */
export const OUTBOX_FILE_PATTERN = /^\d{1,16}-\d{1,10}-\d{1,10}\.jsonl$/;

export function outboxFileName(epochMs: number, pid: number, seq: number): string {
  return `${epochMs}-${pid}-${seq}.jsonl`;
}

/** What an outbox file is written as before it's renamed to `name`. */
export function outboxTempName(name: string): string {
  return `.${name}.tmp`;
}

export function isOutboxFileName(name: string): boolean {
  return OUTBOX_FILE_PATTERN.test(name);
}

/** relay.json's text for info. */
export function formatRelayInfo(info: RelayInfo): string {
  return JSON.stringify(info, null, 2) + '\n';
}

/** Reads relay.json's text; throws an Error saying what's wrong. root must be an absolute, normalized POSIX path. */
export function parseRelayInfo(text: string): RelayInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("it isn't valid JSON");
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("it isn't a JSON object");
  const o = raw as Record<string, unknown>;
  if (o.version !== RELAY_VERSION) throw new Error(`its version is ${JSON.stringify(o.version)}, not ${RELAY_VERSION}`);
  const root = o.root;
  if (typeof root !== 'string' || root.length > 4096 || !root.startsWith('/') || root.includes('\0')) throw new Error('its root is not an absolute path');
  const normalized = root.length > 1 ? path.posix.normalize(root).replace(/\/+$/, '') : root;
  if (normalized !== root) throw new Error('its root is not a normalized path (no trailing slash, "." or "..")');
  const host = o.host;
  if (typeof host !== 'string' || host.length > 255) throw new Error('its host is not a string');
  return { version: RELAY_VERSION, root, host };
}
