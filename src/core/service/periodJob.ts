import * as fs from 'fs';
import * as path from 'path';
import { Experiment, ReportRevision } from '@snagboat/schema';
import { AdvisorGoal, loadAdvisorGoals } from '../../advisor/goals';
import { buildPeriodReport, eventsIn, nextPeriod, periodLabel, PeriodReport, periodStart, previousPeriod, RulesInForce } from '../../advisor/report';
import { RuleStore } from '../../heuristics/ruleStore';
import { isTeamKey, loadConfig } from '../config';
import { EventLog } from '../eventLog';
import { listUserStores } from '../userStore';

/**
 * Period reports in the core (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.2). Each advisor
 * reports once a period, or when you ask; the core writes each report once, to
 * ~/.snagboat/advisors/<id>/periods/<report id>.json. Its measures and rules are frozen: the only later
 * changes are the model's answers, added as revisions (addRevision), and how each was sent back. There's no job runner: the
 * core checks hourly while it's up, and on start it catches up the periods that closed while it was
 * down (at most MAX_CATCH_UP of them per advisor).
 *
 * No model yet: a report is the numbers and the rules in force, with a one-line summary from them.
 */

export const PERIOD_CHECK_MS = 60 * 60_000;
/** Periods caught up at once per advisor; a longer gap is covered by the earliest of them. */
export const MAX_CATCH_UP = 8;

const REPORT_ID = /^[0-9]{4}-[0-9A-Za-z-]+$/;

