import { Experiment, PeriodReport, Proposal, ReportRevision } from '@snagboat/schema';
import { parseReportAnswer, performanceReportMessages, ReportInput } from '../../advisor/performanceReport';
import { ProposalStore } from '../proposals';
import { CoreAdvisors, PendingApproval } from './advisorModels';
import { PeriodJob } from './periodJob';

/**
 * The model's part of a period report, and your review of it (docs/design/goal-tracking-lifecycle.md,
 * snagboat-79f.7.4 and .7).
 *
 * Answering: when a report is written, the core asks the model the advisor's persona.md names (`model`,
 * an advisor in snagboat.advisors offering "report-on-goal") for a summary, verdicts and at most three
 * proposals, checks the answer, adds the proposals to the advisor's log and the answer to the report as a
 * revision. With no `model` the report keeps the numbers only. The request goes through the core's usual
 * approval: the first one with a model's current address and sending rules waits for you.
 *
 * Reviewing: you mark each proposal in the latest revision accept, discard or revise (with a note), and can
 * switch until you send. Sending with any marked revise is Revise report: the core asks the model again with
 * your notes, and the next revision carries the accepted proposals over and adds one revised proposal per
 * note. Sending with none is Accept report, which hands the accepted proposals on (onAccepted: the
 * experiments, snagboat-79f.7.8). Every front end (the advisor UI, an agent through MCP) uses these same calls.
 */

export type Mark = 'accept' | 'discard' | 'revise';

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface ReportView {
  report: PeriodReport;
  /** The latest revision's proposals, accepted ones carried over included. */
  proposals: Proposal[];
  /** The proposals those revised ones replace, with your notes. */
  replaced: Proposal[];
  /** What you can do with the latest revision now. */
  /** Where the model's request for the next revision stands, since the core started: asking (approval: waiting for yours), failed, or not sent. */
  ask?: { state: 'asking' | 'failed' | 'not-sent'; at: string; error?: string; approval?: PendingApproval };
  review: { rev: number; state: 'numbers-only' | 'open' | 'revising' | 'accepted'; marked: number; unmarked: number; toRevise: number; send?: 'accept' | 'revise' };
}

export class AdvisorReports {
  private readonly inFlight = new Set<string>();
  /** The last model request per report, so the page can say why there's no answer yet. */
  private readonly asks = new Map<string, { state: 'asking' | 'failed' | 'not-sent'; at: string; error?: string }>();

  private withAsk(advisor: string, view: ReportView): ReportView {
    const a = this.asks.get(`${advisor}/${view.report.id}`);
    if (!a) return view;
    const approval = a.state === 'asking' ? this.models.pendingApproval() : undefined;
    return { ...view, ask: { ...a, ...(approval ? { approval } : {}) } };
  }

  constructor(
    readonly job: PeriodJob,
    readonly proposals: ProposalStore,
    private readonly models: CoreAdvisors,
    private readonly experiments: () => Experiment[] = () => [],
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => undefined,
    /** Accept report: the proposals you accepted, to apply and track. */
    private readonly onAccepted: (advisor: string, report: PeriodReport, accepted: Proposal[]) => Promise<void> | void = () => undefined
  ) {}

  private proposalsOf(advisor: string, report: PeriodReport, rev: number): Proposal[] {
    const r = report.revisions?.find((x) => x.rev === rev);
    return r ? this.proposals.byIds(advisor, r.proposals) : [];
  }

  /** A report, the proposals of its latest revision, and where its review stands. */
  view(advisor: string, id?: string): ReportView | undefined {
    const report = this.job.get(advisor, id);
    if (!report) return undefined;
    const latest = report.revisions?.[report.revisions.length - 1];
    if (!latest) return this.withAsk(advisor, { report, proposals: [], replaced: [], review: { rev: 0, state: 'numbers-only', marked: 0, unmarked: 0, toRevise: 0 } });
    const proposals = this.proposalsOf(advisor, report, latest.rev);
    const unmarked = proposals.filter((p) => p.status === 'open').length;
    const toRevise = proposals.filter((p) => p.status === 'revised').length;
    const state = latest.sent?.as === 'accept' ? 'accepted' : latest.sent?.as === 'revise' ? 'revising' : 'open';
    const replaced = this.proposals.byIds(advisor, proposals.map((p) => p.replaces).filter((id): id is string => !!id));
    return this.withAsk(advisor, { report, proposals, replaced, review: { rev: latest.rev, state, marked: proposals.length - unmarked, unmarked, toRevise, ...(state === 'open' && !unmarked ? { send: toRevise ? ('revise' as const) : ('accept' as const) } : {}) } });
  }

  /** The advisor a proposal belongs to, found by its id (which starts with the advisor's). */
  private advisorOf(proposalId: string): string {
    for (const a of this.job.advisors()) if (proposalId.startsWith(`${a.id}-`) && this.proposals.get(a.id, proposalId)) return a.id;
    throw new ReviewError(404, `no proposal ${proposalId}`);
  }

  /** Marks a proposal accept, discard or revise (with a note). Switchable until its revision is sent. */
  mark(proposalId: string, mark: Mark, note?: string): Proposal {
    const advisor = this.advisorOf(proposalId);
    const p = this.proposals.get(advisor, proposalId)!;
    const report = this.job.get(advisor, p.report);
    const latest = report?.revisions?.[report.revisions.length - 1];
    if (!report || !latest || !latest.proposals.includes(proposalId)) throw new ReviewError(409, `${proposalId} is not in its report's latest revision`);
    if (latest.sent) throw new ReviewError(409, `that revision was already sent (${latest.sent.as === 'accept' ? 'accepted' : 'sent back to revise'})`);
    if (latest.rev > p.rev && p.status === 'accepted') throw new ReviewError(409, 'an accepted proposal carried over from an earlier revision stays accepted');
    const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
    if (mark === 'revise' && !text) throw new ReviewError(400, 'say what to change: Revise needs a note');
    const type = mark === 'accept' ? 'accepted' : mark === 'discard' ? 'discarded' : 'revised';
    return this.proposals.mark(advisor, proposalId, type, { report: report.id, rev: latest.rev, ...(mark === 'revise' ? { note: text } : {}) });
  }

