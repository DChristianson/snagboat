import type { FindingResponse } from './types';

/**
 * The store's git, plan, link and finding records (docs/design/export.md, "The normalized
 * schema" and "The store records it"). The core appends them to four files in each workspace's
 * folder in ~/.snagboat/data, beside events/:
 *
 * | File             | `record` values                    | Schema                       |
 * | ---------------- | ---------------------------------- | ---------------------------- |
 * | git.jsonl        | 'commit', 'branch', 'checkout'     | gitRecord.v1.schema.json     |
 * | plan.jsonl       | 'item', 'transition'               | planRecord.v1.schema.json    |
 * | links.jsonl      | 'link'                             | linkRecord.v1.schema.json    |
 * | findings.jsonl   | 'finding'                          | findingRecord.v1.schema.json |
 *
 * Every line names its record type in `record`, so one file holds several, and carries
 * `version: 1`. Every record has a stable key (`storeRecordKey`): a commit's full SHA, and
 * every other record's `id`. The files are append only: a job appends a record again when it
 * changes (a branch merged or deleted, an item's new status, a link that turned observed), and
 * the latest line with a key is the record (`foldStoreRecords`). A job appends nothing when the
 * record is unchanged, so running it again adds nothing.
 *
 * What's stored is raw: real paths, names and SHAs, with only capture-time secret redaction.
 * The export applies the privacy rules to the same records. Nothing validates against the
 * schemas at run time.
 */

/** observed: something recorded shows it directly. inferred: a rule guessed it. */
export type Confidence = 'observed' | 'inferred';

/** Which file each record type is stored in. */
export const STORE_RECORD_FILES = {
  commit: 'git.jsonl',
  branch: 'git.jsonl',
  checkout: 'git.jsonl',
  item: 'plan.jsonl',
  transition: 'plan.jsonl',
  link: 'links.jsonl',
  finding: 'findings.jsonl',
} as const;

export type StoreRecordType = keyof typeof STORE_RECORD_FILES;

// ---- git.jsonl ----------------------------------------------------------------------------

/** One changed file in a commit. */
export interface CommitFile {
  /** Relative to the repository's root. */
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: number;
  deleted: number;
  /** R: the path it was renamed from. */
  from?: string;
}

/** A commit, merges included. Keyed by `sha`. */
export interface CommitRecord {
  record: 'commit';
  version: 1;
  /** The full SHA: the record's key. The export re-keys it for a private repository. */
  sha: string;
  parents: string[];
  /** 'merge': two or more parents. 'squash': one parent, and its subject names a pull request ("(#157)"). */
  kind: 'commit' | 'merge' | 'squash';
  /** ISO 8601, UTC: git's timezone offset isn't kept. */
  authoredAt: string;
  committedAt: string;
  /** In the store, git's ident ("Name <email>"); in an export, person-N or an agent's name. */
  author: string;
  committer: string;
  /** From Co-Authored-By trailers, as author is: agents by name, people as idents (person-N in an export). */
  coAuthors: string[];
  subject: string;
  /** The message after the subject. Only while the project captures content; removed past retention.textDays and by Snagboat: Remove Captured Text. */
  body?: string;
  files: CommitFile[];
  /** Pull request number from the subject ("(#157)"), when there is one. Nothing else about pull requests is recorded. */
  pr?: number;
  /** The commit this one reverts ("This reverts commit <sha>"). */
  reverts?: string;
  /** Branches whose history contains it when it was recorded, by name. */
  onBranches: string[];
}

/** How a branch reached the branch it was merged into. */
export interface BranchMerge {
  /** The branch it was merged into, by name. */
  into: string;
  at: string;
  via: 'merge' | 'squash' | 'rebase' | 'fast-forward';
  /** The merge or squash commit, or the target's head after a rebase or fast-forward. */
  commit: string;
  pr?: number;
}

/**
 * A branch. Keyed by `id`, `<name>@<firstSeenAt>`, since a name can be deleted and made again:
 * the second branch of that name is a new record.
 */
export interface BranchRecord {
  record: 'branch';
  version: 1;
  /** `${name}@${firstSeenAt}`. */
  id: string;
  /** Scrubbed by the export's rules like any text: a user name in it becomes [user]. */
  name: string;
  /** When the repository job first saw it (ISO 8601, UTC). Part of its id, so never changes. */
  firstSeenAt: string;
  /** Its first reflog entry, when the reflog still has it. */
  createdAt?: string;
  /** The commit it started from. */
  from?: string;
  /** Its last known commit. */
  head: string;
  /** Where it went, if it did. */
  merged?: BranchMerge;
  /** When Snagboat saw it gone. */
  deletedAt?: string;
}

