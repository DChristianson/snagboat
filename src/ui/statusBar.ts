import * as vscode from 'vscode';
import { AggregateSnapshot } from '../core/aggregate';
import { HealthIssue } from '../core/health';
import { Finding } from '../heuristics/types';
import { buildStatusBarText, buildBreakdownLines, WaitingLink, waitingText } from './format';

export function renderStatusBar(
  item: vscode.StatusBarItem,
  snapshot: AggregateSnapshot,
  health: HealthIssue[],
  today: AggregateSnapshot,
  findings: Finding[] = [],
  worstFinding?: Finding,
  waiting: WaitingLink[] = []
): void {
  item.text = buildStatusBarText(today, health, worstFinding);
  // Advisors with proposals waiting come first; the advisor UI (findings view) is where to review them.
  const lines = [...waiting.map(waitingText), ...(waiting.length ? [''] : []), ...buildBreakdownLines(snapshot, health, findings, today)];
  const tooltip = new vscode.MarkdownString('```\n' + lines.join('\n') + '\n```');
  tooltip.isTrusted = false;
  item.tooltip = tooltip;
}
