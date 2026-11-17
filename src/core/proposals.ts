import * as fs from 'fs';
import * as path from 'path';
import { Proposal, ProposalEvent } from '@snagboat/schema';
import { ProposalDraft } from '../advisor/performanceReport';

/**
 * An advisor's proposal log (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.4):
 * ~/.snagboat/advisors/<id>/proposals.jsonl, append only. Each proposal is one `proposed` line with its
 * change, then a line for each thing you did with it: accepted, discarded, revised (with a note), kept,
 * closed. Folding the lines gives each proposal's state. A revised proposal's answer is a new proposal
 * that names it in `replaces`, so every proposal stays one record and the chain of revisions is kept.
 */

export class ProposalStore {
  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private file(advisor: string): string {
    return path.join(this.home, 'advisors', advisor, 'proposals.jsonl');
  }

  /** Every line, oldest first; unreadable lines are skipped. */
  events(advisor: string): ProposalEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file(advisor), 'utf8');
    } catch {
      return [];
    }
    const out: ProposalEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ProposalEvent;
        if (e && e.version === 1 && typeof e.proposal === 'string' && typeof e.type === 'string') out.push(e);
      } catch {
        // a torn last line from a crash: skipped
      }
    }
    return out;
  }

  /** Every proposal, folded from its lines, in the order proposed. */
  list(advisor: string): Proposal[] {
    const byId = new Map<string, Proposal>();
    for (const e of this.events(advisor)) {
      if (e.type === 'proposed') {
        if (!e.change || !e.scope || !e.prediction || !e.report) continue;
        byId.set(e.proposal, {
          id: e.proposal,
          advisor: e.advisor,
          report: e.report,
          rev: e.rev ?? 1,
          title: e.title ?? '',
          change: e.change,
          scope: e.scope,
          what: e.what ?? '',
          why: e.why ?? '',
          prediction: e.prediction,
          ...(e.replaces ? { replaces: e.replaces } : {}),
          status: 'open',
          proposedAt: e.at,
          updatedAt: e.at,
        });
        continue;
      }
      const p = byId.get(e.proposal);
      if (!p) continue;
      p.status = e.type;
      p.updatedAt = e.at;
      if (e.type === 'revised') p.note = e.note;
    }
    return [...byId.values()];
  }

  get(advisor: string, id: string): Proposal | undefined {
    return this.list(advisor).find((p) => p.id === id);
  }

  /** Proposals by id, in the order given (a report revision's list, which carries accepted ones over). */
  byIds(advisor: string, ids: string[]): Proposal[] {
    const all = new Map(this.list(advisor).map((p) => [p.id, p]));
    return ids.map((id) => all.get(id)).filter((p): p is Proposal => !!p);
  }

  /** Every change you discarded, so the advisor never suggests it again. */
  discarded(advisor: string): Proposal[] {
    return this.list(advisor).filter((p) => p.status === 'discarded');
  }

  /** Adds the proposals of one report revision; returns them with their ids. */
  propose(advisor: string, report: string, rev: number, drafts: ProposalDraft[]): Proposal[] {
    const at = this.now().toISOString();
    const lines: ProposalEvent[] = drafts.map((d, i) => ({
      version: 1,
      at,
      proposal: `${advisor}-${report}-r${rev}-p${i + 1}`,
      advisor,
      type: 'proposed',
      report,
      rev,
      title: d.title,
      change: d.change,
      scope: d.scope,
      what: d.what,
      why: d.why,
      prediction: d.prediction,
      ...(d.replaces ? { replaces: d.replaces } : {}),
    }));
    this.append(advisor, lines);
    const ids = new Set(lines.map((l) => l.proposal));
    return this.list(advisor).filter((p) => ids.has(p.id));
  }

  /** Records what you did with a proposal. */
  mark(advisor: string, id: string, type: Exclude<ProposalEvent['type'], 'proposed'>, extra: { note?: string; report?: string; rev?: number } = {}): Proposal {
    const p = this.get(advisor, id);
    if (!p) throw new Error(`no proposal ${id}`);
    this.append(advisor, [{ version: 1, at: this.now().toISOString(), proposal: id, advisor, type, ...extra }]);
    return this.get(advisor, id)!;
  }

  private append(advisor: string, lines: ProposalEvent[]): void {
    if (!lines.length) return;
    fs.mkdirSync(path.dirname(this.file(advisor)), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file(advisor), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
  }
}
