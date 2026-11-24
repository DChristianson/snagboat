import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  baseCategory,
  BranchRecord,
  CheckoutRecord,
  CommitRecord,
  Confidence,
  EventRefs,
  LinkEnd,
  LinkKind,
  LINK_WITHDRAWN,
  LinkRecord,
  NormalizedEvent,
  PlanItemRecord,
  PlanItemTouch,
  storeRecordKey,
  TransitionRecord,
  TransitionType,
} from '@snagboat/schema';
import { BdAction, commandActions, isPlanItemId } from './toolInput';
import { GitSession, repoPath, sessionForCommit } from '../outcomes/gitOutcomes';

/**
 * The linker's rules (docs/design/export.md, "How records are linked"): typed edges between a
 * workspace's sessions, commits, branches, plan items and transitions, each observed (a record
 * shows it) or inferred (a rule guessed it), with evidence naming the rule and the records that
 * show it. Pure: the linker job (service/linkerJob.ts) feeds it what the store holds and appends
 * what changed to links.jsonl.
 *
 * | Link                         | Observed (rule)                                                   | Inferred (rule)                                    |
 * | ---------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
 * | session made commit          | tool-call-commit: a call's refs.commit; git-commit-call: a call   | git-outcomes: the git outcomes rule                |
 * |                              | ran git commit / gh pr merge and a commit landed within 60 s       | (sessionForCommit)                                 |
 * | session worked-on branch     | checkout: a checkout in its working tree while it was active;     | branch-at-start: the branch checked out there when |
 * |                              | tool-call-branch: a call's refs.branch                            | it started                                         |
 * | session touched plan item    | bd-call: a call's refs.planItems and a matching transition (how   | bd-call: no matching transition (yet);             |
 * |                              | from bd's subcommand); a `bd show` is observed 'mentioned'        | text-mention: the id in a prompt or reply;         |
 * |                              |                                                                   | commit-references: a commit it made names it       |
 * | transition made-in session   | bd-call: the bd call that made it, within seconds                 | the one session with an event within 5 min of it   |
 * |                              |                                                                   | and a sign of the item, by its person:             |
 * |                              |                                                                   | active-session-touched: it touched the item;       |
 * |                              |                                                                   | active-session-bd: it ran bd within those 5 min    |
 * | commit references plan item  | commit-message: its subject or body names the id                  | branch-name / pull-request: its branch's name, or  |
 * |                              |                                                                   | the merge or squash commit of its branch, names it |
 * | branch merged into branch    | merge-commit / squash-commit (BranchRecord.merged.via)            | reachable: rebased or fast-forwarded               |
 *
 * Ids in text are found by the project's prefix (issuePrefix) and must be plan items the store has.
 * 'active-session' (any session active then, first to last event) is retired: stored links with it
 * still read, and linksToAppend withdraws them.
 */

export const LINK_RULES = [
  'tool-call-commit',
  'git-commit-call',
  'git-outcomes',
  'checkout',
  'tool-call-branch',
  'branch-at-start',
  'bd-call',
  'text-mention',
  'commit-references',
  'active-session-touched',
  'active-session-bd',
  /** Retired: the old made-in guess, which over-attached. Only stored links carry it. */
  'active-session',
  'commit-message',
  'branch-name',
  'pull-request',
  'merge-commit',
  'squash-commit',
  'reachable',
] as const;
export type LinkRule = (typeof LINK_RULES)[number];

/** A commit made this long after a `git commit` call (or this little before it: clocks, second precision) is the call's. */
export const COMMIT_AFTER_CALL_MS = 60_000;
const COMMIT_BEFORE_CALL_MS = 2_000;
/** A bd transition this long after the call that ran bd (a permission prompt can hold it), or a little before, is the call's. */
export const TRANSITION_AFTER_CALL_MS = 120_000;
const TRANSITION_BEFORE_CALL_MS = 10_000;
/** An inferred made-in session had an event (and, for active-session-bd, a bd call) this close to the transition. */
export const MADE_IN_NEAR_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
/** The rules that infer made-in; a stored link with only these, which the rules no longer give, can be withdrawn. */
const MADE_IN_INFERRED: ReadonlySet<string> = new Set<LinkRule>(['active-session-touched', 'active-session-bd', 'active-session']);
/** The most event ids one piece of evidence names. */
const MAX_REFS = 20;

