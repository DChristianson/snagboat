import type {
  BranchRecord,
  CheckoutRecord,
  CommitRecord,
  ExportedEvent,
  FindingRecord,
  GitRecord,
  LinkEnd,
  LinkRecord,
  NormalizedEvent,
  PlanItemRecord,
  PlanRecord,
  SessionRecord,
  TransitionRecord,
} from '@snagboat/schema';
import { isAgentIdentity, parseIdent } from './filter';

/**
 * The one place that knows the export's record structure (docs/design/export.md, "The privacy
 * filter"): which fields of each record are free text, which name people, which are ids, and
 * which are left out. It hands each string to a function and writes back what comes out; it
 * doesn't know what the function does. snagboat export (exportProject.ts) walks the records
 * twice with it: once to scan every string the filter will see, once to apply the decisions.
 *
 * Output records are built field by field from the fields named here, so anything else a stored
 * record carries (an event's workspace and raw, a field added later) is dropped. Times are
 * written in UTC, without git's timezone offsets.
 */

/** One project's selected store records. */
export interface ExportInput {
  events?: NormalizedEvent[];
  sessions?: SessionRecord[];
  git?: GitRecord[];
  plan?: PlanRecord[];
  links?: LinkRecord[];
  findings?: FindingRecord[];
}

/** The export's records, as its files hold them. */
export interface ExportRecords {
  events: ExportedEvent[];
  sessions: SessionRecord[];
  commits: CommitRecord[];
  branches: BranchRecord[];
  checkouts: CheckoutRecord[];
  planItems: PlanItemRecord[];
  transitions: TransitionRecord[];
  links: LinkRecord[];
  findings: FindingRecord[];
}

export interface ExportFieldOptions {
  /** --text none: structure only, no free text. */
  text?: 'redacted' | 'none';
  /** More names to treat as agents, beside the built-in ones. */
  agentNames?: string[];
}

/** ISO 8601 in UTC (any offset dropped); a value that doesn't parse is kept. */
export function utc(ts: string): string {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? ts : new Date(t).toISOString();
}

function pickNumbers<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (typeof o[k] === 'number') out[k] = o[k];
  return out;
}

