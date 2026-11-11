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
  cue?: AdvisorGoal['cue'];
  notify: AdvisorGoal['notify'] & { /** Notifications under its rules in the hour before now. */ lastHour?: number };
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

/**
 * Each advisor's report. With `now`, how many notifications fell under its
 * rules in the hour before; with `seriesDays` too, each measure for each of the
 * last that many days (from `current`, which must cover them), for sparklines.
 */
export function advisorReports(advisors: AdvisorGoal[], current: NormalizedEvent[], previous: NormalizedEvent[], opts: { now?: Date; seriesDays?: number } = {}): AdvisorReport[] {
  const now = opts.now?.getTime();
  const days = opts.seriesDays && now !== undefined ? Array.from({ length: opts.seriesDays }, (_, i) => {
    const from = new Date(now - (opts.seriesDays! - i) * 86_400_000).toISOString();
    const to = new Date(now - (opts.seriesDays! - i - 1) * 86_400_000).toISOString();
    return current.filter((e) => e.ts >= from && e.ts < to);
  }) : undefined;
  return advisors.map((a) => {
    const { patterns, problems } = riskyPatterns(a.riskyCommands);
    const lastHour = now === undefined ? undefined : current.filter((e) => e.kind === 'outcome' && e.outcome?.type === 'notified' && e.outcome.advisor === a.id && Date.parse(e.ts) > now - 3_600_000).length;
    const measures = measure(a.measures, current, previous, { risky: patterns });
    if (days) {
      for (const m of measures) {
        if (m.note) continue;
        m.series = days.map((events) => measure([m.id], events, [], { risky: patterns })[0].value ?? null);
      }
    }
    return {
      id: a.id,
      name: a.name,
      goal: a.goal,
      version: a.version,
      source: a.source,
      ...(a.cue ? { cue: a.cue } : {}),
      notify: { ...a.notify, ...(lastHour !== undefined ? { lastHour } : {}) },
      measures,
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