export class PeriodJob {
  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => undefined,
    /** The experiments each report judges (snagboat-79f.7.11). */
    private readonly experiments: () => Experiment[] = () => []
  ) {}

  private dir(advisor: string): string {
    return path.join(this.home, 'advisors', advisor, 'periods');
  }

  /** An advisor's reports, oldest first. */
  list(advisor: string): PeriodReport[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir(advisor)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: PeriodReport[] = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir(advisor), f), 'utf8')) as PeriodReport;
        if (r && r.version === 1 && typeof r.to === 'string') out.push(r);
      } catch (err) {
        this.log(`period report ${f} for ${advisor} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out.sort((a, b) => a.to.localeCompare(b.to) || a.createdAt.localeCompare(b.createdAt));
  }

  /** One report by id, or the latest. */
  get(advisor: string, id?: string): PeriodReport | undefined {
    const all = this.list(advisor);
    return id === undefined ? all[all.length - 1] : all.find((r) => r.id === id);
  }

  /** Adds the model's answer to a report as its next revision. Nothing else in the report changes. */
  addRevision(advisor: string, id: string, revision: ReportRevision): PeriodReport {
    const report = this.readFile(advisor, id);
    const revisions = report.revisions ?? [];
    if (revision.rev !== revisions.length + 1) throw new Error(`${advisor} ${id} is at revision ${revisions.length}; can't add ${revision.rev}`);
    return this.replaceFile(advisor, id, { ...report, revisions: [...revisions, revision] });
  }

  /** Records how a revision was sent back: accept report, or revise report (snagboat-79f.7.7). */
  markSent(advisor: string, id: string, rev: number, sent: NonNullable<ReportRevision['sent']>): PeriodReport {
    const report = this.readFile(advisor, id);
    const revisions = (report.revisions ?? []).map((r) => (r.rev === rev ? { ...r, sent } : r));
    if (!revisions.some((r) => r.rev === rev)) throw new Error(`${advisor} ${id} has no revision ${rev}`);
    return this.replaceFile(advisor, id, { ...report, revisions });
  }

  private readFile(advisor: string, id: string): PeriodReport {
    if (!REPORT_ID.test(id)) throw new Error(`no report ${id}`);
    return JSON.parse(fs.readFileSync(path.join(this.dir(advisor), `${id}.json`), 'utf8')) as PeriodReport;
  }

  private replaceFile(advisor: string, id: string, report: PeriodReport): PeriodReport {
    const file = path.join(this.dir(advisor), `${id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return report;
  }

  /** The goal advisors: the built-ins and your persona.md files. */
  advisors(): AdvisorGoal[] {
    const { advisors, problems } = loadAdvisorGoals(path.join(this.home, 'advisors'));
    for (const p of problems) this.log(`advisor: ${p}`);
    return advisors;
  }

  /** Writes every report that's due: the periods that closed since each advisor's last report. Returns what it wrote. */
  async runDue(): Promise<PeriodReport[]> {
    const written: PeriodReport[] = [];
    const now = this.now();
    for (const a of this.advisors()) {
      let last = this.get(a.id);
      const current = periodStart(a.period, now);
      if (!last) {
        // First report: the period that just closed, against the one before it.
        const from = previousPeriod(a.period, current);
        written.push(await this.write(a, { from, to: current, label: periodLabel(a.period, from), trigger: 'schedule' }, undefined));
        continue;
      }
      // The periods that closed since the last report ended, the oldest first.
      const ends: Date[] = [];
      for (let end = nextPeriod(a.period, periodStart(a.period, new Date(last.to))); end <= now; end = nextPeriod(a.period, end)) ends.push(end);
      if (ends.length > MAX_CATCH_UP) ends.splice(0, ends.length - MAX_CATCH_UP);
      let from = new Date(last.to);
      for (const end of ends) {
        const start = previousPeriod(a.period, end);
        const label = periodLabel(a.period, start);
        if (this.get(a.id, label)) {
          from = end;
          continue;
        }
        last = await this.write(a, { from, to: end, label, trigger: 'schedule' }, last);
        written.push(last);
        from = end;
      }
    }
    for (const r of written) this.log(`period report ${r.advisor} ${r.id}`);
    return written;
  }

  /** A report now, on request: from the advisor's last report (or its period's start) to now. */
  async request(advisorId: string): Promise<PeriodReport> {
    const a = this.advisors().find((x) => x.id === advisorId);
    if (!a) throw new Error(`no advisor ${advisorId}`);
    // Close any period that's due first, so the asked-for report starts where the last one ended.
    await this.runDue();
    const last = this.get(a.id);
    const now = this.now();
    const start = periodStart(a.period, now);
    const from = last ? new Date(last.to) : start;
    const report = await this.write(a, { from, to: now, label: periodLabel(a.period, start), trigger: 'request' }, last);
    this.log(`period report ${report.advisor} ${report.id} (asked for)`);
    return report;
  }

  private async write(a: AdvisorGoal, w: { from: Date; to: Date; label: string; trigger: PeriodReport['trigger'] }, last: PeriodReport | undefined): Promise<PeriodReport> {
    const logs = listUserStores(this.home).map((s) => new EventLog(s.dir));
    const span = (from: Date, to: Date) => ({ from: from.toISOString(), to: to.toISOString() });
    const events = await eventsIn(logs, span(w.from, w.to));
    const before = last ? undefined : await eventsIn(logs, span(new Date(2 * w.from.getTime() - w.to.getTime()), w.from));
    let id = w.label;
    if (w.trigger === 'request') {
      let n = 1;
      while (fs.existsSync(path.join(this.dir(a.id), `${w.label}-asked-${n}.json`))) n++;
      id = `${w.label}-asked-${n}`;
    }
    if (!REPORT_ID.test(id)) throw new Error(`bad report id ${id}`);
    const report = buildPeriodReport(a, { id, label: w.label, from: w.from, to: w.to, trigger: w.trigger, createdAt: this.now() }, events, last, await this.rulesInForce(), before, this.experiments());
    fs.mkdirSync(this.dir(a.id), { recursive: true, mode: 0o700 });
    // Written once: 'wx' fails rather than replace a report already there.
    fs.writeFileSync(path.join(this.dir(a.id), `${id}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return report;
  }

  private async rulesInForce(): Promise<RulesInForce> {
    const { config } = loadConfig(this.home);
    const team = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => isTeamKey(k)));
    const projects: Record<string, Record<string, unknown>> = {};
    for (const [folder, settings] of Object.entries(config.projects)) {
      const t = team(settings);
      if (Object.keys(t).length) projects[folder] = t;
    }
    const store = new RuleStore(this.home);
    await store.load().catch(() => undefined);
    return { defaults: team(config.defaults), projects, saved: store.source().rules };
  }
}