/** A link's id: 'link-' + 16 hex of SHA-256 of from, to, kind and how (storeRecords.ts). */
export function linkId(from: LinkEnd, to: LinkEnd, kind: LinkKind, how?: PlanItemTouch): string {
  return `link-${crypto.createHash('sha256').update(`${from.type}:${from.id}\n${to.type}:${to.id}\n${kind}\n${how ?? ''}`).digest('hex').slice(0, 16)}`;
}

// ---- what the linker keeps of a session's events --------------------------------------------

/** A tool call that ran git or bd, or carries refs. */
export interface ToolFact {
  eventId: string;
  at: number;
  refs?: EventRefs;
  gitCommit: boolean;
  checkout: boolean;
  prMerge: boolean;
  /** Each bd command it ran (only with its command line: captureContent on). */
  bd: BdAction[];
  /** The command line was recorded, so bd and git above are known. */
  command: boolean;
}

/** One session, as the rules read it: kept current as events arrive (observeEvent), never the events themselves. */
export interface SessionFacts {
  sessionId: string;
  agent: NormalizedEvent['agent'];
  /** Its first and last activity (ms), as the git outcomes rule counts it: not outcomes, names or editor-feature calls. */
  first: number;
  last: number;
  /** The minutes (ms / 60 000, floored) it had activity in, counted as first and last are. */
  minutes: Set<number>;
  /** Absolute paths its agent edited (file-edit tool calls), with the edits' event ids. */
  edits: Map<string, string[]>;
  /** Test and build runs, for the git outcomes rule's sessions. */
  runs: Map<string, { at: number; passed: boolean }>;
  calls: Map<string, ToolFact>;
  /** Prompts and replies naming something shaped like a bead id. */
  mentions: Map<string, { at: number; ids: string[] }>;
  subagents: Set<string>;
}

const ID_TOKENS = /[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-[a-z0-9]+(?:\.\d+)*/g;

/** The tokens in text shaped like bead ids (isPlanItemId), each once, at most 50. */
export function idTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ID_TOKENS)) {
    if (isPlanItemId(m[0])) out.add(m[0]);
    if (out.size >= 50) break;
  }
  return [...out];
}

/** Adds an event to its session's facts. Idempotent: an event seen twice changes nothing. */
export function observeEvent(sessions: Map<string, SessionFacts>, e: NormalizedEvent): void {
  if (e.kind === 'outcome' || e.kind === 'session_name' || e.channel === 'inline') return;
  const at = Date.parse(e.ts);
  if (!Number.isFinite(at)) return;
  let s = sessions.get(e.sessionId);
  if (!s) {
    s = { sessionId: e.sessionId, agent: e.agent, first: at, last: at, minutes: new Set(), edits: new Map(), runs: new Map(), calls: new Map(), mentions: new Map(), subagents: new Set() };
    sessions.set(e.sessionId, s);
  }
  s.first = Math.min(s.first, at);
  s.last = Math.max(s.last, at);
  s.minutes.add(Math.floor(at / MINUTE_MS));
  if (e.agentId) s.subagents.add(e.agentId);
  const text = e.kind === 'user_prompt' ? e.promptText : e.textExcerpt;
  if (text) {
    const ids = idTokens(text);
    if (ids.length > 0) s.mentions.set(e.eventId, { at, ids });
  }
  if (e.kind !== 'tool_call') return;
  if (e.toolCategory) {
    const category = baseCategory(e.toolCategory);
    if (category === 'tests-builds' && e.status !== 'unknown') s.runs.set(e.eventId, { at, passed: e.status === 'success' });
    if (category === 'file-edit' && e.target && path.isAbsolute(e.target)) {
      const ids = s.edits.get(e.target) ?? [];
      if (!ids.includes(e.eventId)) s.edits.set(e.target, [...ids, e.eventId]);
    }
  }
  const command = e.toolInput?.command;
  const actions = command ? commandActions(command) : undefined;
  if (e.refs || (actions && (actions.gitCommit || actions.checkout || actions.prMerge || actions.bd.length > 0))) {
    s.calls.set(e.eventId, {
      eventId: e.eventId,
      at,
      ...(e.refs ? { refs: e.refs } : {}),
      gitCommit: actions?.gitCommit ?? false,
      checkout: actions?.checkout ?? false,
      prMerge: actions?.prMerge ?? false,
      bd: actions?.bd ?? [],
      command: !!actions,
    });
  }
}

