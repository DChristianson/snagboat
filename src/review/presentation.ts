import { Aggregate } from '../core/aggregate';
import { FindingsRegistry } from '../heuristics/findingsRegistry';
import { ResponseStats } from '../heuristics/responses';
import { ReplayEpisode } from '../heuristics/replay';
import { Finding } from '../heuristics/types';
import { buildBreakdownLines, buildStatusBarText } from '../ui/format';

/**
 * The presentation review without a model: replay takes your history to the
 * moments that mattered (a warning active, or several findings at once),
 * rebuilds what the status bar showed then with the same code that draws it,
 * and runs fixed checks over those snapshots. Snapshots carry heuristic ids
 * and severities, never summaries (which can hold paths) or session names.
 * See docs/design/trusted-advisor.md#presentation-review.
 */

export interface Moment {
  at: string;
  /** Active findings in the order their episodes began, which is the order the status bar's tooltip lists them. */
  active: Array<{ heuristicId: string; severity: 'info' | 'warn' }>;
}

export interface UiSnapshot {
  moment: Moment;
  /** The status bar's text, its counts shown as …; a finding's summary appears as «heuristic-id». */
  statusBar: string;
  /** The tooltip's Findings section, in order. */
  tooltip: string[];
}

export interface CheckResult {
  id: 'warning-not-first' | 'count-hidden' | 'no-notification';
  title: string;
  /** Moments it was true at, out of the moments looked at. */
  moments: number;
  example: UiSnapshot;
  /** A setting to change, or a change to Snagboat worded so it can be filed as an issue. */
  recommendation: string;
}

const MAX_MOMENTS = 40;

/** Moments worth a look: each episode's start where a warning or two or more findings were active, one per distinct set, latest first. */
export function momentsFrom(episodes: ReplayEpisode[], muted: Set<string> = new Set()): Moment[] {
  const shown = episodes.filter((e) => !muted.has(e.heuristicId));
  const seen = new Set<string>();
  const out: Moment[] = [];
  for (const at of [...new Set(shown.map((e) => e.startTs))].sort().reverse()) {
    const active = shown
      .filter((e) => e.startTs <= at && at <= e.endTs)
      .sort((a, b) => a.startTs.localeCompare(b.startTs))
      .map((e) => ({ heuristicId: e.heuristicId, severity: e.severity }));
    // One entry per heuristic, as the registry keeps them.
    const unique = active.filter((a, i) => active.findIndex((b) => b.heuristicId === a.heuristicId) === i);
    if (!unique.some((a) => a.severity === 'warn') && unique.length < 2) continue;
    const key = unique.map((a) => `${a.heuristicId}:${a.severity}`).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at, active: unique });
    if (out.length >= MAX_MOMENTS) break;
  }
  return out;
}

/** What the status bar showed at a moment, rebuilt with the registry and formatting the extension uses. */
export function snapshotAt(moment: Moment): UiSnapshot {
  const registry = new FindingsRegistry();
  for (const a of moment.active) {
    const finding: Finding = { heuristicId: a.heuristicId, severity: a.severity, summary: `«${a.heuristicId}»`, eventRefs: [], detectedAt: moment.at };
    registry.report(a.heuristicId, [finding]);
  }
  const empty = new Aggregate().snapshot();
  const lines = buildBreakdownLines(empty, [], registry.visible(), empty);
  const start = lines.indexOf('Findings:');
  return {
    moment,
    // The counts are the empty placeholder's; only the icon and the finding matter here.
    statusBar: buildStatusBarText(empty, [], registry.worst()).replace(/\d+ tokens today · \d+ events · \d+ edits/, '…'),
    tooltip: start < 0 ? [] : lines.slice(start + 1).filter((l) => l.startsWith('  [')).map((l) => l.trim()),
  };
}

/** Fixed checks over the moments; each result names how often it held and shows one example. */
export function presentationChecks(moments: Moment[], responses: Map<string, ResponseStats>, notifying = false): CheckResult[] {
  const snapshots = moments.map(snapshotAt);
  const results: CheckResult[] = [];

  const warningLate = snapshots.filter((s) => {
    const first = s.moment.active.findIndex((a) => a.severity === 'warn');
    return first > 0 && s.moment.active.slice(0, first).some((a) => a.severity === 'info');
  });
  if (warningLate.length > 0) {
    results.push({
      id: 'warning-not-first',
      title: 'A warning was listed after infos in the status bar tooltip',
      moments: warningLate.length,
      example: warningLate[0],
      recommendation: 'Status bar tooltip: list findings by severity, warnings first, rather than in the order they started. Seen when a warning began after an info was already active.',
    });
  }

  const countHidden = snapshots.filter((s) => s.moment.active.length >= 2);
  if (countHidden.length > 0) {
    results.push({
      id: 'count-hidden',
      title: 'Several findings were active, but the status bar text showed one',
      moments: countHidden.length,
      example: countHidden[0],
      recommendation: 'Status bar: show how many findings are active (for example "· 3 findings"), so one info and two warnings don\'t look alike until you hover.',
    });
  }

  const warnings = snapshots.filter((s) => s.moment.active.some((a) => a.severity === 'warn'));
  if (warnings.length > 0 && !notifying) {
    const warnStats = [...responses.values()].filter((r) => r.warnings > 0);
    const expired = warnStats.reduce((n, r) => n + r.expiredUnacknowledged, 0);
    const total = warnStats.reduce((n, r) => n + r.episodes, 0);
    results.push({
      id: 'no-notification',
      title: 'Warnings only appeared in the status bar, with notifications off',
      moments: warnings.length,
      example: warnings[0],
      recommendation: `Setting: set snagboat.nudges.notify to "warnings", so a warning (and an early warning) shows a notification, at most one per turn; snagboat.nudges.quiet keeps any heuristic out of it.${total > 0 ? ` In your recorded responses, ${expired} of ${total} episodes of heuristics that warn ended without being acknowledged.` : ''}`,
    });
  }
  return results;
}
