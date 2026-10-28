import { isConversationEvent } from '../core/sessions';
import { EventToolCategory } from '../core/toolCategory';
import { NormalizedEvent } from '../core/types';
import { FindingReplay, ReplayEpisode } from '../heuristics/replay';
import { parseRule, Rule } from '../heuristics/rule';
import { measure, ruleHeuristic } from '../heuristics/ruleHeuristic';
import { Heuristic } from '../heuristics/types';
import { Probe, probeRule, probesFor } from './probes';
import { discoverShellCategories, ShellDiscovery } from './shellCategories';

/** Fewer turns than this and percentiles mean little. */
export const MIN_TURNS = 50;
/** An outlier family needs this many turns, in at least MIN_SESSIONS sessions, to be a pattern rather than one bad afternoon. */
const MIN_HITS = 3;
const MIN_SESSIONS = 2;
/** The share of your turns a candidate aims to fire on. */
const DEFAULT_TAIL = 0.01;
const MAX_EXAMPLES = 5;

export interface DiscoveryOptions {
  /** Heuristics already running (built-ins and rules), for overlap and to skip candidates that already exist. */
  existing: Heuristic[];
  settingsFor: (id: string) => Record<string, unknown>;
  contextLimit?: (model: string | undefined) => number | undefined;
  tail?: number;
}

export interface Baseline {
  turns: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface Score {
  /** Episodes it would have raised over the window, in how many sessions. */
  episodes: number;
  sessions: number;
  firstTs?: string;
  lastTs?: string;
  /** Per existing heuristic: how many of its episodes overlap one of this one's, in the same session. */
  overlaps: Record<string, number>;
  /** Sessions it would have fired in, most recent first. */
  examples: string[];
}

export interface Candidate {
  probe: Pick<Probe, 'key' | 'describes' | 'kind'>;
  rule: Record<string, unknown> & { id: string };
  threshold: number;
  baseline: Baseline;
  /** Turns at or above the threshold, and in how many sessions. */
  turnsAbove: number;
  sessionsAbove: number;
  score: Score;
}

export interface ThresholdSuggestion {
  heuristic: string;
  setting: string;
  describes: string;
  kind: Probe['kind'];
  current: number;
  /** Share of your turns at or above the current setting. */
  currentShare: number;
  /** A threshold at your own tail, if there's enough history for one. */
  suggested?: number;
  suggestedShare?: number;
  baseline: Baseline;
}

export interface DiscoveryResult {
  from?: string;
  to?: string;
  sessions: number;
  turns: number;
  candidates: Candidate[];
  thresholds: ThresholdSuggestion[];
  shell: ShellDiscovery;
  /** Why something couldn't be suggested (too little history). */
  notes: string[];
}

export interface PastTurn {
  sessionId: string;
  turnId: string;
  events: NormalizedEvent[];
}

/** Every turn in the events with its prompt among them: a session's conversation events sharing a turn id. */
export function pastTurns(events: NormalizedEvent[]): PastTurn[] {
  const turns = new Map<string, PastTurn>();
  for (const e of events) {
    if (!isConversationEvent(e) || !e.turnId) continue;
    const key = `${e.sessionId}\u0000${e.turnId}`;
    let turn = turns.get(key);
    if (!turn) turns.set(key, (turn = { sessionId: e.sessionId, turnId: e.turnId, events: [] }));
    turn.events.push(e);
  }
  return [...turns.values()].filter((t) => t.events.some((e) => e.kind === 'user_prompt'));
}

/** Nearest-rank percentile of ascending values. */
function percentile(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function baselineOf(values: number[]): Baseline {
  const sorted = [...values].sort((a, b) => a - b);
  return { turns: sorted.length, p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] ?? 0 };
}

/** v rounded down to the probe's steps, so a threshold never lands above the turns it was chosen from. */
function stepBelow(v: number, kind: Probe['kind']): number {
  if (kind === 'share') return Math.floor(v * 20 + 1e-9) / 20;
  if (kind === 'count' || v < 100) return Math.floor(v);
  const unit = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.floor(v / unit) * unit;
}

/**
 * A threshold at your tail: the value the top `tail` of turns reach, but
 * always one at least MIN_HITS turns reached, so it's a pattern you've
 * actually had. Undefined when nothing rises above zero.
 */
function tailThreshold(values: number[], kind: Probe['kind'], tail: number): number | undefined {
  const sorted = [...values].sort((a, b) => b - a);
  const k = Math.max(Math.ceil(values.length * tail), MIN_HITS);
  if (sorted.length < k) return undefined;
  const t = stepBelow(sorted[k - 1], kind);
  return t > 0 ? t : undefined;
}

/** The probe's value on each turn it applies to (gated turns left out). */
function probeValues(rule: Rule, gate: Probe['gate'], turns: PastTurn[], contextLimit: DiscoveryOptions['contextLimit']): Array<{ turn: PastTurn; value: number }> {
  const out: Array<{ turn: PastTurn; value: number }> = [];
  for (const turn of turns) {
    const ctx = { now: turn.events[turn.events.length - 1].ts, contextLimit };
    if (gate) {
      const g = measure(rule.measures[gate.measure], rule.filter, turn.events, ctx).value;
      if (g === undefined || g < gate.gte) continue;
    }
    out.push({ turn, value: measure(rule.measures.value, rule.filter, turn.events, ctx).value ?? 0 });
  }
  return out;
}

function overlapping(a: ReplayEpisode, b: ReplayEpisode): boolean {
  return a.startTs <= b.endTs && b.startTs <= a.endTs;
}

/** Replays each session through the candidates alongside the existing heuristics, as the live extension would have run them. */
function score(candidates: Heuristic[], existing: Heuristic[], bySession: Map<string, NormalizedEvent[]>, opts: DiscoveryOptions): Map<string, Score> {
  const scores = new Map<string, Score>(candidates.map((c) => [c.id, { episodes: 0, sessions: 0, overlaps: {}, examples: [] }]));
  const existingIds = new Set(existing.map((h) => h.id));
  const sessionsByRecency = [...bySession].sort((a, b) => (b[1][b[1].length - 1]?.ts ?? '').localeCompare(a[1][a[1].length - 1]?.ts ?? ''));
  for (const [sessionId, events] of sessionsByRecency) {
    const replay = new FindingReplay([...existing, ...candidates], opts.settingsFor, opts.contextLimit);
    for (const e of events) replay.ingest(e);
    const episodes = replay.episodes();
    const others = episodes.filter((e) => existingIds.has(e.heuristicId));
    for (const c of candidates) {
      const mine = episodes.filter((e) => e.heuristicId === c.id);
      if (mine.length === 0) continue;
      const s = scores.get(c.id)!;
      s.episodes += mine.length;
      s.sessions += 1;
      if (s.examples.length < MAX_EXAMPLES) s.examples.push(sessionId);
      if (!s.firstTs || mine[0].startTs < s.firstTs) s.firstTs = mine[0].startTs;
      if (!s.lastTs || mine[mine.length - 1].endTs > s.lastTs) s.lastTs = mine[mine.length - 1].endTs;
      for (const other of others) if (mine.some((m) => overlapping(m, other))) s.overlaps[other.heuristicId] = (s.overlaps[other.heuristicId] ?? 0) + 1;
    }
  }
  return scores;
}

/**
 * Discovery without a model: measures every past turn, finds where your own
 * turns' tails are, proposes rules there and thresholds for the built-ins,
 * proposes shell sub-categories, and scores each rule by replay.
 */
export function discover(events: NormalizedEvent[], opts: DiscoveryOptions): DiscoveryResult {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const turns = pastTurns(sorted);
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of sorted) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  const conversationSessions = new Set(turns.map((t) => t.sessionId));
  const result: DiscoveryResult = {
    from: sorted[0]?.ts,
    to: sorted[sorted.length - 1]?.ts,
    sessions: conversationSessions.size,
    turns: turns.length,
    candidates: [],
    thresholds: [],
    shell: discoverShellCategories(sorted),
    notes: [],
  };
  if (turns.length < MIN_TURNS) {
    result.notes.push(`Only ${turns.length} turns with their prompts in this history; discovery needs at least ${MIN_TURNS} to say what's unusual for you.`);
    return result;
  }