/** Builds the export's records from the input, every string the filter sees going through f. */
export function exportRecords(input: ExportInput, f: (text: string) => string, opts: ExportFieldOptions = {}): ExportRecords {
  const none = opts.text === 'none';
  const agents = opts.agentNames ?? [];

  /** A person field: an agent keeps its name (without an email); a person goes through f. */
  const who = (raw: string): string => {
    const { name, email } = parseIdent(raw);
    if (isAgentIdentity(name, email, agents)) return name || raw.trim();
    return f(raw);
  };
  /** A branch id, `<name>@<firstSeenAt>`: the name through f, the time in UTC. */
  const branchId = (id: string): string => {
    const at = id.lastIndexOf('@');
    return at <= 0 ? f(id) : `${f(id.slice(0, at))}@${utc(id.slice(at + 1))}`;
  };
  /**
   * Any record id a link, finding or outcome refers to, by its shape, so the same id comes out
   * the same wherever it appears: SHAs and ids that embed text (event ids with a path or a SHA in
   * them: claude-code:<file>:<offset>, outcome:milestone:<sha>) through f; branch ids by name;
   * session, turn, bead, transition, checkout, link and finding ids kept.
   */
  const ref = (id: string): string => {
    if (/^[0-9a-f]{7,40}$/.test(id) || /[:/\\]/.test(id)) {
      if (/@\d{4}-\d\d-\d\dT/.test(id) && !/[/\\]/.test(id.slice(id.lastIndexOf('@')))) return branchId(id);
      return f(id);
    }
    if (/@\d{4}-\d\d-\d\dT/.test(id)) return branchId(id);
    return id;
  };
  // A transition's id is bd's audit event id, whatever shape that has: by ref(), as evidence names it.
  const linkEnd = (e: LinkEnd): LinkEnd => ({ type: e.type, id: e.type === 'commit' ? f(e.id) : e.type === 'branch' ? branchId(e.id) : e.type === 'transition' ? ref(e.id) : e.id });
  /** Where something ran: a working tree's path through f; '.' and placeholders as they are. */
  const where = (raw: string) => (raw === '.' || /^\[(?:worktree|match)-\d+\]$/.test(raw) ? raw : f(raw));

  const out: ExportRecords = { events: [], sessions: [], commits: [], branches: [], checkouts: [], planItems: [], transitions: [], links: [], findings: [] };

  for (const c of (input.git ?? []).filter((r): r is CommitRecord => r.record === 'commit')) {
    const o: CommitRecord = {
      record: 'commit',
      version: 1,
      sha: f(c.sha),
      parents: c.parents.map(f),
      kind: c.kind,
      authoredAt: utc(c.authoredAt),
      committedAt: utc(c.committedAt),
      author: who(c.author),
      committer: who(c.committer),
      coAuthors: c.coAuthors.map(who),
      subject: none ? '' : f(c.subject),
      files: c.files.map((file) => {
        const fo: CommitRecord['files'][number] = { path: f(file.path), status: file.status, added: file.added, deleted: file.deleted };
        if (file.from !== undefined) fo.from = f(file.from);
        return fo;
      }),
      onBranches: c.onBranches.map(f),
    };
    if (c.body !== undefined && !none) o.body = f(c.body);
    if (c.pr !== undefined) o.pr = c.pr;
    if (c.reverts !== undefined) o.reverts = f(c.reverts);
    out.commits.push(o);
  }
  for (const b of (input.git ?? []).filter((r): r is BranchRecord => r.record === 'branch')) {
    const o: BranchRecord = { record: 'branch', version: 1, id: branchId(b.id), name: f(b.name), firstSeenAt: utc(b.firstSeenAt), head: f(b.head) };
    if (b.createdAt !== undefined) o.createdAt = utc(b.createdAt);
    if (b.from !== undefined) o.from = f(b.from);
    if (b.merged) {
      o.merged = { into: f(b.merged.into), at: utc(b.merged.at), via: b.merged.via, commit: f(b.merged.commit) };
      if (b.merged.pr !== undefined) o.merged.pr = b.merged.pr;
    }
    if (b.deletedAt !== undefined) o.deletedAt = utc(b.deletedAt);
    out.branches.push(o);
  }
  for (const c of (input.git ?? []).filter((r): r is CheckoutRecord => r.record === 'checkout')) {
    out.checkouts.push({ record: 'checkout', version: 1, id: c.id, at: utc(c.at), from: f(c.from), to: f(c.to), commit: f(c.commit), where: where(c.where) });
  }

  for (const p of (input.plan ?? []).filter((r): r is PlanItemRecord => r.record === 'item')) {
    const o: PlanItemRecord = {
      record: 'item',
      version: 1,
      id: p.id,
      kind: p.kind,
      title: none ? '' : f(p.title),
      status: p.status,
      labels: p.labels.map(f),
      created: utc(p.created),
      updated: utc(p.updated),
      source: p.source,
      confidence: p.confidence,
    };
    if (p.priority !== undefined) o.priority = p.priority;
    if (p.parent !== undefined) o.parent = p.parent;
    if (p.blockedBy) o.blockedBy = [...p.blockedBy];
    if (p.started !== undefined) o.started = utc(p.started);
    if (p.closed !== undefined) o.closed = utc(p.closed);
    if (p.closeReason !== undefined && !none) o.closeReason = f(p.closeReason);
    if (p.assignee !== undefined) o.assignee = who(p.assignee);
    if (p.owner !== undefined) o.owner = who(p.owner);
    if (p.createdBy !== undefined) o.createdBy = who(p.createdBy);
    if (p.text && !none) {
      const t: NonNullable<PlanItemRecord['text']> = {};
      for (const k of ['description', 'design', 'notes', 'acceptance'] as const) {
        const v = p.text[k];
        if (v !== undefined) t[k] = f(v);
      }
      o.text = t;
    }
    if (p.from) {
      o.from = { file: f(p.from.file) };
      if (p.from.heading !== undefined && !none) o.from.heading = f(p.from.heading);
    }
    out.planItems.push(o);
  }
  for (const t of (input.plan ?? []).filter((r): r is TransitionRecord => r.record === 'transition')) {
    const o: TransitionRecord = { record: 'transition', version: 1, id: ref(t.id), item: t.item, at: utc(t.at), type: t.type, actor: who(t.actor), confidence: t.confidence };
    if (t.from !== undefined) o.from = f(t.from);
    if (t.to !== undefined) o.to = f(t.to);
    if (t.fields) o.fields = [...t.fields];
    out.transitions.push(o);
  }

  for (const e of input.events ?? []) out.events.push(exportEvent(e, f, ref, none));

  for (const s of input.sessions ?? []) {
    const o: SessionRecord = {
      sessionId: s.sessionId,
      agent: s.agent,
      firstTs: utc(s.firstTs),
      lastTs: utc(s.lastTs),
      models: s.models.map(f),
      prompts: s.prompts,
      modelCalls: s.modelCalls,
      toolCalls: s.toolCalls,
      tokens: s.tokens,
      subagents: s.subagents,
      days: [...s.days],
      subagentIds: [...s.subagentIds],
      where: where(s.where),
      branches: s.branches.map(f),
      commits: s.commits.map((c) => ({ sha: f(c.sha), confidence: c.confidence })),
      planItems: s.planItems.map((p) => ({ id: p.id, how: p.how, confidence: p.confidence })),
    };
    if (s.name !== undefined && !none) o.name = f(s.name);
    out.sessions.push(o);
  }

  // Only current links: one a later link superseded (or the rules withdrew) isn't exported.
  for (const l of (input.links ?? []).filter((x) => x.supersededBy === undefined)) {
    const o: LinkRecord = {
      record: 'link',
      version: 1,
      id: l.id,
      from: linkEnd(l.from),
      to: linkEnd(l.to),
      kind: l.kind,
      confidence: l.confidence,
      evidence: l.evidence.map((ev) => ({ rule: ev.rule, refs: ev.refs.map(ref) })),
    };
    if (l.how !== undefined) o.how = l.how;
    out.links.push(o);
  }

  for (const x of input.findings ?? []) {
    const o: FindingRecord = {
      record: 'finding',
      version: 1,
      id: x.id,
      heuristicId: x.heuristicId,
      heuristicVersion: x.heuristicVersion,
      severity: x.severity,
      firstTs: utc(x.firstTs),
      lastTs: utc(x.lastTs),
      eventRefs: x.eventRefs.map(ref),
      earlyWarning: x.earlyWarning,
      response: x.response,
    };
    if (x.sessionId !== undefined) o.sessionId = x.sessionId;
    if (x.turnId !== undefined) o.turnId = x.turnId;
    if (x.summary !== undefined && !none) o.summary = f(x.summary);
    out.findings.push(o);
  }
  return out;
}

