import { eventTokens, isConversationEvent, isShellTool, NormalizedEvent } from '@snagboat/schema';

/**
 * The measures advisors track (RFC step 4c), each worked out from a period's
 * events and outcomes (schema v3). A measure with nothing to measure in a
 * period (no milestones yet, no test that went green) has no value and says
 * why; one Snagboat doesn't record yet says that instead.
 */

export interface MeasureDef {
  label: string;
  unit: string;
  /** Which way is better. */
  better: 'lower' | 'higher';
  /** Undefined: nothing to measure in these events. */
  compute(events: NormalizedEvent[], ctx: MeasureContext): number | undefined;
  /** Set when Snagboat doesn't record what it needs yet. */
  notYet?: string;
}

export interface MeasureContext {
  /** Risky-command patterns (Bosun): built-in plus the advisor's own. */
  risky: RegExp[];
}

/** Gaps longer than this between a session's events aren't active time. */
const ACTIVE_GAP_MS = 15 * 60_000;
/** Gaps longer than this inside one turn are a stall. */
const STALL_GAP_MS = 5 * 60_000;

const outcomes = (events: NormalizedEvent[], type: string) => events.filter((e) => e.kind === 'outcome' && e.outcome?.type === type);
const conversation = (events: NormalizedEvent[]) => events.filter(isConversationEvent);
const tokens = (events: NormalizedEvent[]) => conversation(events).reduce((sum, e) => sum + (e.kind === 'turn_stop' ? eventTokens(e) : 0), 0);
const sessions = (events: NormalizedEvent[]) => new Set(conversation(events).map((e) => e.sessionId)).size;
const per = (n: number, d: number) => (d > 0 ? n / d : undefined);

/** Minutes of activity: the gaps of at most 15 minutes between each session's events. */
function activeMinutes(events: NormalizedEvent[]): number {
  const bySession = new Map<string, number[]>();
  for (const e of conversation(events)) {
    const times = bySession.get(e.sessionId);
    if (times) times.push(Date.parse(e.ts));
    else bySession.set(e.sessionId, [Date.parse(e.ts)]);
  }
  let ms = 0;
  for (const times of bySession.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= ACTIVE_GAP_MS) ms += times[i] - times[i - 1];
  }
  return ms / 60_000;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/** Commands that can do damage that's hard to undo; Bosun's persona.md may add its own. */