  /**
   * Sends the latest revision back: Accept report when no proposal is marked revise, Revise report when one
   * is. Every proposal must be marked first. Revise report asks the model in the background (it may wait for
   * your approval); the next revision shows in view() once it has answered. A revise that never got an
   * answer can be sent again.
   */
  async send(advisor: string, reportId: string | undefined, rev: number): Promise<{ as: 'accept' | 'revise'; view: ReportView }> {
    const view = this.view(advisor, reportId);
    if (!view) throw new ReviewError(404, `${advisor} has no report ${reportId ?? 'yet'}`);
    const { report, proposals } = view;
    const latest = report.revisions?.[report.revisions.length - 1];
    if (!latest) throw new ReviewError(409, 'this report has the numbers only; there is nothing to send');
    if (rev !== latest.rev) throw new ReviewError(409, `revision ${rev} is not the latest (${latest.rev})`);
    if (latest.sent?.as === 'accept') throw new ReviewError(409, 'this report was already accepted');
    if (view.review.unmarked) throw new ReviewError(400, `mark every proposal first: ${view.review.unmarked} not marked`);
    const toRevise = proposals.filter((p) => p.status === 'revised');
    const at = this.now().toISOString();
    if (!toRevise.length) {
      this.job.markSent(advisor, report.id, rev, { at, as: 'accept' });
      const accepted = proposals.filter((p) => p.status === 'accepted');
      await this.onAccepted(advisor, this.job.get(advisor, report.id)!, accepted);
      return { as: 'accept', view: this.view(advisor, report.id)! };
    }
    if (!latest.sent) this.job.markSent(advisor, report.id, rev, { at, as: 'revise' });
    const notes = toRevise.map((p) => ({ proposal: p, note: p.note ?? '' }));
    const accepted = proposals.filter((p) => p.status === 'accepted');
    void this.answer(advisor, report.id, { notes, accepted }).catch((err) => this.log(`report ${advisor} ${report.id}: revising: ${err instanceof Error ? err.message : String(err)}`));
    return { as: 'revise', view: this.view(advisor, report.id)! };
  }

  /**
   * Asks the advisor's model for the report's next revision. Undefined when the advisor has no model, the
   * request wasn't sent (not approved), or one is already under way; throws when the model can't answer.
   * revise: on Revise report, your notes and the proposals you accepted, which carry over.
   */
  async answer(advisorId: string, reportId: string, revise?: { notes: NonNullable<ReportInput['notes']>; accepted: Proposal[] }): Promise<ReportRevision | undefined> {
    const advisor = this.job.advisors().find((a) => a.id === advisorId);
    if (!advisor) throw new Error(`no advisor ${advisorId}`);
    if (!advisor.model) return undefined;
    const key = `${advisorId}/${reportId}`;
    if (this.inFlight.has(key)) return undefined;
    this.inFlight.add(key);
    this.asks.set(key, { state: 'asking', at: this.now().toISOString() });
    try {
      const report = this.job.get(advisorId, reportId);
      if (!report) throw new Error(`${advisorId} has no report ${reportId}`);
      const latest = report.revisions?.[report.revisions.length - 1];
      if (latest && !revise) return undefined; // answered already; a later revision comes only from Revise report
      const rev = (latest?.rev ?? 0) + 1;
      const input: Omit<ReportInput, 'policy'> = {
        advisor,
        report,
        experiments: this.experiments().filter((x) => x.advisor === advisorId),
        lastRound: this.lastRound(advisorId, report),
        discarded: this.proposals.discarded(advisorId),
        ...(revise ? { notes: revise.notes, accepted: revise.accepted } : {}),
      };
      const asked = await this.models.ask('report-on-goal', async (ctx) => performanceReportMessages({ ...input, policy: ctx.policy }), { advisorId: advisor.model });
      if (!asked) {
        this.asks.set(key, { state: 'not-sent', at: this.now().toISOString() });
        return undefined;
      }
      const parsed = parseReportAnswer(asked.completion.text, input);
      for (const p of parsed.problems) this.log(`report ${advisorId} ${reportId}: ${p}`);
      const added = this.proposals.propose(advisorId, report.id, rev, parsed.proposals);
      const revision: ReportRevision = {
        rev,
        createdAt: this.now().toISOString(),
        model: { advisor: asked.advisor.id, ...(asked.advisor.model ? { model: asked.advisor.model } : {}) },
        // A revision keeps the first answer's summary unless the model gives a new one.
        summary: parsed.summary || latest?.summary || report.summary,
        verdicts: parsed.verdicts.length || !latest ? parsed.verdicts : latest.verdicts,
        proposals: [...(revise?.accepted ?? []).map((p) => p.id), ...added.map((p) => p.id)],
      };
      this.job.addRevision(advisorId, report.id, revision);
      this.log(`report ${advisorId} ${reportId}: revision ${rev}, ${added.length} new proposal(s)`);
      this.asks.delete(key);
      return revision;
    } catch (err) {
      this.asks.set(key, { state: 'failed', at: this.now().toISOString(), error: err instanceof Error ? err.message : String(err) });
      throw err;
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
    return before && rev ? this.proposalsOf(advisor, before, rev) : [];
  }
}
