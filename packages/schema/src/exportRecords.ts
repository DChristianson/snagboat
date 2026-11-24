import type { NormalizedEvent } from './types';
import type { SessionSummary } from './sessions';
import type { Confidence, PlanItemTouch } from './storeRecords';

/**
 * The records only an export has (docs/design/export.md, "What an export holds"): its events,
 * its sessions, and manifest.json. The export also writes the store's git, plan, link and
 * finding records (storeRecords.ts), through the privacy filter, as they are: git.jsonl's records go to
 * git/commits.jsonl, git/branches.jsonl and git/checkouts.jsonl by `record`, and plan.jsonl's to
 * plan/items.jsonl and plan/transitions.jsonl. Nothing validates against the schemas at run time.
 */

/**
 * One line of an export's events/YYYY-MM-DD.jsonl (exportedEvent.v5.schema.json): a version 4
 * event after the privacy filter. workspace and raw are never exported.
 */
export type ExportedEvent = Omit<NormalizedEvent, 'workspace' | 'raw'>;

/**
 * One line of an export's sessions.jsonl: what `snagboat sessions --json` prints for a session
 * (SessionSummary), plus where it ran and what it's linked to.
 */
export interface SessionRecord extends SessionSummary {
  /** The subagents' ids (SessionSummary.subagents counts them). */
  subagentIds: string[];
  /** Its working tree: '.' or '[worktree-N]' once the filter rewrote the path, else the path. */
  where: string;
  /** Branches checked out during the session, in order (from checkouts and links), by name. */
  branches: string[];
  /** Commits linked to the session, with each link's confidence. */
  commits: Array<{ sha: string; confidence: Confidence }>;
  /** Plan items linked to the session, and how it touched each: one entry per item and way. */
  planItems: Array<{ id: string; how: PlanItemTouch; confidence: Confidence }>;
}

/** How many records of each kind an export holds. */
export interface ExportCounts {
  /** Event files (UTC days). */
  days: number;
  events: number;
  sessions: number;
  findings: number;
  commits: number;
  branches: number;
  checkouts: number;
  planItems: number;
  transitions: number;
  links: number;
}

/** What each rule did, by rule id: distinct values rewritten and kept. */
export type ExportRuleCounts = Record<string, { rewritten: number; kept: number }>;

/** An export folder's manifest.json (exportManifest.v2.schema.json): what it is, and what the privacy filter did to it. */
export interface ExportManifest {
  format: 'snagboat-export';
  /** The export format's version. */
  version: 2;
  /** The event schema version its events follow. */
  eventSchema: 4;
  generatedAt: string;
  /** The project's name, from --name (else the project folder's name). */
  project: string;
  /** The range asked for (--since, --until; absent: everything), and the first and last event exported. */
  range: { since?: string; until?: string; first?: string; last?: string };
  /** --text: redacted (the default) or none, structure only. */
  text: 'redacted' | 'none';
  counts: ExportCounts;
  /** The Snagboat version that wrote it. */
  snagboatVersion: string;
  /** reviewed: every rule ran, each value decided by its rule's action or by you. rewrite-all: --rewrite-all. none: --no-filter. */
  filter: 'reviewed' | 'rewrite-all' | 'none';
  /** Distinct values each rule found, rewritten and kept; rules that found nothing are left out. */
  rules: ExportRuleCounts;
  /** The export's guide: what each file is, how they join, what the placeholders mean. */
  readme: 'README.md';
  /** Each file (a path, or a pattern like events/*.jsonl) and the JSON Schema in schema/ its records follow. */
  schemas: Record<string, string>;
}