function exportEvent(e: NormalizedEvent, f: (text: string) => string, ref: (id: string) => string, none: boolean): ExportedEvent {
  const out: ExportedEvent = { eventId: ref(e.eventId), sessionId: e.sessionId, agent: e.agent, ts: utc(e.ts), kind: e.kind, status: e.status };
  // A file tool's target is a path, structure even with --text none; a command's isn't.
  const fileTarget = e.kind === 'edit' || e.toolCategory === 'file-read' || e.toolCategory === 'file-edit';
  if (e.target !== undefined && (!none || fileTarget)) out.target = f(e.target);
  if (e.model !== undefined) out.model = f(e.model);
  if (e.tokens) out.tokens = pickNumbers(e.tokens, ['input', 'output', 'cacheRead', 'cacheCreation']);
  if (!none && e.textExcerpt !== undefined) out.textExcerpt = f(e.textExcerpt);
  if (!none && e.promptText !== undefined) out.promptText = f(e.promptText);
  if (!none && e.sessionName !== undefined) out.sessionName = f(e.sessionName);
  if (e.turnId !== undefined) out.turnId = e.turnId;
  if (e.agentId !== undefined) out.agentId = e.agentId;
  if (e.toolName !== undefined) out.toolName = f(e.toolName);
  if (e.toolCategory !== undefined) out.toolCategory = e.toolCategory;
  if (e.todos) {
    out.todos = { pending: e.todos.pending, inProgress: e.todos.inProgress, completed: e.todos.completed };
    if (!none && e.todos.items) out.todos.items = e.todos.items.map((i) => ({ text: f(i.text), status: i.status }));
  }
  if (e.taskOp) {
    const t = e.taskOp;
    out.taskOp = { op: t.op };
    if (t.id !== undefined) out.taskOp.id = t.id;
    if (t.status !== undefined) out.taskOp.status = t.status;
    if (!none && t.subject !== undefined) out.taskOp.subject = f(t.subject);
    if (t.tasks) {
      out.taskOp.tasks = t.tasks.map((task) => {
        const o: { id: string; status: typeof task.status; subject?: string } = { id: task.id, status: task.status };
        if (!none && task.subject !== undefined) o.subject = f(task.subject);
        return o;
      });
    }
  }
  if (e.compaction) out.compaction = { trigger: e.compaction.trigger, ...pickNumbers(e.compaction, ['preTokens', 'postTokens']) };
  if (e.channel !== undefined) out.channel = e.channel;
  if (e.contextLimit !== undefined) out.contextLimit = e.contextLimit;
  if (e.endsTurn) out.endsTurn = true;
  if (e.toolInput) {
    const ti: NonNullable<ExportedEvent['toolInput']> = {};
    if (e.toolInput.path !== undefined) ti.path = f(e.toolInput.path);
    if (!none) {
      for (const k of ['command', 'pattern', 'url', 'description'] as const) {
        const v = e.toolInput[k];
        if (v !== undefined) ti[k] = f(v);
      }
    }
    if (Object.keys(ti).length > 0) out.toolInput = ti;
  }
  if (e.refs) {
    const r: NonNullable<ExportedEvent['refs']> = {};
    if (e.refs.commit !== undefined) r.commit = f(e.refs.commit);
    if (e.refs.branch !== undefined) r.branch = f(e.refs.branch);
    if (e.refs.planItems) r.planItems = [...e.refs.planItems];
    out.refs = r;
  }
  if (e.textTruncated && !none) out.textTruncated = true;
  if (e.outcome) {
    const o = e.outcome;
    const oo: NonNullable<ExportedEvent['outcome']> = { type: o.type };
    if (o.refs) oo.refs = o.refs.map(ref);
    Object.assign(oo, pickNumbers(o, ['failures', 'afterMs', 'files', 'linesWritten', 'linesSurviving', 'days']));
    if (o.heuristicId !== undefined) oo.heuristicId = o.heuristicId;
    if (o.response !== undefined) oo.response = o.response;
    if (o.commit !== undefined) oo.commit = f(o.commit);
    if (o.advisor !== undefined) oo.advisor = f(o.advisor);
    if (o.decision !== undefined) oo.decision = o.decision;
    out.outcome = oo;
  }
  return out;
}

