import { CheckoutRecord, currentLinks, GitRecord, isConversationEvent, LinkRecord, NormalizedEvent, SessionIndex, SessionRecord } from '@snagboat/schema';

/**
 * A workspace's sessions as sessions.jsonl has them (SessionRecord, packages/schema
 * exportRecords.ts): what `snagboat sessions --json` prints for each, plus its subagents' ids,
 * where it ran, and the branches, commits and plan items the linker linked it to. The store's
 * values, raw: `where` is the working tree's absolute path, which the export's privacy filter
 * rewrites as '.' or '[worktree-N]'. The export command and the plans view (GET /plans) build them here.
 */
export interface SessionRecordInput {
  /** The workspace's events (any order; outcomes and names included or not). */
  events: Iterable<NormalizedEvent>;
  /** Its links.jsonl lines (folded here: superseded links don't count). */
  links: Iterable<LinkRecord>;
  /** Its git.jsonl lines, for branch names and the order of commits and checkouts. */
  git?: Iterable<GitRecord>;
  /** Its working tree's root (or folder). */
  where: string;
  /** Only these sessions; default every one. */
  only?: ReadonlySet<string>;
}

/** The name in a branch's id (`${name}@${firstSeenAt}`). */
export function branchNameOf(id: string): string {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/** Session records, most recent activity first (as SessionIndex lists them). */
export function sessionRecords(input: SessionRecordInput): SessionRecord[] {
  const index = new SessionIndex();
  const subagents = new Map<string, Set<string>>();
  for (const e of input.events) {
    if (input.only && !input.only.has(e.sessionId)) continue;
    index.ingest(e);
    if (e.agentId && isConversationEvent(e)) {
      let set = subagents.get(e.sessionId);
      if (!set) subagents.set(e.sessionId, (set = new Set()));
      set.add(e.agentId);
    }
  }
  const commitsAt = new Map<string, string>();
  const branchNames = new Map<string, string>();
  const checkouts = new Map<string, CheckoutRecord>();
  for (const r of input.git ?? []) {
    if (r.record === 'commit') commitsAt.set(r.sha, r.committedAt);
    else if (r.record === 'branch') branchNames.set(r.id, r.name);
    else checkouts.set(r.id, r);
  }
  const bySession = new Map<string, LinkRecord[]>();
  for (const l of currentLinks(input.links)) {
    const session = l.from.type === 'session' ? l.from.id : undefined;
    if (!session) continue;
    bySession.set(session, [...(bySession.get(session) ?? []), l]);
  }
  return index.list().map((summary) => {
    const links = bySession.get(summary.sessionId) ?? [];
    // Branches in the order it was on them: the one it started on, then its checkouts, by time.
    const branchOrder = (l: LinkRecord) => {
      if (l.evidence.some((e) => e.rule === 'branch-at-start')) return '';
      const times = l.evidence.flatMap((e) => e.refs.map((r) => checkouts.get(r)?.at).filter((t): t is string => !!t));
      return times.sort()[0] ?? l.at ?? '~';
    };
    const branches: string[] = [];
    for (const l of links.filter((l) => l.kind === 'worked-on').sort((a, b) => branchOrder(a).localeCompare(branchOrder(b)))) {
      const name = branchNames.get(l.to.id) ?? branchNameOf(l.to.id);
      if (!branches.includes(name)) branches.push(name);
    }
    const commits = links
      .filter((l) => l.kind === 'made' && l.to.type === 'commit')
      .sort((a, b) => (commitsAt.get(a.to.id) ?? a.at ?? '').localeCompare(commitsAt.get(b.to.id) ?? b.at ?? '') || a.to.id.localeCompare(b.to.id))
      .map((l) => ({ sha: l.to.id, confidence: l.confidence }));
    const planItems = links
      .filter((l) => l.kind === 'touched' && l.to.type === 'plan-item' && l.how)
      .sort((a, b) => a.to.id.localeCompare(b.to.id) || a.how!.localeCompare(b.how!))
      .map((l) => ({ id: l.to.id, how: l.how!, confidence: l.confidence }));
    return {
      ...summary,
      subagentIds: [...(subagents.get(summary.sessionId) ?? [])].sort(),
      where: input.where,
      branches,
      commits,
      planItems,
    };
  });
}