/**
 * A HEAD move in one working tree from its reflog ("checkout: moving from A to B"). Keyed by `id`,
 * `checkout-` and the first 16 hex characters of the SHA-256 of `${worktree}\n${at}\n${commit}`,
 * where worktree is the working tree's git directory name ('.' for the main one, else the name
 * under .git/worktrees/). A reflog position (HEAD@{n}) shifts as entries are added, so it isn't used.
 */
export interface CheckoutRecord {
  record: 'checkout';
  version: 1;
  id: string;
  /** The reflog entry's time (ISO 8601, UTC). */
  at: string;
  /** Branch name, or a short SHA when detached. */
  from: string;
  to: string;
  /** The commit HEAD moved to: the reflog entry's new SHA. */
  commit: string;
  /** In the store, the working tree's absolute path; in an export, '.' or '[worktree-N]'. Each worktree has its own HEAD. */
  where: string;
}

/** One line of git.jsonl. */
export type GitRecord = CommitRecord | BranchRecord | CheckoutRecord;

// ---- plan.jsonl ---------------------------------------------------------------------------

/** A plan item's kind, as Factory Clock's PlanItem has it. */
export type PlanItemKind = 'epic' | 'milestone' | 'feature' | 'task' | 'bug' | 'step' | 'decision' | 'question' | 'note';

/** A plan item's status, as Factory Clock's PlanItem has it. */
export type PlanItemStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'deferred' | 'dropped';

/**
 * A plan item: a bead, or a step inferred from the project's planning markdown. Follows Factory
 * Clock's PlanItem (its src/model/plan.ts) plus `from`, `source` and `confidence`. Keyed by `id`:
 * the bead's id, or for markdown `md-` and the first 12 hex characters of the SHA-256 of its
 * file (relative to the project) and its heading path (a task adding its position under its heading,
 * "#3" or "#3.1"), joined by newlines, so it survives edits to its wording (src/core/planRecords.ts).
 */
export interface PlanItemRecord {
  record: 'item';
  version: 1;
  id: string;
  kind: PlanItemKind;
  title: string;
  status: PlanItemStatus;
  priority?: number;
  parent?: string;
  /** The items it depends on (bd's blocking dependencies), by id. */
  blockedBy?: string[];
  labels: string[];
  created: string;
  started?: string;
  updated: string;
  closed?: string;
  closeReason?: string;
  /** In the store, bd's assignee; in an export, person-N. */
  assignee?: string;
  /** In the store, bd's owner (often an email); in an export, person-N. */
  owner?: string;
  /** In the store, bd's created_by; in an export, person-N or an agent's name. */
  createdBy?: string;
  /** Only while the project captures content; removed past retention.textDays and by Snagboat: Remove Captured Text. */
  text?: { description?: string; design?: string; notes?: string; acceptance?: string };
  source: 'beads' | 'markdown';
  /** markdown: the file and heading it came from, relative to the project. */
  from?: { file: string; heading?: string };
  /** 'observed' from beads; 'inferred' from markdown. */
  confidence: Confidence;
}

export type TransitionType =
  | 'created'
  | 'claimed'
  | 'status_changed'
  | 'updated'
  | 'closed'
  | 'reopened'
  | 'dependency_added'
  | 'dependency_removed'
  | 'commented'
  | 'label_added'
  | 'label_removed';

/**
 * One step in a plan item's lifecycle. Keyed by `id`: for beads, the bd audit event's id
 * (`bd history --events`); for markdown, `md-t-` and the first 16 hex characters of the
 * SHA-256 of `${item}\n${at}\n${type}\n${to ?? ''}`.
 */
export interface TransitionRecord {
  record: 'transition';
  version: 1;
  id: string;
  /** The plan item's id. */
  item: string;
  at: string;
  type: TransitionType;
  /** The old status, for status changes. */
  from?: string;
  /** The new status, or the other item for a dependency. */
  to?: string;
  /** For 'updated': which fields changed, not their values (the item has its current text). */
  fields?: string[];
  /** In the store, bd's actor (or the commit's author, for markdown); in an export, person-N or an agent's name. */
  actor: string;
  /** 'observed' from bd's journal; 'inferred' from markdown, whose time and actor come from the commit that changed the line. */
  confidence: Confidence;
}

