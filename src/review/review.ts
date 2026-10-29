import { isConversationEvent } from '../core/sessions';
import { baseCategory, categoryLabel } from '../core/toolCategory';
import { NormalizedEvent } from '../core/types';
import { DiscoveryResult } from '../discovery/discover';
import { compactTokens } from '../heuristics/settings';
import { FindingReplay, ReplayEpisode } from '../heuristics/replay';
import { Provenance } from '../heuristics/ruleStore';
import { ResponseEpisode, ResponseStats, responseStats } from '../heuristics/responses';
import { Heuristic } from '../heuristics/types';
import { CheckResult, momentsFrom, presentationChecks } from './presentation';

/**
 * The periodic review without a model: what a week of agent work cost, which
 * heuristics fired and how you responded, rules to retire or add, and how
 * findings were shown. Written as Markdown for you to keep. It names
 * heuristics, rules, models, and session ids; never prompts, replies,
 * targets, paths, or session names. See docs/design/trusted-advisor.md.
 */

export interface ReviewInput {
  workspace: string;
  from: string;
  to: string;
  /** This workspace's events in the window. */
  events: NormalizedEvent[];
  heuristics: Heuristic[];
  settingsFor: (id: string) => Record<string, unknown>;
  contextLimit?: (model: string | undefined) => number | undefined;
  savedRules: Array<{ id: string; title: string; provenance: Provenance }>;
  /** Your recorded responses to findings, in the window. */
  responses: ResponseEpisode[];
  /** When responses started being recorded, if ever. */
  respondingSince?: string;
  muted: string[];
  /** Discovery over its own window, for rules to add. */
  discovery?: DiscoveryResult;
}

interface TokenSum {
  tokens: number;
  calls: number;
}

export interface Review {
  input: Pick<ReviewInput, 'workspace' | 'from' | 'to' | 'respondingSince' | 'muted'>;
  usage: {
    sessions: number;
    turns: number;
    modelCalls: number;
    toolCalls: number;
    tokens: number;
    byModel: Array<{ model: string } & TokenSum>;
    byDay: Array<{ day: string } & TokenSum>;
    byCategory: Array<{ category: string; calls: number; failures: number }>;
    costliest: Array<{ sessionId: string; turns: number; tokens: number }>;
  };
  heuristics: Array<{ id: string; episodes: number; warnings: number; sessions: number; response?: ResponseStats }>;
  retire: Array<{ id: string; title: string; reason: string }>;
  add: Array<{ id: string; title: string; detail: string }>;
  thresholds: Array<{ detail: string }>;
  presentation: { moments: number; checks: CheckResult[] };
}

const tokensOf = (e: NormalizedEvent) => (e.tokens ? (e.tokens.input ?? 0) + (e.tokens.output ?? 0) + (e.tokens.cacheRead ?? 0) + (e.tokens.cacheCreation ?? 0) : 0);

function bump<K>(map: Map<K, TokenSum>, key: K, e: NormalizedEvent): void {
  const s = map.get(key) ?? { tokens: 0, calls: 0 };
  s.tokens += tokensOf(e);
  s.calls += 1;
  map.set(key, s);
}