/** A session's facts as the git outcomes rule reads them: its edits as paths in the repository at `repo`. */
export function asGitSession(s: SessionFacts, repo: string): GitSession {
  const files = new Map<string, string[]>();
  for (const [file, ids] of s.edits) {
    const key = repoPath(repo, file);
    if (key) files.set(key, [...(files.get(key) ?? []), ...ids]);
  }
  return { sessionId: s.sessionId, agent: s.agent, first: s.first, last: s.last, files, runs: [...s.runs.values()].sort((a, b) => a.at - b.at) };
}

// ---- the project's bead prefix --------------------------------------------------------------

/** A bead id's prefix: "snagboat" of snagboat-93b.10.5. */
export function prefixOf(id: string): string | undefined {
  const m = /^(.+)-[a-z0-9]+(?:\.\d+)*$/.exec(id);
  return m ? m[1] : undefined;
}

/**
 * The project's bead prefix: bd's issue-prefix in <folder>/.beads/config.yaml when it's set
 * there, else the most common prefix among its beads.
 */
export function issuePrefix(folders: string[], items: Iterable<PlanItemRecord>): string | undefined {
  for (const folder of folders) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(folder, '.beads', 'config.yaml'), 'utf8');
    } catch {
      continue;
    }
    const m = /^\s*issue[-_]prefix\s*:\s*["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*(?:#.*)?$/m.exec(text);
    if (m) return m[1];
  }
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.source !== 'beads') continue;
    const p = prefixOf(item.id);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

// ---- the rules ------------------------------------------------------------------------------

/** One workspace of the repository being linked, with its sessions. */
export interface LinkerWorkspace {
  workspace: string;
  /** Its working tree's root (a checkout's `where`); the repository rule reads paths against it. */
  where: string;
  sessions: Iterable<SessionFacts>;
}

export interface LinkerInput {
  /** A repository's workspaces (its worktrees), or one workspace that isn't in a repository. */
  workspaces: LinkerWorkspace[];
  commits: CommitRecord[];
  branches: BranchRecord[];
  checkouts: CheckoutRecord[];
  items: PlanItemRecord[];
  transitions: TransitionRecord[];
  /** The project's bead prefix (issuePrefix). */
  prefix?: string;
}

/** A link as the rules worked it out: the record, the workspace whose session it names (undefined: every workspace of the repository's), and its slot. */
export interface ComputedLink {
  link: LinkRecord;
  workspace?: string;
  /**
   * Links of one slot replace one another: a commit is made in one session, a transition in one
   * session, and a session touches an item once per way. A stored link the rules no longer give,
   * whose slot has a link now, is superseded by it.
   */
  slot?: string;
}

interface Draft {
  from: LinkEnd;
  to: LinkEnd;
  kind: LinkKind;
  how?: PlanItemTouch;
  observed: boolean;
  evidence: Map<string, Set<string>>;
  at: number;
  workspace?: string;
  slot?: string;
}

class Drafts {
  readonly byId = new Map<string, Draft>();

  add(d: { from: LinkEnd; to: LinkEnd; kind: LinkKind; how?: PlanItemTouch; confidence: Confidence; rule: LinkRule; refs: string[]; at: number; workspace?: string; slot?: string }): string {
    const id = linkId(d.from, d.to, d.kind, d.how);
    let draft = this.byId.get(id);
    if (!draft) {
      draft = { from: d.from, to: d.to, kind: d.kind, ...(d.how ? { how: d.how } : {}), observed: false, evidence: new Map(), at: d.at, ...(d.workspace ? { workspace: d.workspace } : {}), ...(d.slot ? { slot: d.slot } : {}) };
      this.byId.set(id, draft);
    }
    if (d.confidence === 'observed') draft.observed = true;
    draft.at = Math.max(draft.at, d.at);
    const refs = draft.evidence.get(d.rule) ?? new Set<string>();
    for (const r of d.refs) if (refs.size < MAX_REFS) refs.add(r);
    draft.evidence.set(d.rule, refs);
    return id;
  }

  /** Drops the inferred-only links of a slot that has an observed one: what a record shows beats a guess. */
  preferObserved(kind: LinkKind): void {
    const observedSlots = new Set<string>();
    for (const d of this.byId.values()) if (d.kind === kind && d.observed && d.slot) observedSlots.add(d.slot);
    for (const [id, d] of this.byId) if (d.kind === kind && !d.observed && d.slot && observedSlots.has(d.slot)) this.byId.delete(id);
  }

  of(kind: LinkKind): Array<[string, Draft]> {
    return [...this.byId].filter(([, d]) => d.kind === kind);
  }

