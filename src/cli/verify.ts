/**
 * The migration's correctness check (docs/design/handoff-3c.md, step 3c-1):
 * every session in a baseline saved before migrating (`snagboat sessions --all
 * --json`) must be in the per-user store with the same prompt, tool-call and
 * token counts. Sessions recorded after the baseline are reported, not failed.
 */

/** The fields compared, from SessionSummary; a baseline needs only these. */
export interface SessionCounts {
  sessionId: string;
  prompts: number;
  toolCalls: number;
  tokens: number;
}

const FIELDS = ['prompts', 'toolCalls', 'tokens'] as const;

export interface VerifyResult {
  ok: boolean;
  baselineSessions: number;
  /** In the baseline, not in the per-user store. */
  missing: string[];
  /** In both, with a count that differs. */
  changed: Array<{ sessionId: string; field: (typeof FIELDS)[number]; baseline: number; current: number }>;
  /** In the per-user store only: recorded after the baseline. */
  added: string[];
}

/**
 * One entry per session. A session read from two stores (the same workspace in
 * VS Code and in Cursor) appears twice in a baseline, and once after migrating,
 * where its events are deduplicated: the larger count of each stands for it.
 */
function bySession(list: SessionCounts[]): Map<string, SessionCounts> {
  const map = new Map<string, SessionCounts>();
  for (const s of list) {
    const seen = map.get(s.sessionId);
    map.set(
      s.sessionId,
      seen ? { sessionId: s.sessionId, prompts: Math.max(seen.prompts, s.prompts), toolCalls: Math.max(seen.toolCalls, s.toolCalls), tokens: Math.max(seen.tokens, s.tokens) } : s
    );
  }
  return map;
}

export function compareToBaseline(baseline: SessionCounts[], current: SessionCounts[]): VerifyResult {
  const before = bySession(baseline);
  const after = bySession(current);
  const missing: string[] = [];
  const changed: VerifyResult['changed'] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) {
      missing.push(id);
      continue;
    }
    for (const field of FIELDS) if (a[field] !== b[field]) changed.push({ sessionId: id, field, baseline: b[field], current: a[field] });
  }
  const added = [...after.keys()].filter((id) => !before.has(id));
  return { ok: missing.length === 0 && changed.length === 0, baselineSessions: before.size, missing, changed, added };
}

/** Reads a baseline file's sessions; throws with a readable message if it isn't one. */
export function parseBaseline(text: string): SessionCounts[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('the baseline should be the JSON array `snagboat sessions --all --json` prints');
  return data.map((s, i) => {
    const ok = s && typeof s.sessionId === 'string' && FIELDS.every((f) => typeof s[f] === 'number');
    if (!ok) throw new Error(`baseline entry ${i} has no sessionId, prompts, toolCalls and tokens`);
    return { sessionId: s.sessionId, prompts: s.prompts, toolCalls: s.toolCalls, tokens: s.tokens };
  });
}

export function verifyText(r: VerifyResult): string {
  const lines: string[] = [];
  if (r.ok) {
    lines.push(`verified: all ${r.baselineSessions} sessions in the baseline are in the per-user store, with the same prompt, tool-call and token counts.`);
  } else {
    lines.push(`NOT verified: ${r.missing.length} of ${r.baselineSessions} baseline sessions missing, ${r.changed.length} count(s) different.`);
    for (const id of r.missing) lines.push(`  missing  ${id}`);
    for (const c of r.changed) lines.push(`  changed  ${c.sessionId}  ${c.field}: ${c.baseline} in the baseline, ${c.current} now`);
    if (r.changed.length > 0) lines.push('A session still in use after the baseline was taken also shows as changed; take the baseline just before migrating.');
  }
  if (r.added.length > 0) lines.push(`${r.added.length} session(s) in the per-user store aren't in the baseline (recorded after it).`);
  return lines.join('\n') + '\n';
}
