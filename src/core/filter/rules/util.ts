import * as net from 'net';
import type { Match } from '../types';

/**
 * Regex helpers the rules share. Nothing here depends on another rule having run: each rule
 * detects in the original text on its own.
 */

/** Escapes text for use in a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A RegExp source for a word or phrase not inside a longer word (use with the u flag). */
export function wordSource(alternatives: string): string {
  return `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`;
}

/** A RegExp for a word or phrase, case-insensitive, not inside a longer word. */
export function wordPattern(word: string): RegExp {
  return new RegExp(wordSource(escapeRegExp(word)), 'giu');
}

/**
 * Every match of pattern in text (a fresh global copy, so the pattern's lastIndex never leaks
 * between calls), with group indices.
 */
export function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const flags = new Set(pattern.flags.split(''));
  flags.add('g');
  flags.add('d');
  return [...text.matchAll(new RegExp(pattern.source, [...flags].join('')))];
}

/**
 * Matches for each hit of pattern: the span of named group `s` when the pattern has one (the
 * value inside a kept prefix: Bearer <s>), else the whole match. `value` maps the span's text to
 * the value decided on (default the text itself); returning undefined skips the hit.
 */
export function spans(pattern: RegExp, text: string, value: (span: string, m: RegExpExecArray) => string | undefined = (s) => s): Match[] {
  const out: Match[] = [];
  for (const m of allMatches(pattern, text)) {
    const [start, end] = m.indices?.groups?.s ?? m.indices![0]!;
    if (end <= start) continue;
    const v = value(text.slice(start, end), m);
    if (v !== undefined && v !== '') out.push({ start, end, value: v });
  }
  return out;
}

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

/** Hex runs that might be commit SHAs: 7–40 lower-case hex characters, not inside a word or an id like checkout-<hex>. */
export const SHA_LIKE = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g;

/** Whether a hex run has both a digit and a letter, as a SHA (almost always) does. */
export function isShaLike(text: string): boolean {
  return /\d/.test(text) && /[a-f]/.test(text);
}

/** Top-level domains that are never public. */
export const INTERNAL_TLDS = new Set(['local', 'internal', 'lan', 'home', 'corp', 'intranet', 'localdomain', 'private', 'intra']);

/** Whether a host is public: a dotted name with an alphabetic top-level domain that isn't internal. localhost and IP addresses count as public here. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIP(h.replace(/^\[|\]$/g, ''))) return true; // addresses are the ip rule's
  const labels = h.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld)) return false;
  return !INTERNAL_TLDS.has(tld) && !h.endsWith('.home.arpa');
}

/** Whether a 13–19 digit run (spaces or dashes between) passes the Luhn check. */
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

/** Path characters: a path token stops at whitespace, quotes, brackets and separators. */
export const PATH_STOP = `\\s"'\`<>|;,)\\]}`;

/** A numbered placeholder: [email-3]. */
export const numbered = (kind: string) => (_value: string, n: number) => `[${kind}-${n}]`;
