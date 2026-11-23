import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The export's keys (docs/design/export.md, rule 1). Re-keyed SHAs, pseudonyms and re-keyed ids
 * are all one keyed hash (HMAC-SHA256), with a key chosen by the repository's privacy:
 * - private (the default): the repository's key, ~/.snagboat/export-keys/<sha256 of its first
 *   commit's SHA>.key, so every clone finds the same file name and a teammate given the file
 *   gets exports that join with yours;
 * - public (export.public): this machine's key, ~/.snagboat/export.key.
 *
 * The sanitizer takes the key's bytes, so it never touches the disk; the command calls
 * ensureExportKey to find or make the file. Deleting a key starts fresh pseudonyms and SHAs.
 */

export type RepositoryPrivacy = 'private' | 'public';

/** Bytes in a key the export makes. */
export const EXPORT_KEY_BYTES = 32;

/** Where the key for a repository lives, under the Snagboat home folder (~/.snagboat). */
export function exportKeyPath(snagboatHome: string, privacy: RepositoryPrivacy, firstCommitSha?: string): string {
  if (privacy === 'public') return path.join(snagboatHome, 'export.key');
  if (!firstCommitSha || !/^[0-9a-f]{40}$/i.test(firstCommitSha)) {
    throw new Error("A private repository's export key is named by its first commit, and none was given.");
  }
  const name = crypto.createHash('sha256').update(firstCommitSha.toLowerCase()).digest('hex');
  return path.join(snagboatHome, 'export-keys', `${name}.key`);
}

/** Reads a key file: 64 hex characters (what ensureExportKey writes), else its raw bytes. */
export function readExportKey(file: string): Buffer {
  const content = fs.readFileSync(file);
  const text = content.toString('utf8').trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (content.length < 16) throw new Error(`The export key ${file} is too short to use.`);
  return content;
}

/**
 * The key at file, made on first use: 32 random bytes as hex, owner-only (0600, its folder 0700).
 * Two exports racing to make it both end up reading the one that won.
 */
export function ensureExportKey(file: string): Buffer {
  try {
    return readExportKey(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(EXPORT_KEY_BYTES);
  try {
    fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return readExportKey(file);
  }
  return key;
}

/** The keyed hash every re-keyed value uses: HMAC-SHA256 over a domain and the value, as hex. */
export function keyedHash(key: Uint8Array, domain: string, value: string): string {
  return crypto.createHmac('sha256', key).update(`${domain}\0${value}`).digest('hex');
}
