import * as net from 'net';
import { SECRET_PATTERNS } from '../excerpt';

/**
 * The export's privacy rules (docs/design/export.md, "The privacy rules"): their names, as the
 * manifest's redactions and the review file name them, and the rule 2 detectors the sanitizer
 * and the final check share, so the check looks for exactly what the sanitizer removes.
 */

/** The rule set's version, for manifest.json's rulesVersion. Bump it when a rule changes what an export holds. */
export const RULES_VERSION = 3;

/** Rule 1: the machine and the workspace's place on it. */
export const MACHINE_RULES = ['path', 'user', 'host', 'person', 'sha', 'remote', 'url', 'id'] as const;
/** Rule 2: anything that looks like PII or a secret. */
export const PII_RULES = ['secret', 'public-key', 'connection-string', 'env', 'email', 'ip', 'mac', 'phone', 'card', 'deny'] as const;
/** Rule 4: what's flagged for review, replaced with [flagged-N]. */
export const FLAG_RULES = ['high-entropy', 'internal-url', 'name', 'mention', 'unresolved-path', 'unknown-sha', 'foreign-trace'] as const;

export type MachineRule = (typeof MACHINE_RULES)[number];
export type PiiRule = (typeof PII_RULES)[number];
export type FlagRule = (typeof FLAG_RULES)[number];
export type RuleName = MachineRule | PiiRule | FlagRule;

/**
 * The rules --allow-rule can override: every flag, and the rule 2 values that are sometimes
 * the point (an address in a networking project). Secrets, keys and denied words can't be.
 */
export const ALLOWABLE_RULES: readonly RuleName[] = [...FLAG_RULES, 'email', 'ip', 'mac', 'phone', 'card'];

export { SECRET_PATTERNS };

// ---- rule 2 detectors -----------------------------------------------------------------------

