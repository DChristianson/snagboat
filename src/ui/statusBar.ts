import * as vscode from 'vscode';
import { AggregateSnapshot } from '../core/aggregate';

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function renderStatusBar(item: vscode.StatusBarItem, snapshot: AggregateSnapshot): void {
  item.text = `$(pulse) ${formatCount(snapshot.totalTokens)} tokens`;

  const lines: string[] = ['**Snagboat**', ''];
  const agentIds = Object.keys(snapshot.perAgent).sort();
  if (agentIds.length === 0) {
    lines.push('No agent events recorded yet.');
  } else {
    lines.push('| Source | Tokens | Events |');
    lines.push('| --- | --- | --- |');
    for (const agent of agentIds) {
      const agg = snapshot.perAgent[agent];
      const tokenTotal =
        agg.tokens.input + agg.tokens.output + agg.tokens.cacheRead + agg.tokens.cacheCreation;
      lines.push(`| ${agent} | ${tokenTotal} | ${agg.eventCount} |`);
    }
  }
  lines.push('');
  lines.push(`Local edits: ${snapshot.localEditCount}`);

  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.isTrusted = false;
  item.tooltip = tooltip;
}

export function breakdownText(snapshot: AggregateSnapshot): string {
  const parts = Object.keys(snapshot.perAgent)
    .sort()
    .map((agent) => {
      const agg = snapshot.perAgent[agent];
      const tokenTotal =
        agg.tokens.input + agg.tokens.output + agg.tokens.cacheRead + agg.tokens.cacheCreation;
      return `${agent}: ${tokenTotal} tokens / ${agg.eventCount} events`;
    });
  parts.push(`local edits: ${snapshot.localEditCount}`);
  return `Total: ${snapshot.totalTokens} tokens. ${parts.join(', ')}`;
}
