import * as vscode from 'vscode';
import { AggregateSnapshot } from '../core/aggregate';
import { HealthIssue } from '../core/health';
import { Finding } from '../heuristics/types';
import { buildStatusBarText, buildBreakdownLines } from './format';

export function renderStatusBar(
  item: vscode.StatusBarItem,
  snapshot: AggregateSnapshot,
  health: HealthIssue[],
  findings: Finding[] = [],
  worstFinding?: Finding
): void {
  item.text = buildStatusBarText(snapshot, health, worstFinding);
  const tooltip = new vscode.MarkdownString('```\n' + buildBreakdownLines(snapshot, health, findings).join('\n') + '\n```');
  tooltip.isTrusted = false;
  item.tooltip = tooltip;
}