export function buildReview(input: ReviewInput): Review {
  const events = [...input.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const conversation = events.filter(isConversationEvent);
  // Claude Code's <synthetic> messages weren't produced by a model.
  const calls = conversation.filter((e) => e.kind === 'turn_stop' && e.tokens && e.model !== '<synthetic>');
  const tools = conversation.filter((e) => e.kind === 'tool_call');

  const byModel = new Map<string, TokenSum>();
  const byDay = new Map<string, TokenSum>();
  const bySession = new Map<string, TokenSum & { turns: Set<string> }>();
  for (const e of calls) {
    bump(byModel, e.model ?? 'unknown', e);
    bump(byDay, e.ts.slice(0, 10), e);
  }
  for (const e of conversation) {
    const s = bySession.get(e.sessionId) ?? { tokens: 0, calls: 0, turns: new Set<string>() };
    s.tokens += tokensOf(e);
    if (e.kind === 'user_prompt' && e.turnId) s.turns.add(e.turnId);
    bySession.set(e.sessionId, s);
  }
  const byCategory = new Map<string, { calls: number; failures: number }>();
  for (const e of tools) {
    const c = categoryLabel(e.toolCategory ? baseCategory(e.toolCategory) : 'other');
    const s = byCategory.get(c) ?? { calls: 0, failures: 0 };
    s.calls += 1;
    if (e.status === 'failure') s.failures += 1;
    byCategory.set(c, s);
  }

  // Each session replayed through the heuristics in use, as the live engine would have run them.
  const sessionEvents = new Map<string, NormalizedEvent[]>();
  for (const e of events) sessionEvents.set(e.sessionId, [...(sessionEvents.get(e.sessionId) ?? []), e]);
  const episodes: ReplayEpisode[] = [];
  const episodeSessions = new Map<string, Set<string>>();
  for (const [sessionId, list] of sessionEvents) {
    const replay = new FindingReplay(input.heuristics, input.settingsFor, input.contextLimit);
    for (const e of list) replay.ingest(e);
    for (const ep of replay.episodes()) {
      episodes.push(ep);
      episodeSessions.set(ep.heuristicId, new Set([...(episodeSessions.get(ep.heuristicId) ?? []), sessionId]));
    }
  }
  const responses = responseStats(input.responses);
  const fired = new Map<string, { episodes: number; warnings: number }>();
  for (const ep of episodes) {
    const f = fired.get(ep.heuristicId) ?? { episodes: 0, warnings: 0 };
    f.episodes += 1;
    if (ep.severity === 'warn') f.warnings += 1;
    fired.set(ep.heuristicId, f);
  }

  const retire: Review['retire'] = [];
  for (const rule of input.savedRules) {
    const f = fired.get(rule.id);
    const r = responses.get(rule.id);
    if (input.muted.includes(rule.id)) retire.push({ id: rule.id, title: rule.title, reason: 'you muted it' });
    else if (!f) retire.push({ id: rule.id, title: rule.title, reason: 'it never fired in this period' });
    else if (r && r.episodes >= 3 && r.acknowledged === 0) retire.push({ id: rule.id, title: rule.title, reason: `none of its ${r.episodes} recorded episodes was acknowledged` });
  }
  for (const id of input.muted) if (!input.savedRules.some((r) => r.id === id)) retire.push({ id, title: id, reason: 'you muted this built-in; raise its threshold instead, or leave it muted' });

  const d = input.discovery;
  const add: Review['add'] = (d?.candidates ?? []).slice(0, 5).map((c) => ({
    id: c.rule.id,
    title: String(c.rule.title),
    detail: `turns with ${c.probe.kind === 'tokens' ? compactTokens(c.threshold) : c.probe.kind === 'share' ? `${Math.round(c.threshold * 100)}%` : c.threshold} or more ${c.probe.describes}: ${c.turnsAbove} of ${c.baseline.turns} turns, would have raised ${c.score.episodes} episodes in ${c.score.sessions} sessions`,
  }));
  const thresholds = (d?.thresholds ?? [])
    .filter((t) => t.suggested !== undefined && t.suggested !== t.current)
    .map((t) => ({ detail: `${t.heuristic} ${t.setting} is ${t.current} (reached by ${Math.round(t.currentShare * 1000) / 10}% of turns); your tail is ${t.suggested}` }));

  const moments = momentsFrom(episodes, new Set(input.muted));
  return {
    input: { workspace: input.workspace, from: input.from, to: input.to, respondingSince: input.respondingSince, muted: input.muted },
    usage: {
      sessions: new Set(conversation.map((e) => e.sessionId)).size,
      turns: new Set(conversation.filter((e) => e.kind === 'user_prompt' && e.turnId).map((e) => `${e.sessionId}:${e.turnId}`)).size,
      modelCalls: calls.length,
      toolCalls: tools.length,
      tokens: calls.reduce((n, e) => n + tokensOf(e), 0),
      byModel: [...byModel].map(([model, s]) => ({ model, ...s })).sort((a, b) => b.tokens - a.tokens),
      byDay: [...byDay].map(([day, s]) => ({ day, ...s })).sort((a, b) => a.day.localeCompare(b.day)),
      byCategory: [...byCategory].map(([category, s]) => ({ category, ...s })).sort((a, b) => b.calls - a.calls),
      costliest: [...bySession].map(([sessionId, s]) => ({ sessionId, turns: s.turns.size, tokens: s.tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    },
    heuristics: [...new Set([...fired.keys(), ...responses.keys()])]
      .map((id) => ({ id, episodes: fired.get(id)?.episodes ?? 0, warnings: fired.get(id)?.warnings ?? 0, sessions: episodeSessions.get(id)?.size ?? 0, response: responses.get(id) }))
      .sort((a, b) => b.episodes - a.episodes),
    retire,
    add,
    thresholds,
    presentation: { moments: moments.length, checks: presentationChecks(moments, responses) },
  };
}

const pct = (n: number, of: number) => (of === 0 ? '0%' : `${Math.round((100 * n) / of)}%`);

export function renderReview(r: Review): string {
  const u = r.usage;
  const day = (ts: string) => ts.slice(0, 10);
  const out: string[] = [
    `# Snagboat review: ${r.input.workspace}, ${day(r.input.from)} to ${day(r.input.to)}`,
    '',
    `Written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from this workspace's log. It names heuristics, rules, models, and session ids, never prompts, replies, file paths, or commands.`,
    '',
    '## Usage',
    '',
    `${u.sessions} sessions, ${u.turns} turns, ${u.modelCalls} model calls, ${u.toolCalls} tool calls, ${compactTokens(u.tokens)} tokens.`,
    '',
  ];
  if (u.byModel.length) out.push('| Model | Calls | Tokens |', '| --- | --- | --- |', ...u.byModel.map((m) => `| ${m.model} | ${m.calls} | ${compactTokens(m.tokens)} |`), '');
  if (u.byDay.length) out.push('| Day | Model calls | Tokens |', '| --- | --- | --- |', ...u.byDay.map((d) => `| ${d.day} | ${d.calls} | ${compactTokens(d.tokens)} |`), '');
  if (u.byCategory.length) out.push('| Tool category | Calls | Failed |', '| --- | --- | --- |', ...u.byCategory.map((c) => `| ${c.category} | ${c.calls} | ${c.failures} |`), '');
  if (u.costliest.length) out.push('Costliest sessions: ' + u.costliest.map((s) => `\`${s.sessionId.slice(0, 8)}\` (${s.turns} turns, ${compactTokens(s.tokens)})`).join(', ') + '.', '');

  out.push('## Findings and how you responded', '');
  if (!r.input.respondingSince) out.push('Responses (acknowledging, muting) are recorded from now on; the next review will show them.', '');
  else out.push(`Responses recorded since ${day(r.input.respondingSince)}.`, '');
  if (r.heuristics.length === 0) out.push('No heuristic fired in this period.', '');
  else {
    out.push('| Heuristic | Episodes (warnings) | Sessions | Acknowledged | Median time to acknowledge | Ended unacknowledged | Muted |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of r.heuristics) {
      const s = h.response;
      out.push(
        `| ${h.id} | ${h.episodes} (${h.warnings}) | ${h.sessions} | ${s ? `${s.acknowledged} of ${s.episodes}` : '—'} | ${s?.medianMinutesToAcknowledge !== undefined ? `${s.medianMinutesToAcknowledge} min` : '—'} | ${s ? `${s.expiredUnacknowledged} (${pct(s.expiredUnacknowledged, s.episodes)})` : '—'} | ${s ? s.muted : '—'} |`
      );
    }
    out.push('', 'Episodes are replayed from the log with your current settings; responses are what you did when they were live.', '');
  }

  out.push('## Rules', '');
  out.push('**To retire or rethink**', '', ...(r.retire.length ? r.retire.map((x) => `- ${x.title} (\`${x.id}\`): ${x.reason}.`) : ['- Nothing: every rule fired and was acted on.']), '');
  out.push('**To add**, from discovery (accept them in the Suggestions tab)', '', ...(r.add.length ? r.add.map((x) => `- ${x.title} (\`${x.id}\`): ${x.detail}.`) : ['- Nothing new stands out.']), '');
  if (r.thresholds.length) out.push('**Built-in thresholds against your history**', '', ...r.thresholds.map((t) => `- ${t.detail}.`), '');

  out.push('## How findings were shown', '');
  if (r.presentation.moments === 0) out.push('No moment in this period had a warning or several findings at once, so there was nothing to check.', '');
  else {
    out.push(`${r.presentation.moments} moments had a warning or several findings active at once. Rebuilt with the status bar's own code, they show:`, '');
    if (r.presentation.checks.length === 0) out.push('- Nothing to fix: warnings came first and stood out.', '');
    for (const c of r.presentation.checks) {
      out.push(`### ${c.title} (${c.moments} of ${r.presentation.moments} moments)`, '', `Example, ${c.example.moment.at.slice(0, 16).replace('T', ' ')} UTC:`, '', '```', `status bar: ${c.example.statusBar}`, 'tooltip:', ...c.example.tooltip.map((l) => `  ${l}`), '```', '', `**Suggested change** (to file as an issue if you agree): ${c.recommendation}`, '');
    }
  }
  return out.join('\n') + '\n';
}

/** ISO week label for a review's file name, such as 2026-W44. */
export function isoWeek(ts: string): string {
  const d = new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10)));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
