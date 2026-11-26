import type { Match, Rule } from '../types';
import { allMatches, entropy, numbered } from './util';

/** Long runs of base64 or hex characters (a URL's path included): candidates. */
const LONG_TOKEN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;

/**
 * Whether a long token looks like key material: more than 40 hex characters (40 is a SHA), or
 * base64 with upper and lower case letters, digits, and high entropy. Identifiers and English
 * are lower.
 */
export function isHighEntropy(token: string): boolean {
  const bare = token.replace(/=+$/, '');
  if (bare.length < 40) return false;
  if (/^[0-9a-fA-F]+$/.test(bare)) return bare.length > 40 && /\d/.test(bare) && /[a-fA-F]/.test(bare);
  if (!/[A-Z]/.test(bare) || !/[a-z]/.test(bare) || !/\d/.test(bare)) return false;
  return entropy(bare) >= 4.3;
}

export const highEntropy: Rule = {
  id: 'high-entropy',
  category: 'Other',
  describe: 'Long high-entropy strings matching no known format: 40 or more characters of base64, or more than 40 of hex. At the end of a URL path, only the token.',
  becomes: '`[token-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    const out: Match[] = [];
    for (const m of allMatches(LONG_TOKEN, text)) {
      const token = m[0];
      // A URL path ending in a token (/code/session_01Mi...): only the token, when every segment
      // before it reads as a plain word, so the rest (its host, for one) stays readable.
      const cut = token.lastIndexOf('/');
      // An absolute path (/private/var/folders/q2/p1t6.../T/tmp-Ab12Cd/src/app) with a plain word
      // among its folders: only a segment that is itself high-entropy, never the whole path.
      const segs = token.split('/');
      if (token.startsWith('/') && segs.some((seg) => /^[a-z][a-z-]{2,}$/.test(seg))) {
        let at = m.index;
        for (const seg of segs) {
          if (isHighEntropy(seg)) out.push({ start: at, end: at + seg.length, value: seg });
          at += seg.length + 1;
        }
        continue;
      }
      if (cut > 0) {
        const head = token.slice(0, cut + 1);
        const last = token.slice(cut + 1);
        const plain = head.split('/').every((seg) => seg.length <= 30 && !/[A-Z]/.test(seg.replace(/^[A-Z]/, '')) && !isHighEntropy(seg));
        if (plain) {
          if (isHighEntropy(last)) out.push({ start: m.index + cut + 1, end: m.index + token.length, value: last });
          continue;
        }
      }
      if (isHighEntropy(token)) out.push({ start: m.index, end: m.index + token.length, value: token });
    }
    return out;
  },
  replace: numbered('token'),
};