  records(): ComputedLink[] {
    return [...this.byId]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, d]) => {
        const link: LinkRecord = {
          record: 'link',
          version: 1,
          id,
          from: d.from,
          to: d.to,
          kind: d.kind,
          ...(d.how ? { how: d.how } : {}),
          confidence: d.observed ? 'observed' : 'inferred',
          evidence: [...d.evidence].sort((a, b) => a[0].localeCompare(b[0])).map(([rule, refs]) => ({ rule, refs: [...refs].sort() })),
          at: new Date(d.at).toISOString(),
        };
        return { link, ...(d.workspace ? { workspace: d.workspace } : {}), ...(d.slot ? { slot: d.slot } : {}) };
      });
  }
}

/** What a bd subcommand can make, and how it touches the item. */
function bdTouch(action: BdAction | undefined): { how: PlanItemTouch; types: TransitionType[] | 'any' | 'none' } {
  if (!action) return { how: 'updated', types: 'any' };
  if (action.claim) return { how: 'claimed', types: ['claimed', 'status_changed'] };
  switch (action.sub) {
    case 'create':
    case 'new':
    case 'q':
      return { how: 'created', types: ['created'] };
    case 'close':
      return { how: 'closed', types: ['closed', 'status_changed'] };
    case 'show':
    case 'comments':
      return { how: 'mentioned', types: action.sub === 'comments' ? ['commented'] : 'none' };
    case 'reopen':
      return { how: 'updated', types: ['reopened', 'status_changed'] };
    case 'comment':
      return { how: 'updated', types: ['commented'] };
    case 'dep':
      return { how: 'updated', types: ['dependency_added', 'dependency_removed'] };
    case 'label':
      return { how: 'updated', types: ['label_added', 'label_removed'] };
    default:
      return { how: 'updated', types: ['updated', 'status_changed', 'claimed', 'closed', 'reopened', 'label_added', 'label_removed', 'dependency_added', 'dependency_removed'] };
  }
}

/** How a transition touches its item, for a call whose command line wasn't recorded. */
function touchOf(t: TransitionRecord): PlanItemTouch {
  if (t.type === 'created') return 'created';
  if (t.type === 'claimed' || (t.type === 'status_changed' && t.to === 'in_progress')) return 'claimed';
  if (t.type === 'closed' || (t.type === 'status_changed' && t.to === 'done')) return 'closed';
  return 'updated';
}