/** The people a set of records names (git idents, Co-Authored-By trailers, bd actors), for the person rule. */
export function peopleIn(input: Pick<ExportInput, 'git' | 'plan'>): string[] {
  const out = new Set<string>();
  for (const r of input.git ?? []) {
    if (r.record !== 'commit') continue;
    out.add(r.author);
    out.add(r.committer);
    for (const a of r.coAuthors) out.add(a);
    for (const m of (r.body ?? '').matchAll(/^[ \t]*Co-Authored-By:[ \t]*([^\n<]*?<[^>\n]*>)/gim)) out.add(m[1]);
  }
  for (const r of input.plan ?? []) {
    if (r.record === 'item') for (const p of [r.assignee, r.owner, r.createdBy]) if (p) out.add(p);
    if (r.record === 'transition') out.add(r.actor);
  }
  return [...out].filter((p) => p.trim().length > 0);
}

/** The commits a repository's git records name by full SHA, for the sha rule: pass a workspace's whole git.jsonl, not just the export's range. */
export function commitsIn(git: GitRecord[]): string[] {
  const out = new Set<string>();
  for (const r of git) {
    if (r.record === 'commit') {
      out.add(r.sha);
      for (const p of r.parents) out.add(p);
      if (r.reverts) out.add(r.reverts);
    } else if (r.record === 'branch') {
      out.add(r.head);
      if (r.from) out.add(r.from);
      if (r.merged) out.add(r.merged.commit);
    } else out.add(r.commit);
  }
  return [...out].filter((s) => /^[0-9a-f]{40}$/i.test(s));
}
