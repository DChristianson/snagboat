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
  /** Start, inclusive (ISO). */
  from: string;
  /** End, exclusive (ISO). */
  to: string;
}

/** The last `days` × 24 hours up to `now`, and the same length before them (as the weekly review counts its 7 days). */
export function periods(now: Date, days: number): { current: Period; previous: Period } {
  const at = (offset: number) => new Date(now.getTime() - offset * 86_400_000).toISOString();
  // A millisecond past now, so an event stamped this instant is in.
  return { current: { from: at(days), to: new Date(now.getTime() + 1).toISOString() }, previous: { from: at(2 * days), to: at(days) } };
}

/** The events whose time is in the period, from the day files that can hold them. */
export async function eventsIn(logs: EventLogReader[], period: Period): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  const first = period.from.slice(0, 10);
  const last = period.to.slice(0, 10);
  for (const log of logs) {
    for (const day of await log.listDays()) {
      if (day < first || day > last) continue;
      for (const e of await log.readDay(day)) if (e.ts >= period.from && e.ts < period.to) out.push(e);
    }
  }
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

/**
 * Plain-text lines for one advisor, as the CLI and the review print them. For
 * the review (`redact`), no file paths or problem text (which can quote your
 * patterns): it promises none, and it may go to a model.
 */
export function reportLines(r: AdvisorReport, days: number, opts: { redact?: boolean } = {}): string[] {
  const width = Math.max(...r.measures.map((m) => m.label.length), 10);
  const source = r.source === 'built-in' ? '' : opts.redact ? ' (your persona.md)' : ` (${r.source})`;
  const lines = [`${r.name}: ${r.goal}${source}, version ${r.version}`];
  for (const m of r.measures) {
    if (m.note) {
      lines.push(`  ${m.label.padEnd(width)}  ${m.note}`);
      continue;
    }
    const before = m.previous === undefined ? '' : `, ${formatMeasure(m.previous, m.unit)} the ${days} days before${m.trend ? ` (${m.trend})` : ''}`;
    lines.push(`  ${m.label.padEnd(width)}  ${formatMeasure(m.value, m.unit)}${m.value === undefined ? ' (nothing to measure yet)' : ''}${before}`);
  }
  if (!opts.redact) for (const p of r.problems) lines.push(`  problem: ${p}`);
  else if (r.problems.length > 0) lines.push(`  ${r.problems.length} problem(s) in its persona.md: see \`snagboat advisors\``);
  return lines;
}