/** The name in a git ident ("Name <email>"), lower-cased; and its email. */
function identParts(ident: string): string[] {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(ident);
  return (m ? [m[1], m[2]] : [ident]).map((p) => p.trim().toLowerCase()).filter(Boolean);
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** Works out every link the records show. Deterministic: the same input gives the same links in the same order. */
export function computeLinks(input: LinkerInput): ComputedLink[] {
  const drafts = new Drafts();
  const items = new Map(input.items.map((i) => [i.id, i]));
  const prefix = input.prefix;
  /** Bead ids in text: the project's prefix, and an item the store has. */
  const byPrefix = prefix ? new RegExp(`(?<![A-Za-z0-9_-])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z0-9]+(?:\\.\\d+)*`, 'g') : undefined;
  const itemsIn = (text: string | undefined, tokens?: string[]): string[] => {
    if (!text && !tokens) return [];
    // With a prefix, ids inside longer words too (a branch named snagboat-koh-volume).
    const found = byPrefix ? (tokens ?? [text!]).flatMap((t) => [...t.matchAll(byPrefix)].map((m) => m[0])) : (tokens ?? idTokens(text!));
    return [...new Set(found)].filter((t) => items.has(t));
  };
  const commits = [...input.commits].sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.sha.localeCompare(b.sha));
  const commitBySha = new Map(commits.map((c) => [c.sha, c]));
  const findCommit = (sha: string): CommitRecord | undefined => {
    const exact = commitBySha.get(sha);
    if (exact) return exact;
    const matches = commits.filter((c) => c.sha.startsWith(sha));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const branchesByName = new Map<string, BranchRecord[]>();
  for (const b of input.branches) branchesByName.set(b.name, [...(branchesByName.get(b.name) ?? []), b]);
  /** The branch record a name meant at a time: alive then, the latest started before it. */
  const branchAt = (name: string, at: number): BranchRecord | undefined => {
    const all = branchesByName.get(name);
    if (!all) return undefined;
    const alive = all.filter((b) => !b.deletedAt || ms(b.deletedAt) >= at);
    const pool = alive.length > 0 ? alive : all;
    const start = (b: BranchRecord) => ms(b.createdAt ?? b.firstSeenAt);
    const before = pool.filter((b) => start(b) <= at).sort((a, b) => start(b) - start(a));
    return before[0] ?? [...pool].sort((a, b) => start(a) - start(b))[0];
  };
  const transitionsByItem = new Map<string, TransitionRecord[]>();
  for (const t of [...input.transitions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) transitionsByItem.set(t.item, [...(transitionsByItem.get(t.item) ?? []), t]);
  const checkouts = [...input.checkouts].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  interface Owned {
    s: SessionFacts;
    workspace: string;
    where: string;
  }
  const sessions: Owned[] = [];
  for (const w of input.workspaces) for (const s of w.sessions) sessions.push({ s, workspace: w.workspace, where: w.where });
  sessions.sort((a, b) => a.s.first - b.s.first || a.s.sessionId.localeCompare(b.s.sessionId));
  const sessionEnd = (s: SessionFacts): LinkEnd => ({ type: 'session', id: s.sessionId });

  // -- session made commit, observed: refs.commit, or a git commit call and a commit within 60 s.
  for (const { s, workspace } of sessions) {
    const calls = [...s.calls.values()].sort((a, b) => a.at - b.at);
    const committers = new Set<string>();
    for (const c of calls) {
      if (!c.refs?.commit) continue;
      const commit = findCommit(c.refs.commit);
      if (!commit) continue;
      committers.add(commit.committer);
      drafts.add({ from: sessionEnd(s), to: { type: 'commit', id: commit.sha }, kind: 'made', confidence: 'observed', rule: 'tool-call-commit', refs: [c.eventId, commit.sha], at: Math.max(c.at, ms(commit.committedAt)), workspace, slot: `made:${commit.sha}` });
    }
    for (const c of calls) {
      if (c.refs?.commit || !(c.gitCommit || c.prMerge)) continue;
      const near = commits
        .filter((k) => {
          const at = ms(k.committedAt);
          return at >= c.at - COMMIT_BEFORE_CALL_MS && at <= c.at + COMMIT_AFTER_CALL_MS && (c.prMerge || k.kind !== 'merge');
        })
        // By the same committer as the session's other commits, when it has any.
        .filter((k) => committers.size === 0 || committers.has(k.committer))
        .sort((a, b) => Math.abs(ms(a.committedAt) - c.at) - Math.abs(ms(b.committedAt) - c.at));
      const commit = near[0];
      if (!commit) continue;
      drafts.add({ from: sessionEnd(s), to: { type: 'commit', id: commit.sha }, kind: 'made', confidence: 'observed', rule: 'git-commit-call', refs: [c.eventId, commit.sha], at: Math.max(c.at, ms(commit.committedAt)), workspace, slot: `made:${commit.sha}` });
    }
  }
  // -- session made commit, inferred: the git outcomes rule, over every worktree's sessions.
  const gitSessions = sessions.map((o) => ({ ...asGitSession(o.s, o.where), owned: o }));
  for (const commit of commits) {
    if (commit.kind === 'merge') continue;
    const best = sessionForCommit({ sha: commit.sha, at: ms(commit.committedAt), files: commit.files.map((f) => f.path) }, gitSessions);
    if (!best) continue;
    const edits = [...new Set(best.files.flatMap((f) => best.session.files.get(f) ?? []))];
    const { s, workspace } = best.session.owned;
    drafts.add({ from: sessionEnd(s), to: { type: 'commit', id: commit.sha }, kind: 'made', confidence: 'inferred', rule: 'git-outcomes', refs: [commit.sha, ...edits.slice(0, MAX_REFS - 1)], at: ms(commit.committedAt), workspace, slot: `made:${commit.sha}` });
  }
  drafts.preferObserved('made');

  // -- session worked-on branch.
  for (const { s, workspace, where } of sessions) {
    const here = checkouts.filter((c) => c.where === where);
    for (const c of here) {
      const at = ms(c.at);
      if (at < s.first || at > s.last) continue;
      const branch = branchAt(c.to, at);
      if (branch) drafts.add({ from: sessionEnd(s), to: { type: 'branch', id: branch.id }, kind: 'worked-on', confidence: 'observed', rule: 'checkout', refs: [c.id], at, workspace });
    }
    for (const c of s.calls.values()) {
      if (!c.refs?.branch) continue;
      const branch = branchAt(c.refs.branch, c.at);
      if (branch) drafts.add({ from: sessionEnd(s), to: { type: 'branch', id: branch.id }, kind: 'worked-on', confidence: 'observed', rule: 'tool-call-branch', refs: [c.eventId], at: c.at, workspace });
    }
    const start = [...here].reverse().find((c) => ms(c.at) <= s.first);
    if (start) {
      const branch = branchAt(start.to, s.first);
      if (branch) drafts.add({ from: sessionEnd(s), to: { type: 'branch', id: branch.id }, kind: 'worked-on', confidence: 'inferred', rule: 'branch-at-start', refs: [start.id], at: s.first, workspace });
    }
  }

  // -- session touched plan item, and transition made-in session, observed: bd calls.
  for (const { s, workspace } of sessions) {
    for (const c of [...s.calls.values()].sort((a, b) => a.at - b.at)) {
      for (const itemId of c.refs?.planItems ?? []) {
        if (!items.has(itemId)) continue;
        const action = c.command ? (c.bd.find((b) => b.items.includes(itemId)) ?? c.bd.find((b) => ['create', 'new', 'q'].includes(b.sub))) : undefined;
        const touch = c.command ? bdTouch(action) : { how: undefined, types: 'any' as const };
        const near = (transitionsByItem.get(itemId) ?? []).filter((t) => {
          const at = ms(t.at);
          return at >= c.at - TRANSITION_BEFORE_CALL_MS && at <= c.at + TRANSITION_AFTER_CALL_MS && (touch.types === 'any' || (touch.types !== 'none' && touch.types.includes(t.type)));
        });
        const item: LinkEnd = { type: 'plan-item', id: itemId };
        const slot = `touched:${s.sessionId}:${itemId}`;
        if (near.length > 0) {
          for (const t of near) {
            // bd comments add: a comment is an update.
            const how = touch.how === undefined ? touchOf(t) : touch.how === 'mentioned' ? 'updated' : touch.how;
            drafts.add({ from: sessionEnd(s), to: item, kind: 'touched', how, confidence: 'observed', rule: 'bd-call', refs: [c.eventId, t.id], at: Math.max(c.at, ms(t.at)), workspace, slot });
            drafts.add({ from: { type: 'transition', id: t.id }, to: sessionEnd(s), kind: 'made-in', confidence: 'observed', rule: 'bd-call', refs: [c.eventId], at: Math.max(c.at, ms(t.at)), workspace, slot: `made-in:${t.id}` });
          }
        } else if (touch.how === undefined || touch.how === 'mentioned') {
          // bd show or comments (or a call whose command wasn't recorded): the call named the item, and nothing changed.
          drafts.add({ from: sessionEnd(s), to: item, kind: 'touched', how: 'mentioned', confidence: 'observed', rule: 'bd-call', refs: [c.eventId], at: c.at, workspace, slot });
        } else {
          // A change whose transition isn't recorded (yet): the same link turns observed when it is.
          drafts.add({ from: sessionEnd(s), to: item, kind: 'touched', how: touch.how, confidence: 'inferred', rule: 'bd-call', refs: [c.eventId], at: c.at, workspace, slot });
        }
      }
    }
  }

  // -- commit references plan item.
  const refsOfText = (c: CommitRecord) => itemsIn(`${c.subject}\n${c.body ?? ''}`);
  for (const c of commits) {
    for (const id of refsOfText(c)) {
      drafts.add({ from: { type: 'commit', id: c.sha }, to: { type: 'plan-item', id }, kind: 'references', confidence: 'observed', rule: 'commit-message', refs: [c.sha], at: ms(c.committedAt) });
    }
  }
  const mainNames = new Set(['main', 'master']);
  for (const b of input.branches) {
    const named = itemsIn(b.name);
    const viaMerge = b.merged ? commitBySha.get(b.merged.commit) : undefined;
    const merged = viaMerge && (b.merged!.via === 'merge' || b.merged!.via === 'squash') ? refsOfText(viaMerge) : [];
    if (named.length === 0 && merged.length === 0) continue;
    const since = ms(b.createdAt);
    const into = b.merged?.into;
    // The branch's own commits: on it, and since it was made (or, not knowing when, not on the branch work goes into).
    const own = commits.filter((c) => c.onBranches.includes(b.name) && c.kind !== 'merge' && (Number.isFinite(since) ? ms(c.committedAt) >= since : !c.onBranches.some((n) => n === into || mainNames.has(n))));
    for (const c of own) {
      for (const id of named) drafts.add({ from: { type: 'commit', id: c.sha }, to: { type: 'plan-item', id }, kind: 'references', confidence: 'inferred', rule: 'branch-name', refs: [b.id], at: ms(c.committedAt) });
      for (const id of merged) drafts.add({ from: { type: 'commit', id: c.sha }, to: { type: 'plan-item', id }, kind: 'references', confidence: 'inferred', rule: 'pull-request', refs: [viaMerge!.sha, b.id], at: ms(c.committedAt) });
    }
    // The merge or squash commit stands for the pull request, which the branch is named for.
    if (viaMerge) for (const id of named) drafts.add({ from: { type: 'commit', id: viaMerge.sha }, to: { type: 'plan-item', id }, kind: 'references', confidence: 'inferred', rule: 'pull-request', refs: [b.id], at: ms(viaMerge.committedAt) });
  }

  // -- session touched plan item, inferred: a prompt or reply names it, or a commit it made references it.
  for (const { s, workspace } of sessions) {
    for (const [eventId, m] of s.mentions) {
      for (const id of itemsIn(undefined, m.ids)) drafts.add({ from: sessionEnd(s), to: { type: 'plan-item', id }, kind: 'touched', how: 'mentioned', confidence: 'inferred', rule: 'text-mention', refs: [eventId], at: m.at, workspace, slot: `touched:${s.sessionId}:${id}` });
    }
  }
  const references = drafts.of('references');
  for (const [, made] of drafts.of('made')) {
    const owner = sessions.find((o) => o.s.sessionId === made.from.id);
    if (!owner) continue;
    for (const [, ref] of references) {
      if (ref.from.id !== made.to.id) continue;
      drafts.add({ from: made.from, to: ref.to, kind: 'touched', how: 'mentioned', confidence: 'inferred', rule: 'commit-references', refs: [made.to.id], at: ref.at, workspace: owner.workspace, slot: `touched:${made.from.id}:${ref.to.id}` });
    }
  }

  // -- transition made-in session, inferred: the one session with activity near it and a sign of
  // the item (it touched the item, or ran bd then), by its person. None, or two: no link.
  const persons = new Map<string, Set<string>>();
  const personOf = (sessionId: string) => {
    let set = persons.get(sessionId);
    if (!set) persons.set(sessionId, (set = new Set()));
    return set;
  };
  for (const [, d] of drafts.of('made-in')) {
    const t = input.transitions.find((x) => x.id === d.from.id);
    if (t) for (const p of identParts(t.actor)) personOf(d.to.id).add(p);
  }
  for (const [, d] of drafts.of('made')) {
    if (!d.observed) continue;
    const c = commitBySha.get(d.to.id);
    if (c) for (const p of identParts(c.committer)) personOf(d.from.id).add(p);
  }
  // The touched links (observed or inferred: bd calls, the id in a prompt or reply, a commit it made), by session and item.
  const touchedLinks = new Map<string, string[]>();
  for (const [id, d] of drafts.of('touched')) {
    const key = `${d.from.id}\n${d.to.id}`;
    touchedLinks.set(key, [...(touchedLinks.get(key) ?? []), id]);
  }
  const activeNear = (s: SessionFacts, at: number): boolean => {
    for (let m = Math.floor((at - MADE_IN_NEAR_MS) / MINUTE_MS); m <= Math.floor((at + MADE_IN_NEAR_MS) / MINUTE_MS); m++) if (s.minutes.has(m)) return true;
    return false;
  };
  const bdCallsNear = (s: SessionFacts, at: number): string[] =>
    [...s.calls.values()]
      .filter((c) => Math.abs(c.at - at) <= MADE_IN_NEAR_MS && (c.bd.length > 0 || (c.refs?.planItems?.length ?? 0) > 0))
      .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at) || a.eventId.localeCompare(b.eventId))
      .map((c) => c.eventId);
  const observedTransitions = new Set(drafts.of('made-in').map(([, d]) => d.from.id));
  for (const t of input.transitions) {
    if (observedTransitions.has(t.id)) continue;
    const at = ms(t.at);
    if (!Number.isFinite(at)) continue;
    const signed = sessions
      .filter((o) => activeNear(o.s, at))
      .map((o) => ({ o, touched: touchedLinks.get(`${o.s.sessionId}\n${t.item}`) ?? [], bd: bdCallsNear(o.s, at) }))
      .filter((c) => c.touched.length > 0 || c.bd.length > 0);
    if (signed.length !== 1) continue;
    const { o, touched, bd } = signed[0];
    const { s, workspace } = o;
    const known = persons.get(s.sessionId);
    if (known && known.size > 0 && !identParts(t.actor).some((p) => known.has(p))) continue;
    const base = { from: { type: 'transition', id: t.id } as LinkEnd, to: sessionEnd(s), kind: 'made-in' as const, confidence: 'inferred' as const, at, workspace, slot: `made-in:${t.id}` };
    if (touched.length > 0) drafts.add({ ...base, rule: 'active-session-touched', refs: [t.id, ...touched] });
    if (bd.length > 0) drafts.add({ ...base, rule: 'active-session-bd', refs: [t.id, ...bd] });
  }
  drafts.preferObserved('made-in');

  // -- branch merged into branch.
  for (const b of input.branches) {
    if (!b.merged) continue;
    const at = ms(b.merged.at);
    const into = branchAt(b.merged.into, at);
    if (!into || into.id === b.id) continue;
    const observed = b.merged.via === 'merge' || b.merged.via === 'squash';
    const rule: LinkRule = b.merged.via === 'merge' ? 'merge-commit' : b.merged.via === 'squash' ? 'squash-commit' : 'reachable';
    drafts.add({ from: { type: 'branch', id: b.id }, to: { type: 'branch', id: into.id }, kind: 'merged', confidence: observed ? 'observed' : 'inferred', rule, refs: [b.merged.commit, b.id], at });
  }

  return drafts.records();
}