  const tail = opts.tail ?? DEFAULT_TAIL;
  const existingIds = new Set(opts.existing.map((h) => h.id));
  const categories = sorted.filter((e) => e.kind === 'tool_call' && e.toolCategory).map((e) => e.toolCategory as EventToolCategory);
  const pending: Array<Omit<Candidate, 'score'>> = [];
  for (const probe of probesFor(categories)) {
    const { value: rule } = parseRule(probeRule(probe, 1));
    if (!rule) continue;
    const measured = probeValues(rule, probe.gate, turns, opts.contextLimit);
    if (measured.length < MIN_TURNS) continue;
    const values = measured.map((m) => m.value);
    const baseline = baselineOf(values);
    const threshold = tailThreshold(values, probe.kind, tail);
    const above = (t: number) => measured.filter((m) => m.value >= t);
    // Ties at the threshold can make it common rather than a tail.
    const tooCommon = (t: number) => above(t).length > Math.max(3 * tail * measured.length, 2 * MIN_HITS);

    if (probe.builtIn) {
      const configured = opts.settingsFor(probe.builtIn.heuristic)[probe.builtIn.setting];
      const current = typeof configured === 'number' && configured > 0 ? configured : probe.builtIn.fallback;
      result.thresholds.push({
        heuristic: probe.builtIn.heuristic,
        setting: probe.builtIn.setting,
        describes: probe.describes,
        kind: probe.kind,
        current,
        currentShare: above(current).length / measured.length,
        ...(threshold !== undefined && threshold >= probe.floor && !tooCommon(threshold) ? { suggested: threshold, suggestedShare: above(threshold).length / measured.length } : {}),
        baseline,
      });
      continue;
    }
    if (threshold === undefined || threshold < probe.floor) continue;
    // An outlier is far from your normal, not just your busiest 1% of quiet turns.
    if (probe.kind !== 'share' && baseline.p50 > 0 && threshold < 2 * baseline.p50) continue;
    const hits = above(threshold);
    const sessionsAbove = new Set(hits.map((h) => h.turn.sessionId)).size;
    if (tooCommon(threshold) || sessionsAbove < MIN_SESSIONS) continue;
    const doc = probeRule(probe, threshold);
    if (existingIds.has(doc.id)) continue;
    pending.push({ probe: { key: probe.key, describes: probe.describes, kind: probe.kind }, rule: doc, threshold, baseline, turnsAbove: hits.length, sessionsAbove });
  }

  const heuristics = pending.map((c) => ruleHeuristic(parseRule(c.rule).value!));
  const scores = score(heuristics, opts.existing, bySession, opts);
  result.candidates = pending.map((c) => ({ ...c, score: scores.get(c.rule.id)! })).sort((a, b) => a.turnsAbove / a.baseline.turns - b.turnsAbove / b.baseline.turns);
  return result;
}