/** SSH and PGP public key blocks, and authorized_keys / .pub lines (with their user@host comment). */
export const PUBLIC_KEY_PATTERNS: RegExp[] = [
  /-----BEGIN (?:SSH2 |PGP |RSA )?PUBLIC KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:SSH2 |PGP |RSA )?PUBLIC KEY(?: BLOCK)?-----|$)/g,
  /\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)[ \t]+AAAA[A-Za-z0-9+/]+={0,3}(?:[ \t]+[^\s"'`]+)?/g,
];

/** Semicolon connection strings' passwords: Server=db;User Id=sa;Password=...; group 1 is kept. */
export const CONNECTION_PASSWORD = /((?:^|[;"'\s])(?:password|pwd)\s*=\s*)(?!\[redacted)([^;"'\r\n]+)/gi;

/** .env-style NAME=value, NAME ending in KEY, TOKEN, SECRET, PASSWORD, PASS, PWD or CREDENTIALS; group 1 is kept. */
export const ENV_LINE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|CREDENTIALS)=)(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/g;

export const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

export const MAC = /(?<![0-9A-Za-z:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![0-9A-Za-z:-])/g;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
export const IPV4 = new RegExp(`(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?![\\w]|\\.\\d)`, 'g');
/** Candidates only: isReportableIp decides. */
export const IPV6 = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g;

/** Candidates only: luhn decides. 13–19 digits, spaces or dashes between. */
export const CARD = /(?<![\w.-])\d(?:[ -]?\d){12,18}(?![\w-]|\.\d)/g;

export const PHONE_PATTERNS: RegExp[] = [
  // International: +44 20 7946 0958, +1-555-010-0199. Checked for 8–15 digits.
  /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])/g,
  // North American: (555) 010-0199, 555-010-0199, 555.010.0199.
  /(?<![\w-])(?:\(\d{3}\)[ ]?|\d{3}[-. ])\d{3}[-. ]\d{4}(?![\w-])/g,
];

/** An IP address the export replaces: anything but loopback and unspecified. */
export function isReportableIp(text: string): boolean {
  const v = net.isIP(text);
  if (v === 4) return !text.startsWith('127.') && text !== '0.0.0.0';
  if (v === 6) {
    const t = text.toLowerCase();
    return t !== '::1' && t !== '::' && !/^0{0,4}(?::0{0,4}){6}:0{0,3}[01]$/.test(t);
  }
  return false;
}

/** Words that say a nearby dotted quad is an address, not a version: "build server 10.0.0.5". */
const ADDRESS_WORDS = new Set([
  'ip', 'ips', 'ipv4', 'addr', 'address', 'host', 'hostname', 'server', 'node', 'machine', 'gateway', 'router', 'dns', 'subnet', 'net',
  'network', 'at', 'on', 'from', 'to', 'via', 'peer', 'proxy', 'endpoint', 'url', 'remote', 'connect', 'connecting', 'connected', 'ping', 'ssh',
]);

/** Logins that come before @ in front of an address, never a package: root@10.0.0.5. */
const LOGINS = new Set(['root', 'admin', 'administrator', 'user', 'ubuntu', 'ec2-user', 'centos', 'debian', 'fedora', 'pi', 'git', 'vagrant', 'deploy', 'core', 'azureuser', 'opc']);

/**
 * Whether the dotted quad at text[offset, offset + length) reads as a version, not an IP
 * address, from what's around it: the sanitizer keeps it and the final check doesn't count it.
 * Conservative: a bare 10.20.30.40, or one after "ip" or "host", is an address.
 *  - right after v or V (v1.2.3.4; IPV4 doesn't match there anyway);
 *  - right after @ following a package name (pkg@1.2.3.4, @scope/pkg@1.2.3.4), unless it reads
 *    as a login: a common login name (root@), a URL's user, an ssh/scp/sftp/rsync/mosh/telnet
 *    line, or followed by ":" (a prompt);
 *  - right after a standalone Product/ token (Chrome/120.0.61.109), not a path or URL segment,
 *    and not an address word (ip/10.0.0.1);
 *  - up to 20 characters after version, ver, v., build or release on the same line, when nothing
 *    in between is an address word ("build server 10.0.0.5" is an address);
 *  - followed directly by a semver suffix: a pre-release word (-beta, -rc.1, -preview) or build
 *    metadata (+build.5); not any dash (10.0.0.1-eth0 is an address).
 */
export function isVersionContext(text: string, offset: number, length: number): boolean {
  const before = text.slice(Math.max(0, offset - 80), offset);
  const after = text.slice(offset + length, offset + length + 40);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  if (/[vV]$/.test(before)) return true;
  if (/^(?:-(?:alpha|beta|rc|pre|preview|dev|snapshot|canary|nightly|next|insiders?)(?:[.-]?[0-9A-Za-z]+)*|\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?![\w+-])/i.test(after)) return true;
  const pkg = /(?:^|[\s"'`(\[{,;=])((?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]*)@$/.exec(line);
  if (pkg && !LOGINS.has(pkg[1].toLowerCase()) && !/:\/\/\S*$/.test(line) && !/(?:^|[^\w-])(?:ssh|scp|sftp|rsync|mosh|telnet)(?![\w-])/i.test(line) && !after.startsWith(':')) return true;
  const product = /(?:^|[\s"'`(\[{,;])([A-Za-z][A-Za-z0-9_.+-]*)\/$/.exec(line);
  if (product && /[A-Za-z]{2}/.test(product[1]) && !ADDRESS_WORDS.has(product[1].toLowerCase())) return true;
  const keyword = /(?:^|[^\p{L}\p{N}_])(?:version|ver|build|release|v\.)(?![\p{L}\p{N}_])([^\n]{0,20})$/iu.exec(line);
  if (keyword) {
    const words = keyword[1].toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (!words.some((w) => ADDRESS_WORDS.has(w))) return true;
  }
  return false;
}

/** Whether a 13–19 digit run (separators allowed) passes the Luhn check. */
export function isCardNumber(text: string): boolean {
  const digits = text.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Whether a phone candidate has a plausible number of digits. */
export function isPhoneNumber(text: string): boolean {
  const n = text.replace(/\D/g, '').length;
  return n >= 10 && n <= 15;
}

/**
 * Every rule 2 value in text, by rule: what the final check looks for, and what the sanitizer
 * replaces. Placeholders ([redacted], [email-1]) are never values.
 */
export function findPiiValues(text: string): Array<{ rule: PiiRule; value: string }> {
  const found: Array<{ rule: PiiRule; value: string }> = [];
  const each = (pattern: RegExp, rule: PiiRule, accept: (m: RegExpMatchArray) => string | undefined = (m) => m[0]) => {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))) {
      const value = accept(m);
      if (value && !/^\[[^\]]*\]$/.test(value)) found.push({ rule, value });
    }
  };
  for (const [pattern] of SECRET_PATTERNS) {
    each(pattern, 'secret', (m) => (/\[redacted/.test(m[0]) ? undefined : m[0]));
  }
  for (const pattern of PUBLIC_KEY_PATTERNS) each(pattern, 'public-key');
  each(CONNECTION_PASSWORD, 'connection-string', (m) => m[2].trim());
  each(ENV_LINE, 'env', (m) => m[2]);
  each(EMAIL, 'email');
  each(MAC, 'mac');
  each(IPV4, 'ip', (m) => (isReportableIp(m[0]) && !isVersionContext(text, m.index!, m[0].length) ? m[0] : undefined));
  each(IPV6, 'ip', (m) => (isReportableIp(m[0]) ? m[0] : undefined));
  each(CARD, 'card', (m) => (isCardNumber(m[0]) ? m[0] : undefined));
  for (const pattern of PHONE_PATTERNS) each(pattern, 'phone', (m) => (isPhoneNumber(m[0]) && !isCardNumber(m[0]) ? m[0] : undefined));
  return found;
}

// ---- rule 4 helpers --------------------------------------------------------------------------

/** Shannon entropy, in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long runs of base64 or hex characters: candidates for the high-entropy flag. */
export const LONG_TOKEN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;

/**
 * Whether a long token looks like key material: 41 or more hex characters (a 40-character run
 * is a SHA, handled by the SHA rule), or base64 with upper and lower case letters, digits, and
 * high entropy. Identifiers and English are lower.
 */
export function isHighEntropy(token: string): boolean {
  const bare = token.replace(/=+$/, '');
  if (/^[0-9a-fA-F]+$/.test(bare)) return bare.length > 40 && /\d/.test(bare) && /[a-fA-F]/.test(bare);
  if (!/[A-Z]/.test(bare) || !/[a-z]/.test(bare) || !/\d/.test(bare)) return false;
  return entropy(bare) >= 4.3;
}

/** Hex runs that might be commit SHAs (7–40 lower-case hex characters, a letter and a digit both). */
export const SHA_LIKE = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g;

export function isShaLike(text: string): boolean {
  return /\d/.test(text) && /[a-f]/.test(text);
}

/** Top-level domains that are never public: a URL to one is flagged as internal. */
const INTERNAL_TLDS = new Set(['local', 'internal', 'lan', 'home', 'corp', 'intranet', 'localdomain', 'private', 'intra', 'home.arpa']);

/** Whether a URL's host is public: a dotted name with an alphabetic top-level domain that isn't internal. localhost counts as fine. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIP(h.replace(/^\[|\]$/g, ''))) return true; // addresses are rule 2's
  const labels = h.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld)) return false;
  return !INTERNAL_TLDS.has(tld) && !h.endsWith('.home.arpa');
}

/** Escapes text for use in a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A RegExp for a word or phrase, case-insensitive, not inside a longer word. */
export function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, 'giu');
}
