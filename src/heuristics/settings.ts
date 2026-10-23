/** A positive number setting, or the fallback when unset or invalid. */
export function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Compact token count for summaries: 987250 -> "987K". */
export function compactTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);
}
