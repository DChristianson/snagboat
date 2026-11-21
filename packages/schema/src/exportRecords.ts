import type { NormalizedEvent } from './types';
import type { SessionSummary } from './sessions';
import type { Confidence, PlanItemTouch } from './storeRecords';

/**
 * The records only an export has (docs/design/export.md, "What an export holds"): its events,
 * its sessions, and manifest.json. The export also writes the store's git, plan, link and
 * finding records (storeRecords.ts), sanitized, as they are: git.jsonl's records go to
 * git/commits.jsonl, git/branches.jsonl and git/checkouts.jsonl by `record`, and plan.jsonl's to
 * plan/items.jsonl and plan/transitions.jsonl. Nothing validates against the schemas at run time.
 */

/** What the privacy rules replaced in one field of an exported event, without the values. */
export interface Redaction {
  /** The field, as a dotted path: promptText, toolInput.command, todos.items. */
  field: string;
  /** The rule that replaced it, as the manifest's redactions name it. */
  rule: string;
  /** How many values it replaced there. */
  count: number;
}

/**
 * One line of an export's events/YYYY-MM-DD.jsonl: a version 4 event after the privacy rules.
 * workspace and raw are never exported; redactions is export only, never stored.
 */
export interface ExportedEvent extends Omit<NormalizedEvent, 'workspace' | 'raw'> {
  redactions?: Redaction[];
}

/**
 * One line of an export's sessions.jsonl: what `snagboat sessions --json` prints for a session
 * (SessionSummary), plus where it ran and what it's linked to.
 */
export interface SessionRecord extends SessionSummary {
  /** The subagents' ids (SessionSummary.subagents counts them). */
  subagentIds: string[];
  /** '.' for the project root, or '[worktree-N]' for another worktree. */
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

/** An export folder's manifest.json: what it is, and what the privacy rules did to it. */
export interface ExportManifest {
  format: 'snagboat-export';
  /** The export format's version. */
  version: 1;
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
  /** The privacy rules' version. */
  rulesVersion: number;
  /** The Snagboat version that wrote it. */
  snagboatVersion: string;
  /** How many values each rule replaced, by rule name. */
  redactions: Record<string, number>;
  /** How many values were flagged for review (<out>.review/flags.jsonl, never in the export). */
  flags: number;
  /** private (the default): commit SHAs are re-keyed. public: the project sets export.public. */
  repository: { privacy: 'private' | 'public' };
}
