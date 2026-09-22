import { AggregateSnapshot, AgentAggregate } from '../core/aggregate';
import { HealthIssue } from '../core/health';
import { Finding } from '../heuristics/types';

export function formatCount(n: number): string {
  if (n >= 1000) {
    const scaled = n / 1000;
    return `${scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
  }
  return String(n);
}

/** Sum of eventCount across every agent except generic-fs (local edits are reported separately). */
export function agentEventTotal(snapshot: AggregateSnapshot): number {
  return Object.entries(snapshot.perAgent)
    .filter(([agent]) => agent !== 'generic-fs')
    .reduce((sum, [, agg]) => sum + agg.eventCount, 0);
}

export function tokenTotal(agg: AgentAggregate): number {
  return agg.tokens.input + agg.tokens.output + agg.tokens.cacheRead + agg.tokens.cacheCreation;
}

function formatByKind(agg: AgentAggregate): string {
  const kinds = Object.entries(agg.eventCountByKind).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length === 0) return '—';
  return kinds.map(([kind, count]) => `${kind}: ${count}`).join(', ');
}

// Per README's planned status indicators table: keep the glyph meaningful but
// non-essential -- the visible text (via buildBreakdownLines/summary) already
// says what's wrong without it.
const FINDING_GLYPHS: Record<string, string> = {
  backtracking: '$(history)',
  'tool-churn': '$(sync)',
  'token-budget': '$(dashboard)',
  stalled: '$(clock)',
};

function findingGlyph(heuristicId: string): string {
  return FINDING_GLYPHS[heuristicId] ?? '$(pulse)';
}

export function buildStatusBarText(snapshot: AggregateSnapshot, health: HealthIssue[], worstFinding?: Finding): string {
  // Health takes priority over a behavioral finding: it means Snagboat itself
  // isn't working right, which is more urgent than something it noticed.
  const icon = health.length > 0 ? '$(warning)' : worstFinding ? findingGlyph(worstFinding.heuristicId) : '$(pulse)';
  const events = agentEventTotal(snapshot);
  const base = `${icon} ${formatCount(snapshot.totalTokens)} tokens · ${formatCount(events)} events · ${formatCount(snapshot.localEditCount)} edits`;
  return worstFinding ? `${base} · ${worstFinding.summary}` : base;
}

/** Plain-text lines shared by the status bar tooltip and the Output Channel breakdown. */
export function buildBreakdownLines(snapshot: AggregateSnapshot, health: HealthIssue[], findings: Finding[] = []): string[] {
  const lines: string[] = ['Snagboat', ''];
  const agentIds = Object.keys(snapshot.perAgent).sort();

  if (agentIds.length === 0) {
    lines.push('No agent events recorded yet.');
  } else {
    for (const agent of agentIds) {
      const agg = snapshot.perAgent[agent];
      lines.push(`${agent}:`);
      lines.push(
        `  Tokens: ${tokenTotal(agg)} total (${agg.tokens.input} in, ${agg.tokens.output} out, ${agg.tokens.cacheRead} cache-read, ${agg.tokens.cacheCreation} cache-create)`
      );
      lines.push(`  Events: ${agg.eventCount} (${formatByKind(agg)})`);
      lines.push('');
    }
  }

  lines.push('Total:');
  lines.push(`  Tokens: ${snapshot.totalTokens}`);
  lines.push(`  Events: ${agentEventTotal(snapshot)}`);
  lines.push(`  Local edits: ${snapshot.localEditCount}`);

  if (findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    for (const finding of findings) {
      lines.push(`  [${finding.severity}] ${finding.heuristicId}: ${finding.summary}`);
      if (finding.suggestedAction) {
        lines.push(`    -> ${finding.suggestedAction}`);
      }
    }
  }

  if (health.length > 0) {
    lines.push('');
    lines.push('Health:');
    for (const issue of health) {
      lines.push(`  ⚠ ${issue.source}: ${issue.message}`);
    }
  }

  return lines;
}