/** One line of plan.jsonl. */
export type PlanRecord = PlanItemRecord | TransitionRecord;

// ---- links.jsonl --------------------------------------------------------------------------

/** The records a link can join. Ids: a session's id, a commit's SHA, a branch's, item's or transition's id. */
export type LinkEndType = 'session' | 'commit' | 'branch' | 'plan-item' | 'transition';

export interface LinkEnd {
  type: LinkEndType;
  id: string;
}

export type LinkKind = 'made' | 'worked-on' | 'touched' | 'references' | 'merged' | 'made-in';

/** How a session touched a plan item. */
export type PlanItemTouch = 'created' | 'claimed' | 'updated' | 'closed' | 'mentioned';

/**
 * A typed edge between two records, worked out by the core's linker (docs/design/export.md,
 * "How records are linked"). Keyed by `id`: `link-` and the first 16 hex characters of the
 * SHA-256 of `${from.type}:${from.id}\n${to.type}:${to.id}\n${kind}\n${how ?? ''}`. Confidence
 * and evidence aren't part of it, so a link that turns observed is the same link, appended again.
 */
export interface LinkRecord {
  record: 'link';
  version: 1;
  id: string;
  from: LinkEnd;
  to: LinkEnd;
  kind: LinkKind;
  /** touched: how the session touched the item. */
  how?: PlanItemTouch;
  confidence: Confidence;
  /** Why: rule names and the ids of the records that show it. */
  evidence: Array<{ rule: string; refs: string[] }>;
  /**
   * Store only: the link that replaced this one when a later record overturned it, or
   * LINK_WITHDRAWN when the rules withdrew it with nothing in its place. The export writes only
   * current links.
   */
  supersededBy?: string;
  /** Store only: the time of the latest record in its evidence (ISO 8601, UTC), for retention (retention.rawDays). */
  at?: string;
}

// ---- findings.jsonl -----------------------------------------------------------------------

/**
 * One finding episode (a heuristic or rule reporting, until it stops), written by the core's
 * findings service as it closes, as it was shown. Keyed by `id`: `finding-` and the first 16 hex
 * characters of the SHA-256 of `${heuristicId}\n${sessionId ?? ''}\n${firstTs}`.
 */
export interface FindingRecord {
  record: 'finding';
  version: 1;
  id: string;
  /** The heuristic's or saved rule's id. */
  heuristicId: string;
  /** The heuristic's version when it was shown: a built-in's Snagboat version, or a hash of a saved rule's definition. */
  heuristicVersion: string;
  /** The session of its latest event; absent for a finding about no one session. */
  sessionId?: string;
  /** The turn of its latest event, when it had one. */
  turnId?: string;
  /** The worst severity it reached. */
  severity: 'info' | 'warn';
  /** The latest finding's summary, as shown. */
  summary?: string;
  /** When it started and stopped reporting. */
  firstTs: string;
  lastTs: string;
  /** The events it's about, across the episode. */
  eventRefs: string[];
  /** It was shown as an early warning (before its threshold). */
  earlyWarning: boolean;
  /** How you met it, strongest first: useful, muted, acknowledged, or let it pass. */
  response: FindingResponse;
}

/** Any line of the four store files. */
export type StoreRecord = GitRecord | PlanRecord | LinkRecord | FindingRecord;

/** A record's key, unique across the store's files: its type and its SHA or id ("commit:<sha>", "item:snagboat-koh"). */
export function storeRecordKey(r: StoreRecord): string {
  return `${r.record}:${r.record === 'commit' ? r.sha : r.id}`;
}

/** Folds a file's lines into its current records: the latest line with each key, in the order keys first appeared. */
export function foldStoreRecords<T extends StoreRecord>(lines: Iterable<T>): T[] {
  const latest = new Map<string, T>();
  for (const line of lines) latest.set(storeRecordKey(line), line);
  return [...latest.values()];
}

/**
 * A link's supersededBy when the rules withdrew it and no link took its place (an inferred guess
 * a stricter rule no longer makes). Not a link id, so nothing resolves it; any reader that skips
 * superseded links skips it too.
 */
export const LINK_WITHDRAWN = 'withdrawn';

/** The links an export writes: the current ones, without any a later link superseded or the rules withdrew. */
export function currentLinks(lines: Iterable<LinkRecord>): LinkRecord[] {
  return foldStoreRecords(lines).filter((l) => l.supersededBy === undefined);
}
