import * as vscode from 'vscode';
import { AggregateSnapshot } from '../core/aggregate';
import { HealthIssue } from '../core/health';
import { buildStatusBarText, buildBreakdownLines } from './format';

export function renderStatusBar(item: vscode.StatusBarItem, snapshot: AggregateSnapshot, health: HealthIssue[]): void {
  item.text = buildStatusBarText(snapshot, health);
  const tooltip = new vscode.MarkdownString('```\n' + buildBreakdownLines(snapshot, health).join('\n') + '\n```');
  tooltip.isTrusted = false;
  item.tooltip = tooltip;
}
