import type { Match, Rule } from '../types';
import { spans } from './util';

/**
 * Secret formats, each with what capture-time redaction (core/excerpt.ts) replaces it with. A
 * backstop for the common cases, not a guarantee: anything in an unrecognized format stays.
 * Where a pattern keeps a prefix ($1: "Bearer ", "password="), named group `s` is the secret
 * itself, which is what this rule finds; it comes after the numbered groups, so $1 and $2 are
 * unchanged.
 */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted AWS key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, '[redacted GitHub token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, '[redacted GitHub token]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[redacted Anthropic key]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted API key]'],
  [/\b[rs]k_live_[0-9A-Za-z]{20,}/g, '[redacted Stripe key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted Slack token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted Google API key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted JWT]'],
  [/\b(Bearer\s+)(?<s>[A-Za-z0-9._~+/-]{20,}=*)/gi, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)(?<s>[^\s@/]+)@/gi, '$1[redacted]@'],
  // key=value secrets: the value must look like one (8+ key-style characters, letters and digits), so code such as `token = parse(x)` is left alone.
  [/\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)\b\s*[:=]\s*)(["']?)(?=[A-Za-z0-9_+/=.-]*\d)(?=[A-Za-z0-9_+/=.-]*[A-Za-z])(?<s>[A-Za-z0-9_+/=.-]{8,})\2(?![A-Za-z0-9_(])/gi, '$1$2[redacted]$2'],
];

export const secret: Rule = {
  id: 'secret',
  category: 'Credentials',
  describe:
    'The secret formats capture already redacts (private keys; AWS, GitHub, Anthropic, OpenAI-style, Stripe, Slack and Google keys; JWTs; bearer tokens; credentials in URLs; `password=` values), for text captured before a format was added.',
  becomes: '`[secret]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return SECRET_PATTERNS.flatMap(([pattern]) => spans(pattern, text));
  },
  replace(): string {
    return '[secret]';
  },
};