// ---- what to append -------------------------------------------------------------------------

/** The slot a stored link was in, worked out again from its ends (ComputedLink.slot). */
export function slotOf(link: LinkRecord): string | undefined {
  if (link.kind === 'made') return `made:${link.to.id}`;
  if (link.kind === 'made-in') return `made-in:${link.from.id}`;
  if (link.kind === 'touched') return `touched:${link.from.id}:${link.to.id}`;
  return undefined;
}

/**
 * A stored inferred made-in link the rules no longer give, with nothing in its place, that the
 * rules withdrew: given only by the retired 'active-session' rule (always), or by the made-in
 * rules about a session they still read (`sessions`), so they saw its events and found too
 * little. A link about a session they no longer read stays: its events may only be past retention.
 */
export function withdrawnLink(link: LinkRecord, sessions?: ReadonlySet<string>): boolean {
  if (link.kind !== 'made-in' || link.confidence !== 'inferred' || link.evidence.length === 0) return false;
  if (!link.evidence.every((e) => MADE_IN_INFERRED.has(e.rule))) return false;
  return link.evidence.every((e) => e.rule === 'active-session') || (sessions?.has(link.to.id) ?? false);
}

/**
 * What to append to a links.jsonl holding `stored` (its lines, folded) so its current links are
 * `wanted`: each new or changed link, and each current stored link the rules no longer give
 * (in `all`, the repository's links) whose slot has another link now, again with supersededBy. A stored link the rules no longer
 * give with nothing in its place stays (its evidence may be past retention, or text removed),
 * except an inferred made-in link the rules withdrew (withdrawnLink; `sessions`: the ids of the
 * sessions the rules read), appended again with supersededBy LINK_WITHDRAWN.
 */
