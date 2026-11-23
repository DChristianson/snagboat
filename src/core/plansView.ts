import * as fs from 'fs';
import * as path from 'path';
import {
  BranchRecord,
  CommitRecord,
  Confidence,
  currentLinks,
  GitRecord,
  LinkKind,
  LinkRecord,
  NormalizedEvent,
  PlanItemRecord,
  PlanItemTouch,
  PlanRecord,
  SessionRecord,
  TransitionRecord,
} from '@snagboat/schema';
import { EventLog } from './eventLog';
import { locateRepo } from './gitRecords';
import { issuePrefix } from './links';
import { branchNameOf, sessionRecords } from './sessionRecords';
import { readStoreRecordLines } from './storeRecordFiles';
import { listUserStores, UserStore } from './userStore';
import { GitRunner, runGit } from '../outcomes/gitOutcomes';

/**
 * The plans view (GET /plans?workspace=<ws>): a workspace's plan items, with its sibling
 * worktrees', each with its transitions and what the linker linked to it: the sessions that
 * touched it (with their SessionRecord), the commits that reference it or that those sessions
 * made, and the branches those sessions worked on or that are named for it. Every link carries
 * its confidence and evidence. Read-only: it reads the store's plan.jsonl, git.jsonl,
 * links.jsonl and events, and runs nothing but `git rev-parse` to find the worktrees.
 */

/** One link as the view shows it. */
export interface PlanLinkView {
  /** The link's id in links.jsonl. */
  id: string;
  kind: LinkKind;
  how?: PlanItemTouch;
  confidence: Confidence;
  evidence: LinkRecord['evidence'];
  /** made and worked-on links: the session whose link it is. */
  sessionId?: string;
}

export interface PlanTransitionView {
  transition: TransitionRecord;
  /** The session it was made in (made-in links), if the linker found one. */
  sessions: Array<{ sessionId: string; link: PlanLinkView }>;
}

export interface PlanSessionView {
  sessionId: string;
  /** The workspace whose store holds it. */
  workspace: string;
  /** Its session record; absent when its events are past retention. */
  session?: SessionRecord;
  /** touched links (one per way) and made-in links of the item's transitions. */
  links: PlanLinkView[];
}

export interface PlanCommitView {
  sha: string;
  commit?: Pick<CommitRecord, 'subject' | 'committedAt' | 'author' | 'kind' | 'onBranches'> & { pr?: number };
  /** references links, and made links of the item's sessions. */
  links: PlanLinkView[];
}

export interface PlanBranchView {
  /** The branch's id (`${name}@${firstSeenAt}`). */
  id: string;
  name: string;
  branch?: Pick<BranchRecord, 'head' | 'firstSeenAt'> & { createdAt?: string; merged?: BranchRecord['merged']; deletedAt?: string };
  /** worked-on links of the item's sessions, and references links whose evidence is the branch (named for the item). */
  links: PlanLinkView[];
}

export interface PlanItemView {
  item: PlanItemRecord;
  /** Oldest first. */
  transitions: PlanTransitionView[];
  sessions: PlanSessionView[];
  commits: PlanCommitView[];
  branches: PlanBranchView[];
}

export interface PlansView {
  workspace: string;
  /** The workspaces read: it and its sibling worktrees (those the caller may read). */
  workspaces: string[];
  /** The project's bead prefix, when there are beads. */
  prefix?: string;
  /** Most recently updated first. */
  items: PlanItemView[];
}

export interface PlansViewOptions {
  home: string;
  workspace: string;
  /** Which workspaces the caller may read (a workspace token: only its own). Default: all. */
  visible?: (workspace: string) => boolean;
  git?: GitRunner;
}

const view = (l: LinkRecord, sessionId?: string): PlanLinkView => ({
  id: l.id,
  kind: l.kind,
  ...(l.how ? { how: l.how } : {}),
  confidence: l.confidence,
  evidence: l.evidence,
  ...(sessionId ? { sessionId } : {}),
});

