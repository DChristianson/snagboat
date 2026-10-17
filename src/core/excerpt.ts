/** Upper bound on a captured textExcerpt, in UTF-16 code units. */
export const EXCERPT_MAX_CHARS = 500;

/**
 * Joins text fragments into one excerpt, truncated to EXCERPT_MAX_CHARS with a
 * trailing ellipsis. Returns undefined when there's no non-blank text, so
 * events without text simply omit the field.
 */
export function makeExcerpt(fragments: Array<string | undefined>): string | undefined {
  const text = fragments
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .join('\n\n');
  if (text.length === 0) return undefined;
  if (text.length <= EXCERPT_MAX_CHARS) return text;
  let cut = text.slice(0, EXCERPT_MAX_CHARS - 1);
  // Never leave half of a surrogate pair (an emoji, say) dangling at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
