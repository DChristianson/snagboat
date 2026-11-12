import { Finding } from '../heuristics/types';
import { Ahead } from './ahead';
import { MeasureResult } from './measures';
import { AdvisorReport, formatMeasure } from './report';
import type { FindingState } from '../core/service/responses';

/**
 * An advisor's brief for its card (RFC step 5a, the design pass as revised):
 * a one-line summary of where its goal stands, the one thing it's watching
 * most closely, and what it has to surface: a live finding under its rules
 * (notified, or held back by its hourly limit), a measure going the wrong way
 * with no finding yet, or nothing new. Worked out from its measures, the
 * workspace's findings and, for Navigator, the work ahead; no model.
 */

export interface Brief {
  summary: string;
  watching?: string;
  surface: {
    kind: 'notified' | 'held' | 'active' | 'suggest' | 'none';
    label: string;
    text: string;
    finding?: Pick<Finding, 'heuristicId' | 'severity' | 'summary' | 'suggestedAction'>;
    /** How you've met that finding (kept by the core). */
    state?: FindingState;
  };
  ahead?: Ahead;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function change(m: MeasureResult): number {
  if (m.value === undefined || m.previous === undefined) return 0;
  return m.previous === 0 ? Math.abs(m.value) : Math.abs(m.value - m.previous) / Math.abs(m.previous);
}

function phrase(m: MeasureResult): string {
  const value = formatMeasure(m.value, m.unit);
  if (m.previous === undefined || m.value === undefined) return `${lower(m.label)} ${value}`;
  if (m.trend === 'same') return `${lower(m.label)} steady at ${value}`;
  const dir = m.value > m.previous ? 'up' : 'down';
  const by = m.unit === '%' ? `${Math.abs(Math.round((m.value - m.previous) * 10) / 10)} points` : m.previous === 0 ? '' : `${Math.round(change(m) * 100)}%`;
  return `${lower(m.label)} ${dir}${by ? ` ${by}` : ''} to ${value}`;
}

export function advisorBrief(report: AdvisorReport, findings: Finding[], notifiedRecently: Set<string>, ahead?: Ahead, states: Record<string, FindingState> = {}): Brief {
  const measured = report.measures.filter((m) => m.value !== undefined && !m.note);
  const better = measured.filter((m) => m.trend === 'better');
  const worse = measured.filter((m) => m.trend === 'worse');

  let summary: string;
  if (measured.length === 0) summary = 'Nothing to measure yet in this period.';
  else {
    const lead = worse.length > better.length ? 'Slipping' : better.length > worse.length ? 'Improving' : 'Steady';
    const shown = [...measured].sort((a, b) => change(b) - change(a)).slice(0, 2);
    summary = `${lead}: ${shown.map(phrase).join(', ')}.`;
  }

  const worst = [...worse].sort((a, b) => change(b) - change(a))[0];
  let watching: string | undefined;
  if (ahead?.source === 'beads' && ahead.firstBlocked) {
    const on = ahead.firstBlocked.blockedBy.length ? ` on ${ahead.firstBlocked.blockedBy.join(', ')}` : '';
    watching = `${ahead.firstBlocked.id} "${ahead.firstBlocked.title}" is blocked${on}, so nothing behind it can start${worst ? `; then ${phrase(worst)}` : ''}.`;
  } else if (worst) watching = `${worst.label}: ${phrase(worst).replace(lower(worst.label) + ' ', '')}.`;

  // A muted heuristic's findings aren't surfaced.
  const mine = findings.filter((f) => report.notify.rules.includes(f.heuristicId) && !states[f.heuristicId]?.muted).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
  let surface: Brief['surface'];
  if (mine.length > 0) {
    const f = mine[0];
    const finding = { heuristicId: f.heuristicId, severity: f.severity, summary: f.summary, ...(f.suggestedAction ? { suggestedAction: f.suggestedAction } : {}) };
    const state = states[f.heuristicId];
    const max = report.notify.maxPerHour;
    const used = report.notify.lastHour ?? 0;
    if (max !== undefined && used >= max && !notifiedRecently.has(f.heuristicId)) surface = { kind: 'held', label: 'Held back', text: `Over its notification limit (${used} of ${max} this hour).`, finding };
    else if (notifiedRecently.has(f.heuristicId)) surface = { kind: 'notified', label: 'Notified', text: '', finding };
    else surface = { kind: 'active', label: 'Active', text: '', finding };
    if (state) surface.state = state;
  } else if (worst) {
    surface = { kind: 'suggest', label: 'Surface', text: `${worst.label} is going the wrong way with no finding yet.` };
  } else surface = { kind: 'none', label: 'Nothing new', text: '' };

  return { summary, ...(watching ? { watching } : {}), surface, ...(ahead ? { ahead } : {}) };
}