/** The workspace's store and its sibling worktrees' (same git common dir), the asked-for one first. */
export async function siblingStores(home: string, workspace: string, git: GitRunner = runGit): Promise<UserStore[]> {
  const stores = listUserStores(home);
  const own = stores.find((s) => s.workspace === workspace);
  if (!own) return [];
  const common = own.folder && fs.existsSync(own.folder) ? (await locateRepo(own.folder, git))?.commonDir : undefined;
  if (!common) return [own];
  const out = [own];
  for (const s of stores) {
    if (s === own || !s.folder || !fs.existsSync(s.folder)) continue;
    if ((await locateRepo(s.folder, git))?.commonDir === common) out.push(s);
  }
  return out;
}

export async function plansView(opts: PlansViewOptions): Promise<PlansView> {
  const visible = opts.visible ?? (() => true);
  const stores = (await siblingStores(opts.home, opts.workspace, opts.git)).filter((s) => s.workspace === opts.workspace || visible(s.workspace));
  const items = new Map<string, PlanItemRecord>();
  const transitions = new Map<string, TransitionRecord>();
  const commits = new Map<string, CommitRecord>();
  const branches = new Map<string, BranchRecord>();
  const links = new Map<string, { link: LinkRecord; workspace: string }>();
  const git = new Map<string, GitRecord[]>();
  const linkLines = new Map<string, LinkRecord[]>();
  for (const s of stores) {
    for (const r of readStoreRecordLines<PlanRecord>(path.join(s.dir, 'plan.jsonl'))) {
      if (r.record === 'item') {
        const have = items.get(r.id);
        if (!have || r.updated >= have.updated) items.set(r.id, r);
      }
      else if (r.record === 'transition') transitions.set(r.id, r);
    }
    const gitLines = readStoreRecordLines<GitRecord>(path.join(s.dir, 'git.jsonl'));
    git.set(s.workspace, gitLines);
    for (const r of gitLines) {
      if (r.record === 'commit') commits.set(r.sha, r);
      else if (r.record === 'branch') branches.set(r.id, r);
    }
    const lines = readStoreRecordLines<LinkRecord>(path.join(s.dir, 'links.jsonl'));
    linkLines.set(s.workspace, lines);
    for (const l of currentLinks(lines)) if (!links.has(l.id) || l.from.type === 'session' || l.to.type === 'session') links.set(l.id, { link: l, workspace: s.workspace });
  }

  // Each session's workspace, and its links.
  const sessionWorkspace = new Map<string, string>();
  const sessionLinks = new Map<string, LinkRecord[]>();
  for (const { link, workspace } of links.values()) {
    const session = link.from.type === 'session' ? link.from.id : link.to.type === 'session' ? link.to.id : undefined;
    if (!session) continue;
    sessionWorkspace.set(session, workspace);
    sessionLinks.set(session, [...(sessionLinks.get(session) ?? []), link]);
  }
  const all = [...links.values()].map((x) => x.link);
  const madeIn = new Map<string, LinkRecord[]>();
  const toItem = new Map<string, LinkRecord[]>();
  for (const l of all) {
    if (l.kind === 'made-in' && l.from.type === 'transition') madeIn.set(l.from.id, [...(madeIn.get(l.from.id) ?? []), l]);
    if (l.to.type === 'plan-item') toItem.set(l.to.id, [...(toItem.get(l.to.id) ?? []), l]);
  }
  const itemTransitions = new Map<string, TransitionRecord[]>();
  for (const t of transitions.values()) itemTransitions.set(t.item, [...(itemTransitions.get(t.item) ?? []), t]);

  const out: PlanItemView[] = [];
  const wantedSessions = new Map<string, Set<string>>();
  for (const item of items.values()) {
    const linked = toItem.get(item.id) ?? [];
    const touched = linked.filter((l) => l.kind === 'touched');
    const own = [...(itemTransitions.get(item.id) ?? [])].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const transitionViews: PlanTransitionView[] = own.map((t) => ({ transition: t, sessions: (madeIn.get(t.id) ?? []).map((l) => ({ sessionId: l.to.id, link: view(l) })) }));

    const sessions = new Map<string, PlanSessionView>();
    const sessionView = (sessionId: string) => {
      let v = sessions.get(sessionId);
      if (!v) sessions.set(sessionId, (v = { sessionId, workspace: sessionWorkspace.get(sessionId) ?? opts.workspace, links: [] }));
      return v;
    };
    for (const l of touched) sessionView(l.from.id).links.push(view(l));
    for (const t of transitionViews) for (const s of t.sessions) sessionView(s.sessionId).links.push(s.link);

    const commitViews = new Map<string, PlanCommitView>();
    const commitView = (sha: string) => {
      let v = commitViews.get(sha);
      if (!v) {
        const c = commits.get(sha);
        commitViews.set(sha, (v = { sha, ...(c ? { commit: { subject: c.subject, committedAt: c.committedAt, author: c.author, kind: c.kind, onBranches: c.onBranches, ...(c.pr !== undefined ? { pr: c.pr } : {}) } } : {}), links: [] }));
      }
      return v;
    };
    const branchViews = new Map<string, PlanBranchView>();
    const branchView = (id: string) => {
      let v = branchViews.get(id);
      if (!v) {
        const b = branches.get(id);
        branchViews.set(
          id,
          (v = {
            id,
            name: b?.name ?? branchNameOf(id),
            ...(b ? { branch: { head: b.head, firstSeenAt: b.firstSeenAt, ...(b.createdAt ? { createdAt: b.createdAt } : {}), ...(b.merged ? { merged: b.merged } : {}), ...(b.deletedAt ? { deletedAt: b.deletedAt } : {}) } } : {}),
            links: [],
          })
        );
      }
      return v;
    };
    for (const l of linked) {
      if (l.kind !== 'references') continue;
      commitView(l.from.id).links.push(view(l));
      for (const e of l.evidence) {
        if (e.rule !== 'branch-name' && e.rule !== 'pull-request') continue;
        for (const ref of e.refs) {
          if (!branches.has(ref)) continue;
          const b = branchView(ref);
          if (!b.links.some((x) => x.id === l.id)) b.links.push(view(l));
        }
      }
    }
    for (const sessionId of sessions.keys()) {
      for (const l of sessionLinks.get(sessionId) ?? []) {
        if (l.kind === 'made' && l.to.type === 'commit') commitView(l.to.id).links.push(view(l, sessionId));
        if (l.kind === 'worked-on' && l.to.type === 'branch') branchView(l.to.id).links.push(view(l, sessionId));
      }
      const ws = sessionWorkspace.get(sessionId) ?? opts.workspace;
      let set = wantedSessions.get(ws);
      if (!set) wantedSessions.set(ws, (set = new Set()));
      set.add(sessionId);
    }
    out.push({
      item,
      transitions: transitionViews,
      sessions: [...sessions.values()],
      commits: [...commitViews.values()].sort((a, b) => (a.commit?.committedAt ?? '').localeCompare(b.commit?.committedAt ?? '') || a.sha.localeCompare(b.sha)),
      branches: [...branchViews.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    });
  }

  // The linked sessions' records, from each workspace's events.
  const records = new Map<string, SessionRecord>();
  for (const s of stores) {
    const only = wantedSessions.get(s.workspace);
    if (!only || only.size === 0) continue;
    const log = new EventLog(s.dir);
    const events: NormalizedEvent[] = [];
    for (const day of await log.listDays()) for (const e of await log.readDay(day)) if (only.has(e.sessionId)) events.push(e);
    const where = s.folder ? ((await locateRepo(s.folder, opts.git ?? runGit).catch(() => undefined))?.toplevel ?? s.folder) : s.workspace;
    for (const r of sessionRecords({ events, links: linkLines.get(s.workspace) ?? [], git: git.get(s.workspace), where, only })) records.set(r.sessionId, r);
  }
  for (const v of out) {
    for (const s of v.sessions) {
      const r = records.get(s.sessionId);
      if (r) s.session = r;
    }
    v.sessions.sort((a, b) => (b.session?.lastTs ?? '').localeCompare(a.session?.lastTs ?? '') || a.sessionId.localeCompare(b.sessionId));
  }
  out.sort((a, b) => b.item.updated.localeCompare(a.item.updated) || a.item.id.localeCompare(b.item.id));
  const prefix = issuePrefix(stores.map((s) => s.folder).filter((f): f is string => !!f), items.values());
  return { workspace: opts.workspace, workspaces: stores.map((s) => s.workspace), ...(prefix ? { prefix } : {}), items: out };
}
