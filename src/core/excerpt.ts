import { NormalizedEvent } from './types';

/** Upper bound on a captured textExcerpt (agent reply), in UTF-16 code units. */
export const EXCERPT_MAX_CHARS = 500;
/** Upper bound on captured prompt text; 98% of real prompts fit whole (the rest is mostly pasted logs and files). */
export const PROMPT_MAX_CHARS = 2000;

/**
 * Secret formats replaced before any text is stored. A backstop for the
 * common cases, not a guarantee: anything in an unrecognized format stays.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
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
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  // key=value secrets: the value must look like one (8+ key-style characters, letters and digits), so code such as `token = parse(x)` is left alone.
  [/\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)\b\s*[:=]\s*)(["']?)(?=[A-Za-z0-9_+/=.-]*\d)(?=[A-Za-z0-9_+/=.-]*[A-Za-z])[A-Za-z0-9_+/=.-]{8,}\2(?![A-Za-z0-9_(])/gi, '$1$2[redacted]$2'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function joinFragments(fragments: Array<string | undefined>): string {
  return fragments
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .join('\n\n');
}

/** Cuts text to max code units without leaving half of a surrogate pair (an emoji, say) dangling. */
function cutAt(text: string, max: number): string {
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Joins text fragments into one excerpt, secrets redacted, truncated to
 * EXCERPT_MAX_CHARS with a trailing ellipsis. Returns undefined when there's
 * no non-blank text, so events without text simply omit the field.
 */
export function makeExcerpt(fragments: Array<string | undefined>): string | undefined {
  const text = redactSecrets(joinFragments(fragments));
  if (text.length === 0) return undefined;
  if (text.length <= EXCERPT_MAX_CHARS) return text;
  return `${cutAt(text, EXCERPT_MAX_CHARS - 1)}…`;
}

/** A prompt's text, secrets redacted, capped at PROMPT_MAX_CHARS with a note of how much was cut. */
export function makePromptText(fragments: Array<string | undefined>): string | undefined {
  const text = redactSecrets(joinFragments(fragments));
  if (text.length === 0) return undefined;
  if (text.length <= PROMPT_MAX_CHARS) return text;
  const kept = cutAt(text, PROMPT_MAX_CHARS);
  return `${kept}… (+${(text.length - kept.length).toLocaleString('en-US')} characters)`;
}

/** Whether the event carries captured text that text retention and Remove Captured Text remove. */
export function hasCapturedText(event: NormalizedEvent): boolean {
  return event.textExcerpt !== undefined || event.promptText !== undefined;
}

/** The event without its captured text (reply excerpt and prompt text). Session names are kept. */
export function withoutCapturedText(event: NormalizedEvent): NormalizedEvent {
  if (!hasCapturedText(event)) return event;
  const { textExcerpt: _reply, promptText: _prompt, ...rest } = event;
  return rest;
}
