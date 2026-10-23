import * as vscode from 'vscode';
import { EventLog } from '../core/eventLog';
import { NormalizedEvent } from '../core/types';
import { dayStats, DayStats, isRetiredCopilotMetric, sourceFileOf } from './merge';
import { planBackfill } from './rebuild';

export interface BackfillDeps {
  eventLog: EventLog;
  /** Runs an operation on the storage queue shared with retention and Clear Event Log; resolves when it's done. */
  runStorageOp: (op: () => Promise<void>) => Promise<void>;
  /** Reloads every in-memory view of the log after the files change. */
  reloadFromLog: () => Promise<void>;
  /** The oldest day raw events are kept for (retention.rawDays); older days hold only daily totals. */
  oldestRawDay: () => string;
  captureContent: () => boolean;
  output: vscode.OutputChannel;
}

/** A day worth offering: it has re-readable sources or retired Copilot metric events. */
interface Candidate {
  day: string;
  events: NormalizedEvent[];
  stats: DayStats;
  needed: boolean;
}

function needsBackfill(events: NormalizedEvent[], s: DayStats): boolean {
  const prompts = events.some((e) => e.kind === 'user_prompt');
  const claudeCalls = events.some((e) => e.agent === 'claude-code' && e.kind === 'turn_stop' && e.tokens);
  return s.unlinkedCalls > 0 || s.retiredMetrics > 0 || (claudeCalls && s.toolCalls === 0) || (prompts && s.turnEnds === 0);
}

function describe(s: DayStats): string {
  const parts = [`${s.modelCalls} model calls, ${s.unlinkedCalls} unlinked`, `${s.toolCalls} tool calls`, `${s.turnEnds} turn ends`];
  if (s.retiredMetrics) parts.push(`${s.retiredMetrics} old Copilot metric events`);
  return parts.join(' · ');
}

const sum = (list: DayStats[], key: keyof DayStats) => list.reduce((n, s) => n + s[key], 0);
const fmt = (n: number) => n.toLocaleString();

/**
 * Snagboat: Backfill Sessions from Transcripts. Re-reads the session logs the
 * chosen days' events came from and rewrites those days, so history logged by
 * older builds gets turns, turn ends, and tool calls (see docs/roadmap.md).
 * Shows a dry run and asks before writing.
 */
export async function runBackfill(deps: BackfillDeps): Promise<void> {
  const { eventLog, output } = deps;
  await eventLog.flush();
  const candidates: Candidate[] = [];
  for (const day of (await eventLog.listDays()).reverse()) {
    const events = await eventLog.readDay(day);
    if (!events.some((e) => sourceFileOf(e) || isRetiredCopilotMetric(e))) continue;
    const stats = dayStats(events);
    candidates.push({ day, events, stats, needed: needsBackfill(events, stats) });
  }
  if (candidates.length === 0) {
    vscode.window.showInformationMessage('Snagboat: no logged days come from transcripts or session logs, so there is nothing to backfill.');
    return;
  }

  const picks = await vscode.window.showQuickPick(
    candidates.map((c) => ({ label: c.day, description: describe(c.stats), picked: c.needed, candidate: c })),
    { canPickMany: true, title: 'Backfill sessions: choose days to re-read', placeHolder: 'Days with unlinked calls, no tool calls or turn ends, or old Copilot metric events are selected' }
  );
  if (!picks || picks.length === 0) return;
  const chosen = picks.map((p) => p.candidate);

  const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Snagboat: re-reading transcripts…' }, () =>
    planBackfill(eventLog, new Map(chosen.map((c) => [c.day, c.events])), { captureContent: deps.captureContent(), oldestRawDay: deps.oldestRawDay() })
  );
  const moved = plan.days.filter((d) => !d.chosen);

  const before = plan.days.map((d) => d.stats);
  const after = plan.days.map((d) => d.after);
  const linked = (list: DayStats[]) => sum(list, 'modelCalls') - sum(list, 'unlinkedCalls');
  output.appendLine(`Backfill dry run, ${new Date().toLocaleString()}:`);
  for (const d of plan.days) output.appendLine(`  ${d.day}${d.chosen ? '' : ' (receives misfiled events)'}  before: ${describe(d.stats)}\n              after:  ${describe(d.after)}`);
  if (plan.rebuilt.missing.length) {
    output.appendLine(`  Source files no longer on disk (their events are kept as they are):`);
    for (const f of plan.rebuilt.missing) output.appendLine(`    ${f}`);
  }
  output.show(true);

  const lostExcerpts = !deps.captureContent() && plan.days.some((d) => d.events.some((e) => e.textExcerpt && sourceFileOf(e)));
  const detail = [
    `Model calls linked to a prompt: ${fmt(linked(before))} → ${fmt(linked(after))} (of ${fmt(sum(after, 'modelCalls'))})`,
    `Tool calls: ${fmt(sum(before, 'toolCalls'))} → ${fmt(sum(after, 'toolCalls'))}`,
    `Turn ends: ${fmt(sum(before, 'turnEnds'))} → ${fmt(sum(after, 'turnEnds'))}`,
    `Tokens: ${fmt(sum(before, 'tokens'))} → ${fmt(sum(after, 'tokens'))}`,
    moved.length ? `${moved.length} more day(s) receive events an older version filed under the wrong day.` : '',
    plan.rebuilt.missing.length ? `${plan.rebuilt.missing.length} source file(s) are gone; their events stay as they are.` : '',
    lostExcerpts ? 'snagboat.captureContent is off, so stored reply excerpts on these days will be removed.' : '',
    'Details are in the Snagboat output channel.',
  ]
    .filter(Boolean)
    .join('\n');
  const choice = await vscode.window.showInformationMessage(`Backfill ${chosen.length} day(s)?`, { modal: true, detail }, 'Backfill');
  if (choice !== 'Backfill') return;

  try {
    await deps.runStorageOp(async () => {
      try {
        for (const d of plan.days) {
          await eventLog.rewriteDay(d.day, (current) => plan.merge(d.day, current), { create: true });
        }
      } finally {
        // Even after a failed day, earlier days changed on disk.
        await deps.reloadFromLog();
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Snagboat: backfill failed: ${String(err)}`);
    return;
  }
  const summary = `backfilled ${chosen.length} day(s)${moved.length ? `, and moved misfiled events to ${moved.length} more` : ''}`;
  output.appendLine(`Snagboat ${summary}.`);
  vscode.window.showInformationMessage(`Snagboat: ${summary}.`);
}
