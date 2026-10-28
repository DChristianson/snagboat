import { compactTokens } from '../heuristics/settings';
import { DiscoveryResult, MIN_TURNS, ThresholdSuggestion } from './discover';
import { Probe } from './probes';

function percent(share: number): string {
  const p = share * 100;
  return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

function value(v: number, kind: Probe['kind']): string {
  return kind === 'share' ? percent(v) : kind === 'tokens' ? compactTokens(v) : String(v);
}

function thresholdLine(t: ThresholdSuggestion): string {
  const now = `${t.heuristic} ${t.setting} is ${value(t.current, t.kind)}, reached by ${percent(t.currentShare)} of your turns`;
  const yours = `your median is ${value(t.baseline.p50, t.kind)} and 99th percentile ${value(t.baseline.p99, t.kind)}`;
  if (t.suggested === undefined) return `${now}; ${yours}.`;
  if (t.suggested === t.current) return `${now}; ${yours}, so it's already at your tail.`;
  return `${now}; ${yours}, so ${value(t.suggested, t.kind)} would fire on about ${percent(t.suggestedShare ?? 0)}.`;
}

/**
 * A plain-text discovery report. It names command families and heuristic
 * ids, never targets, paths, prompts, or session names, so it's safe to paste.
 */
export function formatDiscovery(result: DiscoveryResult, source: string): string[] {
  const day = (ts?: string) => ts?.slice(0, 10) ?? '?';
  const lines = [`Discovery over ${source}: ${day(result.from)} to ${day(result.to)}, ${result.sessions} sessions, ${result.turns} turns.`];
  for (const note of result.notes) lines.push('', note);

  if (result.turns >= MIN_TURNS) {
    lines.push('', 'Candidate heuristics (turns far outside your own normal):');
    if (result.candidates.length === 0) lines.push('  None: nothing stands out from your usual turns.');
    for (const c of result.candidates) {
      const b = c.baseline;
      lines.push(
        `  ${c.rule.id}: turns with ${value(c.threshold, c.probe.kind)} or more ${c.probe.describes}, ${percent(c.turnsAbove / b.turns)} of your turns (${c.turnsAbove} in ${c.sessionsAbove} sessions); your median is ${value(b.p50, c.probe.kind)}, 99th percentile ${value(b.p99, c.probe.kind)}`
      );
      const overlaps = Object.entries(c.score.overlaps).map(([id, n]) => `${id} ${n}`);
      lines.push(`    replay: ${c.score.episodes} episodes in ${c.score.sessions} sessions${overlaps.length ? `; overlaps ${overlaps.join(', ')}` : '; no overlap with existing heuristics'}`);
    }
  }

  if (result.thresholds.length > 0) {
    lines.push('', 'Built-in thresholds against your history:');
    for (const t of result.thresholds) lines.push(`  ${thresholdLine(t)}`);
  }

  const shell = result.shell;
  lines.push('', `Shell sub-categories (${shell.shellCalls} plain shell calls):`);
  if (shell.candidates.length === 0) lines.push('  None: no command family takes a large share.');
  for (const c of shell.candidates) lines.push(`  ${c.category.id}: "${c.category.match.join('", "')}", ${percent(c.share)} of shell calls (${c.calls} in ${c.sessions} sessions)`);
  if (shell.candidates.length > 0) lines.push(`  Left in Shell command: ${percent(shell.leftShare)}`);
  return lines;
}