export function linksToAppend(stored: Map<string, LinkRecord>, wanted: ComputedLink[], all: ComputedLink[] = wanted, sessions?: ReadonlySet<string>): LinkRecord[] {
  const out: LinkRecord[] = [];
  const current = new Set(all.map((w) => w.link.id));
  const bySlot = new Map<string, LinkRecord[]>();
  for (const w of wanted) {
    const have = stored.get(storeRecordKey(w.link));
    if (!have || have.supersededBy !== undefined || JSON.stringify(have) !== JSON.stringify(w.link)) out.push(w.link);
  }
  // Slots across the whole repository: a commit's link can move to a session in another worktree.
  for (const w of all) if (w.slot) bySlot.set(w.slot, [...(bySlot.get(w.slot) ?? []), w.link]);
  for (const have of stored.values()) {
    if (have.record !== 'link' || have.supersededBy !== undefined || current.has(have.id)) continue;
    const slot = slotOf(have);
    const instead = slot ? bySlot.get(slot) : undefined;
    if (!instead || instead.length === 0) {
      if (withdrawnLink(have, sessions)) out.push({ ...have, supersededBy: LINK_WITHDRAWN });
      continue;
    }
    const by = instead.find((l) => l.confidence === 'observed') ?? instead[0];
    out.push({ ...have, supersededBy: by.id });
  }
  return out;
}
