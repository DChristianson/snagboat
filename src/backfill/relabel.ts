import * as vscode from 'vscode';
import { EventLog } from '../core/eventLog';
import { relabelShellCalls } from './merge';

export interface RelabelDeps {
  eventLog: EventLog;
  runStorageOp(op: () => Promise<void>): Promise<void>;
  reloadFromLog(): Promise<void>;
}

/** Snagboat: Relabel Shell Calls. Counts first, asks, then rewrites only the days that change. */
export async function runRelabel(deps: RelabelDeps): Promise<void> {
  const { eventLog } = deps;
  await eventLog.flush();
  const days: string[] = [];
  let total = 0;
  for (const day of await eventLog.listDays()) {
    const { changed } = relabelShellCalls(await eventLog.readDay(day));
    if (changed > 0) {
      days.push(day);
      total += changed;
    }
  }
  if (total === 0) {
    void vscode.window.showInformationMessage("Snagboat: this workspace's shell calls already match the shell categories in use.");
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Relabel ${total.toLocaleString()} shell call${total === 1 ? '' : 's'} over ${days.length} day${days.length === 1 ? '' : 's'}?`,
    { modal: true, detail: "Past shell calls in this workspace's log get the shell categories in use now. Other workspaces keep their own labels until you relabel there." },
    'Relabel'
  );
  if (choice !== 'Relabel') return;
  try {
    await deps.runStorageOp(async () => {
      try {
        for (const day of days) await eventLog.rewriteDay(day, (current) => relabelShellCalls(current).events);
      } finally {
        await deps.reloadFromLog();
      }
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Snagboat: relabelling failed: ${String(err)}`);
    return;
  }
  void vscode.window.showInformationMessage(`Snagboat: relabelled ${total.toLocaleString()} shell call${total === 1 ? '' : 's'}.`);
}
