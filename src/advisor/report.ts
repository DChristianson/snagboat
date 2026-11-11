import { NormalizedEvent } from '@snagboat/schema';
import { EventLogReader } from '../core/eventLog';
import { AdvisorGoal } from './goals';
import { measure, MeasureResult, riskyPatterns } from './measures';

/**
 * Each advisor's goal and its measures over a period against the period before
 * (RFC step 4c), for `snagboat advisors`, the core's GET /advisors and the
 * weekly review.
 */

export interface AdvisorReport {
  id: string;
  name: string;
  goal: string;
  version: string;
  source: string;
  notify: AdvisorGoal['notify'];
  measures: MeasureResult[];
  problems: string[];
}

export interface Period {
  /** First day (UTC, YYYY-MM-DD), inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

/** The last `days` days up to `now`, and the same number of days before them. */
export function periods(now: Date, days: number): { current: Period; previous: Period } {
  const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  return { current: { from: day(days - 1), to: day(0) }, previous: { from: day(2 * days - 1), to: day(days) } };
}

/** The events of the period's days from the logs. */
export async function eventsIn(logs: EventLogReader[], period: Period): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for (const log of logs) for (const day of await log.listDays()) if (day >= period.from && day <= period.to) out.push(...(await log.readDay(day)));
  return out;
}

export function advisorReports(advisors: AdvisorGoal[], current: NormalizedEvent[], previous: NormalizedEvent[]): AdvisorReport[] {
  return advisors.map((a) => {
    const { patterns, problems } = riskyPatterns(a.riskyCommands);
    return {
      id: a.id,
      name: a.name,
      goal: a.goal,
      version: a.version,
      source: a.source,
      notify: a.notify,
      measures: measure(a.measures, current, previous, { risky: patterns }),
      problems,
    };
  });
}

/** A measure's value for text: whole numbers when large, one decimal when small. */
export function formatMeasure(value: number | undefined, unit: string): string {
  if (value === undefined) return '—';
  const n = Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : (Math.round(value * 10) / 10).toString();
  return unit === '%' ? `${n}%` : unit ? `${n} ${unit}` : n;
}

/** Plain-text lines for one advisor, as the CLI and the review print them. */
export function reportLines(r: AdvisorReport, days: number): string[] {
  const width = Math.max(...r.measures.map((m) => m.label.length), 10);
  const lines = [`${r.name}: ${r.goal}${r.source === 'built-in' ? '' : ` (${r.source})`}, version ${r.version}`];
  for (const m of r.measures) {
    if (m.note) {
      lines.push(`  ${m.label.padEnd(width)}  ${m.note}`);
      continue;
    }
    const before = m.previous === undefined ? '' : `, ${formatMeasure(m.previous, m.unit)} the ${days} days before${m.trend ? ` (${m.trend})` : ''}`;
    lines.push(`  ${m.label.padEnd(width)}  ${formatMeasure(m.value, m.unit)}${m.value === undefined ? ' (nothing to measure yet)' : ''}${before}`);
  }
  for (const p of r.problems) lines.push(`  problem: ${p}`);
  return lines;
}
