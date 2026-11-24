import { CaptureLimits, NormalizedEvent } from '@snagboat/schema';
import { SECRET_PATTERNS } from './filter/rules/secret';

/** Default cap on a captured textExcerpt (agent reply), in UTF-16 code units: snagboat.capture.replyChars. */
export const EXCERPT_MAX_CHARS = 500;
/** Default cap on captured prompt text (snagboat.capture.promptChars); 98% of real prompts fit whole (the rest is mostly pasted logs and files). */
export const PROMPT_MAX_CHARS = 2000;
/** The most either cap may be set to. */
export const CAPTURE_CHARS_LIMIT = 100_000;
/** The caps when no setting says otherwise. */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = { promptChars: PROMPT_MAX_CHARS, replyChars: EXCERPT_MAX_CHARS };

/** A cap setting's value as a usable cap: a whole number from 1 to CAPTURE_CHARS_LIMIT, else the fallback. */
export function captureChars(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(CAPTURE_CHARS_LIMIT, Math.max(1, Math.floor(value)));
}

/** The caps from a project's settings (keys without the `snagboat.` prefix: capture.promptChars, capture.replyChars). */
export function captureLimitsFrom(values: Record<string, unknown>): CaptureLimits {
  return {
    promptChars: captureChars(values['capture.promptChars'], PROMPT_MAX_CHARS),
    replyChars: captureChars(values['capture.replyChars'], EXCERPT_MAX_CHARS),
  };
}

/** Captured text, and whether it was cut at its cap (the event's textTruncated). */
export interface CapturedText {
  text: string;
  truncated: boolean;
}
/** Upper bound on one captured todo item's text. */
export const TODO_MAX_CHARS = 200;

/**
 * Secret formats are replaced before any text is stored. The patterns live with the export
 * filter's secret rule (filter/rules/secret.ts), which finds the same formats again in text
 * captured before a pattern was added.
 */
export { SECRET_PATTERNS };

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
export function cutAt(text: string, max: number): string {
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Joins text fragments into one reply excerpt, secrets redacted (over the
 * whole text, before it's cut), cut to `max` (snagboat.capture.replyChars)
 * with a trailing ellipsis. Undefined when there's no non-blank text, so
 * events without text simply omit the field.
 */
export function captureReply(fragments: Array<string | undefined>, max: number = EXCERPT_MAX_CHARS): CapturedText | undefined {
  const text = redactSecrets(joinFragments(fragments));
  if (text.length === 0) return undefined;
  if (text.length <= max) return { text, truncated: false };
  return { text: `${cutAt(text, max - 1)}…`, truncated: true };
}

/** A prompt's text, secrets redacted (over the whole text), cut to `max` (snagboat.capture.promptChars) with a note of how much was cut. */
export function capturePrompt(fragments: Array<string | undefined>, max: number = PROMPT_MAX_CHARS): CapturedText | undefined {
  const text = redactSecrets(joinFragments(fragments));
  if (text.length === 0) return undefined;
  if (text.length <= max) return { text, truncated: false };
  const kept = cutAt(text, max);
  return { text: `${kept}… (+${(text.length - kept.length).toLocaleString('en-US')} characters)`, truncated: true };
}

/** captureReply's text alone. */
export function makeExcerpt(fragments: Array<string | undefined>, max: number = EXCERPT_MAX_CHARS): string | undefined {
  return captureReply(fragments, max)?.text;
}

/** capturePrompt's text alone. */
export function makePromptText(fragments: Array<string | undefined>, max: number = PROMPT_MAX_CHARS): string | undefined {
  return capturePrompt(fragments, max)?.text;
}

/** The fields an event carries for captured reply text: textExcerpt, and textTruncated when it was cut. */
export function replyFields(captured: CapturedText | undefined): Pick<NormalizedEvent, 'textExcerpt' | 'textTruncated'> {
  if (!captured) return {};
  return captured.truncated ? { textExcerpt: captured.text, textTruncated: true } : { textExcerpt: captured.text };
}

/** The fields an event carries for captured prompt text: promptText, and textTruncated when it was cut. */
export function promptFields(captured: CapturedText | undefined): Pick<NormalizedEvent, 'promptText' | 'textTruncated'> {
  if (!captured) return {};
  return captured.truncated ? { promptText: captured.text, textTruncated: true } : { promptText: captured.text };
}

/** A todo item's text, secrets redacted, capped at TODO_MAX_CHARS with a trailing ellipsis. */
export function makeTodoText(text: string | undefined): string | undefined {
  const t = redactSecrets(joinFragments([text]));
  if (t.length === 0) return undefined;
  if (t.length <= TODO_MAX_CHARS) return t;
  return `${cutAt(t, TODO_MAX_CHARS - 1)}…`;
}

/** toolInput's fields kept only with snagboat.captureContent (its path is structural, as target's is). */
const CAPTURED_TOOL_INPUT = ['command', 'pattern', 'url', 'description'] as const;

/** Whether the event carries captured text that text retention and Remove Captured Text remove. */
export function hasCapturedText(event: NormalizedEvent): boolean {
  return (
    event.textExcerpt !== undefined ||
    event.promptText !== undefined ||
    (event.toolInput !== undefined && CAPTURED_TOOL_INPUT.some((k) => event.toolInput![k] !== undefined)) ||
    event.todos?.items !== undefined ||
    event.taskOp?.subject !== undefined ||
    event.taskOp?.tasks?.some((t) => t.subject !== undefined) === true
  );
}

/**
 * The event without its captured text (reply excerpt, prompt text, todo items'
 * text, task subjects, a tool call's command, pattern, URL and description; a
 * todo list's counts, a task's id and status, a tool call's path and refs stay).
 * Session names are kept.
 */
export function withoutCapturedText(event: NormalizedEvent): NormalizedEvent {
  if (!hasCapturedText(event)) return event;
  const { textExcerpt: _reply, promptText: _prompt, textTruncated: _truncated, ...rest } = event;
  if (rest.toolInput) {
    const { command: _c, pattern: _p, url: _u, description: _d, ...kept } = rest.toolInput;
    if (Object.keys(kept).length > 0) rest.toolInput = kept;
    else delete rest.toolInput;
  }
  if (rest.todos?.items) {
    const { items: _items, ...counts } = rest.todos;
    rest.todos = counts;
  }
  if (rest.taskOp) {
    const { subject: _subject, ...op } = rest.taskOp;
    if (op.tasks) op.tasks = op.tasks.map(({ subject: _s, ...t }) => t);
    rest.taskOp = op;
  }
  return rest;
}
