import * as fs from 'fs';
import * as path from 'path';
import { buildSessionView, EventOutcome, NormalizedEvent, OutcomeType, SessionIndex, SessionSummary, SessionView } from '@snagboat/schema';
import { EventLog } from '../eventLog';
import { workspaceStoreDir } from '../userStore';
import { FindingReplay } from '../../heuristics/replay';
import { LiveFinding, sessionFindings } from '../../heuristics/sessionFindings';
import { buildExplorerState, ExplorerState } from '../../ui/explorerModel';
import { EXPLORE_SESSION_CAP } from '../../ui/visualizers';
import { FindingsService } from './findings';
import { FindingState } from './responses';

/**
 * Sessions in the advisor UI (RFC step 5b): the session list, one session with
 * what came of it, and the Explore tab's sessions, worked out by the core from
 * a workspace's store so no front door needs VS Code to read them.
 *
 * A session's view is built as VS Code's Sessions tab builds it (its events in
 * time order, a fresh replay of the workspace's own heuristics and settings,
 * buildSessionView with the core's context marks), and carries the session's
 * outcomes: tests going green, its commits and what became of them, how you met
 * its findings, approvals. Outcomes are filed under the session they're about
 * but can be written days later (a commit kept at 7 days), so the list comes
 * from one pass over every day file, kept until a day file changes.
 */

/** An outcome on a session page: when it was recorded, and what. */
export type SessionOutcome = { ts: string } & EventOutcome;

export type OutcomeCounts = Partial<Record<OutcomeType, number>>;

export interface SessionListItem extends SessionSummary {
  /** How many of each outcome the session has. */
  outcomes: OutcomeCounts;
}

export interface SessionPage {
  workspace: string;
  view: SessionView;
  /** Oldest first. */
  outcomes: SessionOutcome[];
  /** How you've met the findings reporting now (for their buttons), and every muted heuristic. */
  responses: Record<string, FindingState>;
}

interface Scan {
  /** The day files' names, sizes and mtimes when read. */
  signature: string;
  sessions: SessionSummary[];
  outcomes: Map<string, SessionOutcome[]>;
}

export class SessionPages {
  private readonly scans = new Map<string, Scan>();
  /** One scan per workspace at a time; concurrent requests share it. */
  private readonly scanning = new Map<string, Promise<Scan>>();

  constructor(
    private readonly home: string,
    private readonly findings: FindingsService
  ) {}

  /** The workspace's sessions, newest activity first, each with its outcome counts. */
  async list(workspace: string): Promise<SessionListItem[]> {
    const scan = await this.scan(workspace);
    return scan.sessions
      .map((s) => {
        const counts: OutcomeCounts = {};
        for (const o of scan.outcomes.get(s.sessionId) ?? []) counts[o.type] = (counts[o.type] ?? 0) + 1;
        return { ...s, outcomes: counts };
      })
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs) || a.sessionId.localeCompare(b.sessionId));
  }

  /** The summaries alone, for the Explore picker and lookups. */
  async summaries(workspace: string): Promise<SessionSummary[]> {
    return (await this.scan(workspace)).sessions;
  }

  /** One session's page; undefined if the workspace has no such session. */
  async page(workspace: string, sessionId: string): Promise<SessionPage | undefined> {
    const scan = await this.scan(workspace);
    const summary = scan.sessions.find((s) => s.sessionId === sessionId);
    if (!summary) return undefined;
    const { current, newReplay } = await this.findings.forSessions(workspace);
    const events = (await this.eventsOf(workspace, [summary])).get(sessionId) ?? [];
    const view = this.viewOf(summary, events, newReplay, current.findings, current.muted);
    const responses: Record<string, FindingState> = {};
    for (const f of view.findings) if (f.active && current.responses[f.heuristicId]) responses[f.heuristicId] = current.responses[f.heuristicId];
    return { workspace, view, outcomes: scan.outcomes.get(sessionId) ?? [], responses };
  }

  /** The Explore tab's state for these sessions, in this order, at most EXPLORE_SESSION_CAP of them. */
  async explore(workspace: string, ids: string[]): Promise<ExplorerState> {
    const picked = [...new Set(ids)].slice(0, EXPLORE_SESSION_CAP);
    const scan = await this.scan(workspace);
    const summaries = picked.map((id) => scan.sessions.find((s) => s.sessionId === id)).filter((s): s is SessionSummary => !!s);
    const { current, newReplay } = await this.findings.forSessions(workspace);
    const events = await this.eventsOf(workspace, summaries);
    const views = new Map<string, SessionView>();
    for (const s of summaries) views.set(s.sessionId, this.viewOf(s, events.get(s.sessionId) ?? [], newReplay, current.findings, current.muted));
    return buildExplorerState(picked, (id) => views.get(id));
  }

  private viewOf(
    summary: SessionSummary,
    events: NormalizedEvent[],
    newReplay: () => FindingReplay,
    live: LiveFinding[],
    muted: string[]
  ): SessionView {
    const replay = newReplay();
    for (const e of events) replay.ingest(e);
    // buildSessionView keeps only findings that point at this session's events, live ones included.
    return buildSessionView(summary, events, this.findings.contextMarks(), sessionFindings(replay.episodes(), live, muted));
  }

  /** These sessions' events in time order, reading each of their days once. */
  private async eventsOf(workspace: string, summaries: SessionSummary[]): Promise<Map<string, NormalizedEvent[]>> {
    const log = new EventLog(workspaceStoreDir(this.home, workspace));
    const wanted = new Set(summaries.map((s) => s.sessionId));
    const days = [...new Set(summaries.flatMap((s) => s.days))].sort();
    const out = new Map<string, NormalizedEvent[]>();
    for (const day of days) {
      for (const e of await log.readDay(day)) {
        if (!wanted.has(e.sessionId) || e.kind === 'outcome') continue;
        const list = out.get(e.sessionId) ?? [];
        list.push(e);
        out.set(e.sessionId, list);
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
    return out;
  }

  /** The workspace's sessions and their outcomes, read again only when a day file changed. */
  private async scan(workspace: string): Promise<Scan> {
    const dir = workspaceStoreDir(this.home, workspace);
    const signature = daySignature(dir);
    const cached = this.scans.get(workspace);
    if (cached && cached.signature === signature) return cached;
    const running = this.scanning.get(workspace);
    if (running) return running;
    const run = (async (): Promise<Scan> => {
      const log = new EventLog(dir);
      const index = new SessionIndex();
      const outcomes = new Map<string, SessionOutcome[]>();
      for (const day of await log.listDays()) {
        for (const e of await log.readDay(day)) {
          if (e.kind === 'outcome' && e.outcome) {
            const list = outcomes.get(e.sessionId) ?? [];
            list.push({ ts: e.ts, ...e.outcome });
            outcomes.set(e.sessionId, list);
          } else index.ingest(e);
        }
      }
      for (const list of outcomes.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
      const scan = { signature, sessions: index.list(), outcomes };
      this.scans.set(workspace, scan);
      return scan;
    })();
    this.scanning.set(workspace, run);
    try {
      return await run;
    } finally {
      this.scanning.delete(workspace);
    }
  }
}

/** The day files' names, sizes and mtimes: a change in any means reading again. */
function daySignature(storeDir: string): string {
  const dir = path.join(storeDir, 'events');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .join('|');
  } catch {
    return '';
  }
}
