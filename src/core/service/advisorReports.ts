import { Experiment, PeriodReport, Proposal, ReportRevision } from '@snagboat/schema';
import { parseReportAnswer, performanceReportMessages, ReportInput } from '../../advisor/performanceReport';
import { ProposalStore } from '../proposals';
import { CoreAdvisors } from './advisorModels';
import { PeriodJob } from './periodJob';

/**
 * The model's part of a period report (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.4). When a
 * report is written, the core asks the model the advisor's persona.md names (`model`, an advisor in
 * snagboat.advisors offering "propose heuristics") for a summary, verdicts and at most three proposals,
 * checks the answer, adds the proposals to the advisor's log and the answer to the report as a revision.
 * With no `model` the report keeps the numbers only. The request goes through the core's usual approval:
 * the first one with a model's current address and sending rules waits for you in the advisor UI.
 */

export class AdvisorReports {
  private readonly inFlight = new Set<string>();

  constructor(
    readonly job: PeriodJob,
    readonly proposals: ProposalStore,
    private readonly models: CoreAdvisors,
    private readonly experiments: () => Experiment[] = () => [],
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => undefined
  ) {}

  /** A report and the proposals of its latest revision. */
  view(advisor: string, id?: string): { report: PeriodReport; proposals: Proposal[] } | undefined {
    const report = this.job.get(advisor, id);
    if (!report) return undefined;
    const rev = report.revisions?.length ?? 0;
    return { report, proposals: rev ? this.proposals.forReport(advisor, report.id, rev) : [] };
  }

  /**
   * Asks the advisor's model for the report's next revision. Undefined when the advisor has no model, the
   * request wasn't sent (not approved), or one is already under way; throws when the model can't answer.
   * notes: on Revise report, your notes by proposal (snagboat-79f.7.7).
   */
  async answer(advisorId: string, reportId: string, notes?: ReportInput['notes']): Promise<ReportRevision | undefined> {
    const advisor = this.job.advisors().find((a) => a.id === advisorId);
    if (!advisor) throw new Error(`no advisor ${advisorId}`);
    if (!advisor.model) return undefined;
    const key = `${advisorId}/${reportId}`;
    if (this.inFlight.has(key)) return undefined;
    this.inFlight.add(key);
    try {
      const report = this.job.get(advisorId, reportId);
      if (!report) throw new Error(`${advisorId} has no report ${reportId}`);
      const rev = (report.revisions?.length ?? 0) + 1;
      const input: Omit<ReportInput, 'policy'> = {
        advisor,
        report,
        experiments: this.experiments().filter((x) => x.advisor === advisorId),
        lastRound: this.lastRound(advisorId, report),
        discarded: this.proposals.discarded(advisorId),
        ...(notes?.length ? { notes } : {}),
      };
      const asked = await this.models.ask('propose-heuristics', async (ctx) => performanceReportMessages({ ...input, policy: ctx.policy }), { advisorId: advisor.model, json: true });
      if (!asked) return undefined;
      const parsed = parseReportAnswer(asked.completion.text, input);
      for (const p of parsed.problems) this.log(`report ${advisorId} ${reportId}: ${p}`);
      const added = this.proposals.propose(advisorId, report.id, rev, parsed.proposals);
      const revision: ReportRevision = {
        rev,
        createdAt: this.now().toISOString(),
        model: { advisor: asked.advisor.id, ...(asked.advisor.model ? { model: asked.advisor.model } : {}) },
        summary: parsed.summary || report.summary,
        verdicts: parsed.verdicts,
        proposals: added.map((p) => p.id),
      };
      this.job.addRevision(advisorId, report.id, revision);
      this.log(`report ${advisorId} ${reportId}: revision ${rev}, ${added.length} proposal(s)`);
      return revision;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Asks in the background, logging a failure: for the timer and for a report you asked for. */
  answerLater(advisorId: string, reportId: string): void {
    void this.answer(advisorId, reportId).catch((err) => this.log(`report ${advisorId} ${reportId}: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The proposals you last decided on: the latest revision of the report before this one. */
  private lastRound(advisor: string, report: PeriodReport): Proposal[] {
    const before = report.previous ? this.job.get(advisor, report.previous) : undefined;
    const rev = before?.revisions?.length ?? 0;
    return before && rev ? this.proposals.forReport(advisor, before.id, rev) : [];
  }
}