export const RISKY_COMMANDS: Array<{ id: string; pattern: RegExp }> = [
  // -rf, -fr, -Rf, or the flags apart (-r -f, --recursive --force), before the paths.
  { id: 'recursive-force-delete', pattern: /\brm\s+(?=(?:-\S+\s+)*?-[a-zA-Z]*[rR])(?=(?:-\S+\s+)*?-[a-zA-Z]*f|(?:-\S+\s+)*?--force)|\brm\s+(?:-\S+\s+)*?--recursive\b(?:\s+-\S+)*?\s+(?:-[a-zA-Z]*f|--force)\b/ },
  // --force, -f, --force-with-lease, or a +refspec.
  { id: 'force-push', pattern: /\bgit\s+push\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/ },
  { id: 'hard-reset', pattern: /\bgit\s+reset\s+--hard\b/ },
  { id: 'clean-untracked', pattern: /\bgit\s+clean\s+-[a-z]*f/ },
  { id: 'download-to-shell', pattern: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/ },
  { id: 'sudo', pattern: /(^|[;&|(\n]|\$\()\s*sudo\s/m },
  { id: 'world-writable', pattern: /\bchmod\s+(-R\s+)?(0?777|a\+rwx)\b/ },
  { id: 'drop-database', pattern: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i },
  { id: 'publish', pattern: /\b(npm|pnpm|yarn)\s+publish\b|\b(cargo|twine|gem)\s+(publish|push|upload)\b/ },
  { id: 'disk-write', pattern: /\b(mkfs(\.\w+)?|dd\s+[^\n]*\bof=\/dev\/)/ },
];

/** A shell command (not a file path) matching a risky pattern. */
const isRisky = (e: NormalizedEvent, ctx: MeasureContext) => e.kind === 'tool_call' && isShellTool(e.toolName) && typeof e.target === 'string' && ctx.risky.some((p) => p.test(e.target!));
const riskyCount = (events: NormalizedEvent[], ctx: MeasureContext) => conversation(events).filter((e) => isRisky(e, ctx)).length;

export const MEASURES: Record<string, MeasureDef> = {
  tokens_per_milestone: { label: 'Tokens per milestone', unit: 'tokens', better: 'lower', compute: (ev) => per(tokens(ev), outcomes(ev, 'milestone').length) },
  tokens_per_accepted_change: { label: 'Tokens per commit kept', unit: 'tokens', better: 'lower', compute: (ev) => per(tokens(ev), outcomes(ev, 'commit_kept').length) },
  cache_hit_rate: {
    label: 'Cache hit rate',
    unit: '%',
    better: 'higher',
    compute: (ev) => {
      let read = 0;
      let all = 0;
      for (const e of conversation(ev)) {
        if (e.kind !== 'turn_stop' || !e.tokens) continue;
        read += e.tokens.cacheRead ?? 0;
        all += (e.tokens.input ?? 0) + (e.tokens.cacheRead ?? 0) + (e.tokens.cacheCreation ?? 0);
      }
      return all > 0 ? (100 * read) / all : undefined;
    },
  },
  milestones_per_session: { label: 'Milestones per session', unit: '', better: 'higher', compute: (ev) => per(outcomes(ev, 'milestone').length, sessions(ev)) },
  minutes_per_milestone: { label: 'Active minutes per milestone', unit: 'min', better: 'lower', compute: (ev) => per(activeMinutes(ev), outcomes(ev, 'milestone').length) },
  minutes_to_green: { label: 'Minutes from a failing test to green (median)', unit: 'min', better: 'lower', compute: (ev) => median(outcomes(ev, 'tests_green').map((e) => (e.outcome?.afterMs ?? 0) / 60_000)) },
  stall_minutes: {
    label: 'Stalled minutes (gaps over 5 minutes inside a turn)',
    unit: 'min',
    better: 'lower',
    compute: (ev) => {
      const byTurn = new Map<string, number[]>();
      for (const e of conversation(ev)) {
        if (!e.turnId) continue;
        const key = `${e.sessionId}\n${e.turnId}`;
        const times = byTurn.get(key);
        if (times) times.push(Date.parse(e.ts));
        else byTurn.set(key, [Date.parse(e.ts)]);
      }
      if (byTurn.size === 0) return undefined;
      let ms = 0;
      for (const times of byTurn.values()) {
        times.sort((a, b) => a - b);
        for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > STALL_GAP_MS) ms += times[i] - times[i - 1];
      }
      return ms / 60_000;
    },
  },
  risky_commands: { label: 'Risky commands', unit: '', better: 'lower', compute: (ev, ctx) => (sessions(ev) > 0 ? riskyCount(ev, ctx) : undefined) },
  risky_commands_per_session: { label: 'Risky commands per session', unit: '', better: 'lower', compute: (ev, ctx) => per(riskyCount(ev, ctx), sessions(ev)) },
  approvals_per_session: { label: 'Approvals granted per session', unit: '', better: 'lower', compute: () => undefined, notYet: "needs Claude Code's PermissionRequest hook (snagboat-79f.5.5)" },
  notifications_per_hour: { label: 'Notifications per active hour', unit: '', better: 'lower', compute: () => undefined, notYet: 'notifications are recorded from the next step (4c-2)' },
  dismiss_rate: {
    label: 'Findings dismissed (muted or let pass)',
    unit: '%',
    better: 'lower',
    compute: (ev) => {
      const r = outcomes(ev, 'finding_response');
      return r.length > 0 ? (100 * r.filter((e) => e.outcome?.response === 'muted' || e.outcome?.response === 'passed').length) / r.length : undefined;
    },
  },
  useful_share: {
    label: 'Findings marked useful',
    unit: '%',
    better: 'higher',
    compute: (ev) => {
      const r = outcomes(ev, 'finding_response');
      return r.length > 0 ? (100 * r.filter((e) => e.outcome?.response === 'useful').length) / r.length : undefined;
    },
  },
};

export interface MeasureResult {
  id: string;
  label: string;
  unit: string;
  better: 'lower' | 'higher';
  /** This period; undefined when there was nothing to measure. */
  value?: number;
  /** The period before, the same length. */
  previous?: number;
  /** better, worse or same, when both periods have a value. */
  trend?: 'better' | 'worse' | 'same';
  /** Why there's no value: not recorded yet, or an unknown measure id. */
  note?: string;
}

/** Each measure for this period and the one before. */
export function measure(ids: string[], current: NormalizedEvent[], previous: NormalizedEvent[], ctx: MeasureContext): MeasureResult[] {
  return ids.map((id) => {
    const def = MEASURES[id];
    if (!def) return { id, label: id, unit: '', better: 'lower' as const, note: 'unknown measure' };
    const base = { id, label: def.label, unit: def.unit, better: def.better };
    if (def.notYet) return { ...base, note: `not measured yet: ${def.notYet}` };
    const value = def.compute(current, ctx);
    const prev = def.compute(previous, ctx);
    const trend =
      value === undefined || prev === undefined ? undefined : Math.abs(value - prev) <= Math.max(1e-9, Math.abs(prev) * 0.05) ? 'same' : (value < prev) === (def.better === 'lower') ? 'better' : 'worse';
    return { ...base, ...(value !== undefined ? { value } : {}), ...(prev !== undefined ? { previous: prev } : {}), ...(trend ? { trend } : {}) };
  });
}

/** Risky-command patterns for an advisor: the built-in ones plus its own (invalid ones reported). */
export function riskyPatterns(extra: string[]): { patterns: RegExp[]; problems: string[] } {
  const patterns = RISKY_COMMANDS.map((r) => r.pattern);
  const problems: string[] = [];
  for (const p of extra) {
    try {
      patterns.push(new RegExp(p));
    } catch {
      problems.push(`risky_commands: not a regular expression: ${p}`);
    }
  }
  return { patterns, problems };
}
