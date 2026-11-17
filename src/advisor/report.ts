import { NormalizedEvent } from '@snagboat/schema';
import { EventLogReader } from '../core/eventLog';
import { AdvisorGoal, AdvisorPeriod } from './goals';
import { measure, MeasureResult, riskyPatterns, trendOf } from './measures';
import { measureSummary } from './brief';

/**
 * Each advisor's goal and its measures over a period against the period before
 * (RFC step 4c), for `snagboat advisors`, the core's GET /advisors and the
 * weekly review.
 */

export interface AdvisorReport {
  id: string;
  name: string;
  goal: string;
  /** Its goal in plain words. */
  status: string;
  /** Who it is and its tone (persona.md's body). */
  voice: string;
  version: string;
  source: string;
  cue?: AdvisorGoal['cue'];
  notify: AdvisorGoal['notify'] & { /** Notifications under its rules in the hour before now. */ lastHour?: number };
  measures: MeasureResult[];
  problems: string[];
  /** The card's brief (brief.ts), when the caller asks for one workspace's. */
  brief?: import('./brief').Brief;
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

/** The events in each of `count` windows of `step` days ending at `now`, oldest first. */
export function buckets(events: NormalizedEvent[], now: Date, count: number, stepDays: number): NormalizedEvent[][] {
  const end = now.getTime() + 1;
  return Array.from({ length: count }, (_, i) => {
    const from = new Date(end - (count - i) * stepDays * 86_400_000).toISOString();
    const to = new Date(end - (count - i - 1) * stepDays * 86_400_000).toISOString();
    return events.filter((e) => e.ts >= from && e.ts < to);
  });
}

/**
 * Each advisor's report. With `now`, how many notifications fell under its
 * rules in the hour before; with `series`, each measure for each of those
 * windows of events (buckets()), oldest first, for sparklines and charts.
 */
export function advisorReports(advisors: AdvisorGoal[], current: NormalizedEvent[], previous: NormalizedEvent[], opts: { now?: Date; series?: NormalizedEvent[][] } = {}): AdvisorReport[] {
  const now = opts.now?.getTime();
  const days = opts.series;
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
      status: a.status,
      voice: a.voice,
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

// --- Period reports (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.2) -------------------------
//
// Each advisor reports once a period (its persona.md's `period`, weekly by default), or when you ask.
// A report covers the time since the advisor's last report, so scheduled and asked-for reports chain
// with no gap and no overlap, and "since last period" means since that stored report. Its measures and
// the rules in force are frozen when it's written: a baseline outlives the raw events it came from.

/** The start of the period holding `at`, in local time: midnight, Monday's midnight, or the 1st's. */
export function periodStart(period: AdvisorPeriod, at: Date): Date {
  const d = new Date(at.getFullYear(), at.getMonth(), period === 'monthly' ? 1 : at.getDate());
  if (period === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** The start of the period after the one starting at `start`. */
export function nextPeriod(period: AdvisorPeriod, start: Date): Date {
  const d = new Date(start);
  if (period === 'daily') d.setDate(d.getDate() + 1);
  else if (period === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/** The start of the period before the one starting at `start`. */
export function previousPeriod(period: AdvisorPeriod, start: Date): Date {
  const d = new Date(start);
  if (period === 'daily') d.setDate(d.getDate() - 1);
  else if (period === 'weekly') d.setDate(d.getDate() - 7);
  else d.setMonth(d.getMonth() - 1);
  return d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A period's name: 2026-11-15, 2026-W46 (ISO week) or 2026-11. */
export function periodLabel(period: AdvisorPeriod, start: Date): string {
  if (period === 'daily') return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  if (period === 'monthly') return `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
  // ISO week: the week's Thursday decides its year.
  const thursday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 3 - ((start.getDay() + 6) % 7));
  const jan4 = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${thursday.getFullYear()}-W${pad(week)}`;
}

/** The rules in force when a report was written: team settings (thresholds, rules, nudges) and saved rules. */
export interface RulesInForce {
  /** config.json defaults, team keys only. */
  defaults: Record<string, unknown>;
  /** config.json projects, team keys only, by folder. */
  projects: Record<string, Record<string, unknown>>;
  /** rules.json's saved rules, as written. */
  saved: unknown[];
}

export interface PeriodReport {
  version: 1;
  /** 2026-W46 for a scheduled report; 2026-W47-asked-1 for the first you asked for in that period. */
  id: string;
  advisor: string;
  /** The advisor's version (a hash of its persona.md) when the report was written. */
  advisorVersion: string;
  period: AdvisorPeriod;
  /** The period it falls in: 2026-W46. */
  label: string;
  /** Start, inclusive (ISO): the last report's end, or the period's start for an advisor's first. */
  from: string;
  /** End, exclusive (ISO). */
  to: string;
  trigger: 'schedule' | 'request';
  createdAt: string;
  /** The report before it, whose measures are this one's "before". */
  previous?: string;
  /** All workspaces together; `previous` is the last report's value. */
  measures: MeasureResult[];
  /** Each workspace with events in the report's time, the same measures. */
  workspaces: Array<{ workspace: string; measures: MeasureResult[] }>;
  rules: RulesInForce;
  /** Where the goal stands, in one line, from the numbers alone. */
  summary: string;
}

/** Measures for the report's events, with the last report's values (or, for a first report, `before`'s) as "before". */
function reportMeasures(a: AdvisorGoal, events: NormalizedEvent[], last: MeasureResult[] | undefined, before: NormalizedEvent[] | undefined): MeasureResult[] {
  const { patterns } = riskyPatterns(a.riskyCommands);
  const now = measure(a.measures, events, before ?? [], { risky: patterns });
  if (!last) return before ? now : now.map(({ previous: _p, trend: _t, ...m }) => m);
  return now.map((m) => {
    const { previous: _p, trend: _t, ...rest } = m;
    const prev = last.find((x) => x.id === m.id)?.value;
    if (m.note) return rest;
    const trend = trendOf(m.value, prev, m.better);
    return { ...rest, ...(prev !== undefined ? { previous: prev } : {}), ...(trend ? { trend } : {}) };
  });
}

/**
 * One period report. `events`: every workspace's events in [from, to); `before`: for an advisor's first
 * report, the events in the same length of time before it (later reports compare with `last`).
 */
export function buildPeriodReport(
  a: AdvisorGoal,
  w: { id: string; label: string; from: Date; to: Date; trigger: PeriodReport['trigger']; createdAt: Date },
  events: NormalizedEvent[],
  last: PeriodReport | undefined,
  rules: RulesInForce,
  before?: NormalizedEvent[]
): PeriodReport {
  const measures = reportMeasures(a, events, last?.measures, last ? undefined : before);
  const byWorkspace = new Map<string, NormalizedEvent[]>();
  for (const e of events) if (e.workspace) (byWorkspace.get(e.workspace) ?? byWorkspace.set(e.workspace, []).get(e.workspace)!).push(e);
  const workspaces = [...byWorkspace.keys()].sort().map((workspace) => {
    const lastHere = last?.workspaces.find((x) => x.workspace === workspace)?.measures;
    const beforeHere = before?.filter((e) => e.workspace === workspace);
    return { workspace, measures: reportMeasures(a, byWorkspace.get(workspace)!, last ? lastHere ?? [] : undefined, last ? undefined : beforeHere) };
  });
  return {
    version: 1,
    id: w.id,
    advisor: a.id,
    advisorVersion: a.version,
    period: a.period,
    label: w.label,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    trigger: w.trigger,
    createdAt: w.createdAt.toISOString(),
    ...(last ? { previous: last.id } : {}),
    measures,
    workspaces,
    rules,
    summary: measureSummary(measures),
  };
}
