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
  Redaction,
  SessionRecord,
  TransitionRecord,
} from '@snagboat/schema';
import { keyedHash, RepositoryPrivacy } from './keys';
import {
  ALLOWABLE_RULES,
  CARD,
  CONNECTION_PASSWORD,
  EMAIL,
  ENV_LINE,
  escapeRegExp,
  FlagRule,
  IPV4,
  IPV6,
  isCardNumber,
  isHighEntropy,
  isPhoneNumber,
  isPublicHost,
  isReportableIp,
  isShaLike,
  isVersionContext,
  LONG_TOKEN,
  MAC,
  PHONE_PATTERNS,
  PUBLIC_KEY_PATTERNS,
  RuleName,
  RULES_VERSION,
  SECRET_PATTERNS,
  SHA_LIKE,
  wordPattern,
} from './rules';
import type { FinalCheckSpec } from './finalCheck';

/**
 * The export's sanitizer: rules 1–4 of docs/design/export.md's "The privacy rules", applied to
 * one project's store records. Pure: it reads nothing and writes nothing. The command
 * (snagboat export) selects the records, finds the key (keys.ts), runs them through here,
 * writes the results and the review file, and runs the final check (finalCheck.ts) over what
 * it wrote with the spec this returns.
 *
 * Every string an export writes goes through the text rules, apart from ids and enums, which
 * are kept or re-keyed. Output records are built field by field from the known fields, so
 * anything else a stored record carries (workspace, raw, a field added later) is dropped.
 */

export interface SanitizeContext {
  /** The project's root (absolute). Paths inside it become relative; the root itself '.'. */
  projectRoot: string;
  /** The repository's other worktrees (absolute), in a stable order: their paths become [worktree-1], [worktree-2]. */
  worktreeRoots?: string[];
  /** --match paths (absolute): records from them were selected too, and their paths become [match-1], [match-2]. */
  matchPaths?: string[];
  homeDir: string;
  userName: string;
  hostName: string;
  /**
   * The people the records name: git idents ("Name <email>", from commits and Co-Authored-By
   * trailers) and bd actors and assignees (bare names). sanitizeExport adds the ones its records
   * name. Agents among them keep their names.
   */
  people?: string[];
  /** More names to treat as agents, beside the built-in ones (claude-code, Claude, Copilot, bots). */
  agentNames?: string[];
  /** Full SHAs of the commits the store knows. sanitizeExport adds its commit records' SHAs and parents. */
  knownCommits?: string[];
  /** private (the default): SHAs re-keyed and unknown SHA-like hex flagged. public: export.public, SHAs kept. */
  privacy: RepositoryPrivacy;
  /** The key's bytes: the repository's key for a private repository, this machine's for a public one (keys.ts). */
  key: Uint8Array;
  /** --text: redacted (the default) keeps text through the rules; none keeps structure only. */
  text?: 'redacted' | 'none';
  /** export.deny: words and phrases replaced with [denied-N]. */
  deny?: string[];
  /** The repository's remote URLs, if the command knows them: replaced with [remote] wherever they appear. */
  remotes?: string[];
  /** --allow: flag ids (flagged-3) whose values are put back. */
  allow?: string[];
  /** --allow-rule: rules whose values are put back (ALLOWABLE_RULES). */
  allowRules?: string[];
}

/** One flagged value, for <out>.review/flags.jsonl. Never written inside the export. */
export interface ReviewEntry {
  /** flagged-N: the placeholder in the export, and what --allow takes. allowed-N: a rule 2 value --allow-rule kept. */
  id: string;
  rule: RuleName;
  /** The record it's in, by its key in the export ("event:<id>", "commit:<sha>", "item:<id>"). */
  record: string;
  /** The field, as a dotted path. */
  field: string;
  /** The value itself. */
  value: string;
  /** Up to 80 characters each side, as sanitized so far. */
  before: string;
  after: string;
  /** Put back by --allow or --allow-rule: the value is in the export. */
  allowed?: true;
}

/** A sanitized record, with what the rules replaced in it. */
export interface Sanitized<T> {
  record: T;
  redactions: Redaction[];
}

/** What sanitizeExport takes: one project's selected store records. */
export interface ExportInput {
  events?: NormalizedEvent[];
  sessions?: SessionRecord[];
  git?: GitRecord[];
  plan?: PlanRecord[];
  links?: LinkRecord[];
  findings?: FindingRecord[];
}

/** What sanitizeExport returns: the export's records, the review list, and the final check's spec. */
export interface SanitizedExport {
  events: ExportedEvent[];
  sessions: Sanitized<SessionRecord>[];
  commits: Sanitized<CommitRecord>[];
  branches: Sanitized<BranchRecord>[];
  checkouts: Sanitized<CheckoutRecord>[];
  planItems: Sanitized<PlanItemRecord>[];
  transitions: Sanitized<TransitionRecord>[];
  links: Sanitized<LinkRecord>[];
  findings: Sanitized<FindingRecord>[];
  summary: SanitizeSummary;
}

/** For the manifest and the review folder. */
export interface SanitizeSummary {
  rulesVersion: number;
  /** How many values each rule replaced, by rule name (manifest.redactions). */
  redactions: Record<string, number>;
  /** Flagged values still replaced (manifest.flags). Allowed ones are in review but not counted. */
  flags: number;
  review: ReviewEntry[];
  /** What the final check looks for: holds the real values, so keep it in memory only. */
  finalCheck: FinalCheckSpec;
}

const BUILT_IN_AGENTS = ['claude-code', 'copilot', 'generic-fs'];

/** Whether an ident or name is an agent's: its email is a bot's, or (with no email) its name is an agent's. */
export function isAgentIdentity(name: string, email: string | undefined, extra: string[] = []): boolean {
  const n = name.trim().toLowerCase();
  if (email !== undefined && email !== '') {
    const e = email.trim().toLowerCase();
    // A GitHub app's name ends in [bot], whatever email a trailer gives it (dependabot's
    // Co-authored-by uses support@github.com): no person's account can be named that.
    if (/\[bot\]$/.test(n)) return true;
    return (
      e === 'noreply@anthropic.com' ||
      e === 'noreply@github.com' ||
      /\[bot\]@users\.noreply\.github\.com$/.test(e) ||
      /^(?:\d+\+)?copilot@users\.noreply\.github\.com$/.test(e)
    );
  }
  if (BUILT_IN_AGENTS.includes(n) || n.startsWith('custom:') || /\[bot\]$/.test(n)) return true;
  if (/^(?:claude|copilot)\b/.test(n)) return true;
  return extra.some((a) => a.trim().toLowerCase() === n);
}

/** Splits "Name <email>" (or a bare name). */
export function parseIdent(raw: string): { name: string; email?: string } {
  const m = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(raw);
  if (m) return { name: m[1], email: m[2] };
  const bare = raw.trim();
  // A bare email (bd's owner often is one) is an email with no name.
  if (/^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/.test(bare)) return { name: '', email: bare };
  return { name: bare };
}

interface Person {
  pseudonym: string;
  names: Set<string>;
  emails: Set<string>;
}

// Placeholders are held out of the text as private-use sentinels while later rules run, so no
// rule matches inside another's replacement; they're put back at the end.
/** A URL in text: with a scheme (git+https too), or a forge link written without one (github.com/owner/repo). */
const URL_SPAN = /(?:\b(?:git\+)?(?:https?|wss?|ftp|ssh|git|svn):\/\/|(?<![\w./@-])(?=(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/))[^\s"'`<>)\]}]+/gi;
/** Hosts where /<owner>/<repo>/... names a repository. */
const FORGE_HOST = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i;
const S_OPEN = '\uE000';
const S_CLOSE = '\uE001';
const SENTINEL = /\uE000([\uE100-\uF8FF]{2})\uE001/g;

// Path tokens stop at whitespace, quotes, brackets and separators; ':' ends one too (a:12:5).
const PATH_CHARS = '[^\\s"\'`<>|;,:)\\]}\\uE000\\uE001]';
const SEG_CHARS = '[^\\s"\'`<>|;,:)\\]}/\\uE000\\uE001]';
const PATH_END = '(?=$|[\\s"\'`<>|;,:)\\]}\\uE000])';

type Text = string;

export class ExportSanitizer {
  private readonly ctx: SanitizeContext;
  private readonly textMode: 'redacted' | 'none';
  private readonly roots: Array<{ root: string; label: string; kind: 'project' | 'worktree' | 'match' | 'home' }>;
  private readonly rootPatterns: Array<{ re: RegExp; root: string }>;
  private readonly people = new Map<string, Person>();
  private readonly personByName = new Map<string, Person>();
  private readonly agentNames: string[];
  private readonly knownShas = new Set<string>();
  private readonly shaPrefixes = new Map<string, string[]>();
  private readonly allowIds: Set<string>;
  private readonly allowRules: Set<string>;
  private readonly numbered = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly flagIds = new Map<string, string>();
  private readonly review: ReviewEntry[] = [];
  private readonly totals = new Map<string, number>();
  private readonly allowedValues = new Set<string>();
  private namePatterns?: Array<{ re: RegExp; person: Person }>;
  private partialPatterns?: RegExp[];
  private readonly denyPatterns: Array<{ re: RegExp; word: string }>;
  private readonly remoteNeedles: string[];
  // The record being sanitized: its key and what's been replaced in it, by field and rule.
  private recordKey = '';
  private counts = new Map<string, Map<string, number>>();

  constructor(ctx: SanitizeContext) {
    this.ctx = ctx;
    this.textMode = ctx.text ?? 'redacted';
    this.agentNames = ctx.agentNames ?? [];
    const strip = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p);
    this.roots = [
      ...(ctx.worktreeRoots ?? []).map((root, i) => ({ root: strip(root), label: `[worktree-${i + 1}]`, kind: 'worktree' as const })),
      ...(ctx.matchPaths ?? []).map((root, i) => ({ root: strip(root), label: `[match-${i + 1}]`, kind: 'match' as const })),
      { root: strip(ctx.projectRoot), label: '.', kind: 'project' as const },
      { root: strip(ctx.homeDir), label: '~', kind: 'home' as const },
    ]
      .filter((r) => r.root.length > 1)
      .sort((a, b) => b.root.length - a.root.length);
    this.rootPatterns = this.roots.map(({ root }) => ({
      root,
      re: new RegExp(`(?<![\\w.~/\\\\-])${escapeRegExp(root)}((?:/${PATH_CHARS}*)?)${PATH_END}`, 'g'),
    }));
    for (const sha of ctx.knownCommits ?? []) this.addCommit(sha);
    for (const p of ctx.people ?? []) this.person(p);
    const badRules = (ctx.allowRules ?? []).filter((r) => !ALLOWABLE_RULES.includes(r as RuleName));
    if (badRules.length > 0) throw new Error(`--allow-rule takes ${ALLOWABLE_RULES.join(', ')}; not ${badRules.join(', ')}.`);
    const badIds = (ctx.allow ?? []).filter((id) => !/^flagged-\d+$/.test(id));
    if (badIds.length > 0) throw new Error(`--allow takes flag ids like flagged-3; not ${badIds.join(', ')}.`);
    this.allowIds = new Set(ctx.allow ?? []);
    this.allowRules = new Set(ctx.allowRules ?? []);
    this.denyPatterns = (ctx.deny ?? []).map((w) => w.trim()).filter((w) => w.length > 0).map((word) => ({ word, re: wordPattern(word) }));
    this.remoteNeedles = remoteNeedles(ctx.remotes ?? []);
  }

  // ---- records --------------------------------------------------------------------------------

  event(e: NormalizedEvent): ExportedEvent {
    const eventId = this.eventId(e.eventId);
    this.begin(`event:${eventId}`);
    const none = this.textMode === 'none';
    const out: ExportedEvent = { eventId, sessionId: e.sessionId, agent: e.agent, ts: utc(e.ts), kind: e.kind, status: e.status };
    const fileTarget = e.kind === 'edit' || e.toolCategory === 'file-read' || e.toolCategory === 'file-edit';
    if (e.target !== undefined && (!none || fileTarget)) out.target = this.text(e.target, 'target');
    if (e.model !== undefined) out.model = this.text(e.model, 'model');
    if (e.tokens) out.tokens = pickNumbers(e.tokens, ['input', 'output', 'cacheRead', 'cacheCreation']);
    if (!none && e.textExcerpt !== undefined) out.textExcerpt = this.text(e.textExcerpt, 'textExcerpt');
    if (!none && e.promptText !== undefined) out.promptText = this.text(e.promptText, 'promptText');
    if (!none && e.sessionName !== undefined) out.sessionName = this.text(e.sessionName, 'sessionName');
    if (e.turnId !== undefined) out.turnId = e.turnId;
    if (e.agentId !== undefined) out.agentId = e.agentId;
    if (e.toolName !== undefined) out.toolName = this.text(e.toolName, 'toolName');
    if (e.toolCategory !== undefined) out.toolCategory = e.toolCategory;
    if (e.todos) {
      out.todos = { pending: e.todos.pending, inProgress: e.todos.inProgress, completed: e.todos.completed };
      if (!none && e.todos.items) out.todos.items = e.todos.items.map((i) => ({ text: this.text(i.text, 'todos.items'), status: i.status }));
    }
    if (e.taskOp) {
      const t = e.taskOp;
      out.taskOp = { op: t.op };
      if (t.id !== undefined) out.taskOp.id = t.id;
      if (t.status !== undefined) out.taskOp.status = t.status;
      if (!none && t.subject !== undefined) out.taskOp.subject = this.text(t.subject, 'taskOp.subject');
      if (t.tasks) {
        out.taskOp.tasks = t.tasks.map((task) => {
          const o: { id: string; status: typeof task.status; subject?: string } = { id: task.id, status: task.status };
          if (!none && task.subject !== undefined) o.subject = this.text(task.subject, 'taskOp.tasks.subject');
          return o;
        });
      }
    }
    if (e.compaction) {
      out.compaction = { trigger: e.compaction.trigger, ...pickNumbers(e.compaction, ['preTokens', 'postTokens']) };
    }
    if (e.channel !== undefined) out.channel = e.channel;
    if (e.contextLimit !== undefined) out.contextLimit = e.contextLimit;
    if (e.endsTurn) out.endsTurn = true;
    if (e.toolInput) {
      const ti: NonNullable<ExportedEvent['toolInput']> = {};
      if (e.toolInput.path !== undefined) ti.path = this.text(e.toolInput.path, 'toolInput.path');
      if (!none) {
        for (const k of ['command', 'pattern', 'url', 'description'] as const) {
          const v = e.toolInput[k];
          if (v !== undefined) ti[k] = this.text(v, `toolInput.${k}`);
        }
      }
      if (Object.keys(ti).length > 0) out.toolInput = ti;
    }
    if (e.refs) {
      const r: NonNullable<ExportedEvent['refs']> = {};
      if (e.refs.commit !== undefined) r.commit = this.sha(e.refs.commit);
      if (e.refs.branch !== undefined) r.branch = this.text(e.refs.branch, 'refs.branch');
      if (e.refs.planItems) r.planItems = [...e.refs.planItems];
      out.refs = r;
    }
    if (e.textTruncated && !none) out.textTruncated = true;
    if (e.outcome) {
      const o = e.outcome;
      const oo: NonNullable<ExportedEvent['outcome']> = { type: o.type };
      if (o.refs) oo.refs = o.refs.map((r) => this.ref(r));
      Object.assign(oo, pickNumbers(o, ['failures', 'afterMs', 'files', 'linesWritten', 'linesSurviving', 'days']));
      if (o.heuristicId !== undefined) oo.heuristicId = o.heuristicId;
      if (o.response !== undefined) oo.response = o.response;
      if (o.commit !== undefined) oo.commit = this.sha(o.commit);
      if (o.advisor !== undefined) oo.advisor = this.text(o.advisor, 'outcome.advisor');
      if (o.decision !== undefined) oo.decision = o.decision;
      out.outcome = oo;
    }
    const redactions = this.end();
    if (redactions.length > 0) out.redactions = redactions;
    return out;
  }

  session(s: SessionRecord): Sanitized<SessionRecord> {
    this.begin(`session:${s.sessionId}`);
    const out: SessionRecord = {
      sessionId: s.sessionId,
      agent: s.agent,
      firstTs: utc(s.firstTs),
      lastTs: utc(s.lastTs),
      models: s.models.map((m) => this.text(m, 'models')),
      prompts: s.prompts,
      modelCalls: s.modelCalls,
      toolCalls: s.toolCalls,
      tokens: s.tokens,
      subagents: s.subagents,
      days: [...s.days],
      subagentIds: [...s.subagentIds],
      where: this.where(s.where, 'where'),
      branches: s.branches.map((b) => this.text(b, 'branches')),
      commits: s.commits.map((c) => ({ sha: this.sha(c.sha), confidence: c.confidence })),
      planItems: s.planItems.map((p) => ({ id: p.id, how: p.how, confidence: p.confidence })),
    };
    if (s.name !== undefined && this.textMode !== 'none') out.name = this.text(s.name, 'name');
    return { record: out, redactions: this.end() };
  }

  commit(c: CommitRecord): Sanitized<CommitRecord> {
    const sha = this.sha(c.sha);
    this.begin(`commit:${sha}`);
    const none = this.textMode === 'none';
    const out: CommitRecord = {
      record: 'commit',
      version: 1,
      sha,
      parents: c.parents.map((p) => this.sha(p)),
      kind: c.kind,
      authoredAt: utc(c.authoredAt),
      committedAt: utc(c.committedAt),
      author: this.who(c.author, 'author'),
      committer: this.who(c.committer, 'committer'),
      coAuthors: c.coAuthors.map((a) => this.who(a, 'coAuthors')),
      subject: none ? '' : this.text(c.subject, 'subject'),
      files: c.files.map((f) => {
        const o: CommitRecord['files'][number] = { path: this.text(f.path, 'files.path'), status: f.status, added: f.added, deleted: f.deleted };
        if (f.from !== undefined) o.from = this.text(f.from, 'files.from');
        return o;
      }),
      onBranches: c.onBranches.map((b) => this.text(b, 'onBranches')),
    };
    if (c.body !== undefined && !none) out.body = this.text(c.body, 'body');
    if (c.pr !== undefined) out.pr = c.pr;
    if (c.reverts !== undefined) out.reverts = this.sha(c.reverts);
    return { record: out, redactions: this.end() };
  }

  branch(b: BranchRecord): Sanitized<BranchRecord> {
    this.begin('branch:');
    const id = this.branchId(b.id, 'id');
    this.recordKey = `branch:${id}`;
    const out: BranchRecord = {
      record: 'branch',
      version: 1,
      id,
      name: this.text(b.name, 'name'),
      firstSeenAt: utc(b.firstSeenAt),
      head: this.sha(b.head),
    };
    if (b.createdAt !== undefined) out.createdAt = utc(b.createdAt);
    if (b.from !== undefined) out.from = this.sha(b.from);
    if (b.merged) {
      out.merged = { into: this.text(b.merged.into, 'merged.into'), at: utc(b.merged.at), via: b.merged.via, commit: this.sha(b.merged.commit) };
      if (b.merged.pr !== undefined) out.merged.pr = b.merged.pr;
    }
    if (b.deletedAt !== undefined) out.deletedAt = utc(b.deletedAt);
    return { record: out, redactions: this.end() };
  }

  checkout(c: CheckoutRecord): Sanitized<CheckoutRecord> {
    const id = this.ref(c.id);
    this.begin(`checkout:${id}`);
    const out: CheckoutRecord = {
      record: 'checkout',
      version: 1,
      id,
      at: utc(c.at),
      from: this.text(c.from, 'from'),
      to: this.text(c.to, 'to'),
      commit: this.sha(c.commit),
      where: this.where(c.where, 'where'),
    };
    return { record: out, redactions: this.end() };
  }

  planItem(p: PlanItemRecord): Sanitized<PlanItemRecord> {
    this.begin(`item:${p.id}`);
    const none = this.textMode === 'none';
    const out: PlanItemRecord = {
      record: 'item',
      version: 1,
      id: p.id,
      kind: p.kind,
      title: none ? '' : this.text(p.title, 'title'),
      status: p.status,
      labels: p.labels.map((l) => this.text(l, 'labels')),
      created: utc(p.created),
      updated: utc(p.updated),
      source: p.source,
      confidence: p.confidence,
    };
    if (p.priority !== undefined) out.priority = p.priority;
    if (p.parent !== undefined) out.parent = p.parent;
    if (p.blockedBy) out.blockedBy = [...p.blockedBy];
    if (p.started !== undefined) out.started = utc(p.started);
    if (p.closed !== undefined) out.closed = utc(p.closed);
    if (p.closeReason !== undefined && !none) out.closeReason = this.text(p.closeReason, 'closeReason');
    if (p.assignee !== undefined) out.assignee = this.who(p.assignee, 'assignee');
    if (p.owner !== undefined) out.owner = this.who(p.owner, 'owner');
    if (p.createdBy !== undefined) out.createdBy = this.who(p.createdBy, 'createdBy');
    if (p.text && !none) {
      const t: NonNullable<PlanItemRecord['text']> = {};
      for (const k of ['description', 'design', 'notes', 'acceptance'] as const) {
        const v = p.text[k];
        if (v !== undefined) t[k] = this.text(v, `text.${k}`);
      }
      out.text = t;
    }
    if (p.from) {
      out.from = { file: this.text(p.from.file, 'from.file') };
      if (p.from.heading !== undefined && !none) out.from.heading = this.text(p.from.heading, 'from.heading');
    }
    return { record: out, redactions: this.end() };
  }

  transition(t: TransitionRecord): Sanitized<TransitionRecord> {
    this.begin(`transition:${t.id}`);
    const out: TransitionRecord = {
      record: 'transition',
      version: 1,
      id: t.id,
      item: t.item,
      at: utc(t.at),
      type: t.type,
      actor: this.who(t.actor, 'actor'),
      confidence: t.confidence,
    };
    if (t.from !== undefined) out.from = this.text(t.from, 'from');
    if (t.to !== undefined) out.to = this.text(t.to, 'to');
    if (t.fields) out.fields = [...t.fields];
    return { record: out, redactions: this.end() };
  }

  /** A link, or undefined for one a later link superseded (the export writes only current links). */
  link(l: LinkRecord): Sanitized<LinkRecord> | undefined {
    if (l.supersededBy !== undefined) return undefined;
    const id = this.ref(l.id);
    this.begin(`link:${id}`);
    const end = (e: LinkEnd, field: string): LinkEnd => ({ type: e.type, id: this.linkEnd(e, field) });
    const out: LinkRecord = {
      record: 'link',
      version: 1,
      id,
      from: end(l.from, 'from.id'),
      to: end(l.to, 'to.id'),
      kind: l.kind,
      confidence: l.confidence,
      evidence: l.evidence.map((ev) => ({ rule: ev.rule, refs: ev.refs.map((r) => this.ref(r, 'evidence.refs')) })),
    };
    if (l.how !== undefined) out.how = l.how;
    return { record: out, redactions: this.end() };
  }

  finding(f: FindingRecord): Sanitized<FindingRecord> {
    this.begin(`finding:${f.id}`);
    const out: FindingRecord = {
      record: 'finding',
      version: 1,
      id: f.id,
      heuristicId: f.heuristicId,
      heuristicVersion: f.heuristicVersion,
      severity: f.severity,
      firstTs: utc(f.firstTs),
      lastTs: utc(f.lastTs),
      eventRefs: f.eventRefs.map((r) => this.ref(r)),
      earlyWarning: f.earlyWarning,
      response: f.response,
    };
    if (f.sessionId !== undefined) out.sessionId = f.sessionId;
    if (f.turnId !== undefined) out.turnId = f.turnId;
    if (f.summary !== undefined && this.textMode !== 'none') out.summary = this.text(f.summary, 'summary');
    return { record: out, redactions: this.end() };
  }

  /** The totals, the review list, and the final check's spec, after every record has been through. */
  summary(): SanitizeSummary {
    const literals: FinalCheckSpec['literals'] = [];
    const add = (rule: RuleName, value: string | undefined, word = false) => {
      if (value && value.trim().length >= 3) literals.push({ rule, value: value.trim(), word });
    };
    for (const r of this.roots) add('path', r.root);
    add('user', this.ctx.userName, true);
    add('host', this.ctx.hostName, true);
    add('host', this.ctx.hostName.split('.')[0], true);
    for (const p of this.people.values()) {
      for (const n of p.names) add('person', n, true);
      for (const e of p.emails) add('email', e);
    }
    for (const d of this.denyPatterns) add('deny', d.word, true);
    for (const r of this.remoteNeedles) add('remote', r);
    if (this.ctx.privacy === 'private') for (const sha of this.knownShas) add('sha', sha);
    const flags = this.review.filter((r) => !r.allowed).length;
    return {
      rulesVersion: RULES_VERSION,
      redactions: Object.fromEntries([...this.totals.entries()].sort(([a], [b]) => a.localeCompare(b))),
      flags,
      review: [...this.review],
      finalCheck: { literals: dedupeLiterals(literals), allowed: [...this.allowedValues] },
    };
  }

  // ---- registration -------------------------------------------------------------------------

  /** Adds a commit the store knows, so its SHA is re-keyed wherever it appears. */
  addCommit(sha: string): void {
    const s = sha.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(s) || this.knownShas.has(s)) return;
    this.knownShas.add(s);
    const p = s.slice(0, 7);
    this.shaPrefixes.set(p, [...(this.shaPrefixes.get(p) ?? []), s]);
  }

  /** Registers a person (ident or bare name) and returns their pseudonym, or an agent's name. */
  who(raw: string, field: string): string {
    const { name, email } = parseIdent(raw);
    if (isAgentIdentity(name, email, this.agentNames)) return name || raw.trim();
    const person = this.person(raw);
    if (!person) return raw;
    this.count(field, 'person');
    return person.pseudonym;
  }

  private person(raw: string): Person | undefined {
    const { name, email } = parseIdent(raw);
    if (isAgentIdentity(name, email, this.agentNames)) return undefined;
    if (!email && !name) return undefined;
    const login = email ? /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1] : undefined;
    // Keyed by name when there is one, so the same person gets the same pseudonym whichever of
    // their idents (or a bd actor of the same name) an export happens to see first.
    const key = name ? `name:${name.trim().replace(/\s+/g, ' ').toLowerCase()}` : `email:${email!.toLowerCase()}`;
    // An email with no name (bd's owner) is the person a git ident with that email names.
    let person = this.people.get(key) ?? (name ? undefined : [...this.people.values()].find((p) => [...p.emails].some((e) => e.toLowerCase() === email!.toLowerCase())));
    if (!person) {
      person = { pseudonym: `person-${keyedHash(this.ctx.key, 'person', key).slice(0, 8)}`, names: new Set<string>(), emails: new Set<string>() };
    }
    this.people.set(key, person);
    if (name) {
      person.names.add(name);
      if (!this.personByName.has(name.toLowerCase())) this.personByName.set(name.toLowerCase(), person);
    }
    if (login) {
      person.names.add(login);
      if (!this.personByName.has(login.toLowerCase())) this.personByName.set(login.toLowerCase(), person);
    }
    if (email) person.emails.add(email);
    this.namePatterns = undefined;
    this.partialPatterns = undefined;
    return person;
  }

  // ---- ids ----------------------------------------------------------------------------------

  /** A commit SHA (full or short): re-keyed for a private repository, kept for a public one. */
  sha(raw: string): string {
    if (this.ctx.privacy === 'public') return raw;
    const s = raw.toLowerCase();
    if (!/^[0-9a-f]{4,40}$/.test(s)) return this.text(raw, 'sha');
    const full = s.length === 40 ? s : this.knownPrefix(s);
    if (full) return this.rekeyedSha(full).slice(0, s.length);
    return keyedHash(this.ctx.key, 'sha', s).slice(0, s.length);
  }

  private rekeyedSha(full: string): string {
    return keyedHash(this.ctx.key, 'sha', full).slice(0, 40);
  }

  private knownPrefix(s: string): string | undefined {
    if (s.length < 7) return undefined;
    if (s.length === 40) return this.knownShas.has(s) ? s : undefined;
    return (this.shaPrefixes.get(s.slice(0, 7)) ?? []).find((full) => full.startsWith(s));
  }

  /** An event id: re-keyed when it embeds a path (fallback ids name transcript files), with SHAs in it re-keyed. */
  eventId(id: string): string {
    if (/[/\\]/.test(id)) {
      const prefix = /^([a-z][a-z0-9-]*):/i.exec(id)?.[1];
      return `${prefix ?? 'event'}:k-${keyedHash(this.ctx.key, 'event', id).slice(0, 16)}`;
    }
    if (this.ctx.privacy === 'private') return id.replace(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g, (sha) => this.rekeyedSha(sha));
    return id;
  }

  /**
   * Any record id a link, finding or outcome refers to: SHAs re-keyed, checkout and link ids
   * (hashes of SHAs and paths) re-keyed, branch ids' names scrubbed, path-embedding event ids
   * re-keyed. Session, turn, bead and transition ids are kept.
   */
  ref(id: string, field = 'refs'): string {
    if (/^[0-9a-f]{40}$/.test(id)) return this.sha(id);
    if (/^[0-9a-f]{7,39}$/.test(id) && this.knownPrefix(id)) return this.sha(id);
    const m = /^(checkout|link)-([0-9a-f]+)$/.exec(id);
    if (m) return `${m[1]}-${keyedHash(this.ctx.key, m[1], id).slice(0, 16)}`;
    if (/@\d{4}-\d\d-\d\dT/.test(id) && !/[/\\]/.test(id.slice(id.lastIndexOf('@')))) return this.branchId(id, field);
    return this.eventId(id);
  }

  private linkEnd(e: LinkEnd, field: string): string {
    switch (e.type) {
      case 'commit':
        return this.sha(e.id);
      case 'branch':
        return this.branchId(e.id, field);
      default:
        return e.id;
    }
  }

  /** A branch's id, `<name>@<firstSeenAt>`, with its name through the text rules. */
  private branchId(id: string, field: string): string {
    const at = id.lastIndexOf('@');
    if (at <= 0) return this.text(id, field);
    return `${this.text(id.slice(0, at), field)}@${utc(id.slice(at + 1))}`;
  }

  /** Where something ran: '.', '[worktree-N]', '[match-N]', or a path through the rules. */
  private where(raw: string, field: string): string {
    if (raw === '.' || /^\[(?:worktree|match)-\d+\]$/.test(raw)) return raw;
    return this.text(raw, field);
  }

  // ---- the text rules -----------------------------------------------------------------------

  /** Every rule on one string: rule 2's secrets and PII, rule 1's paths, names and SHAs, rule 4's flags. */
  text(input: Text, field: string): string {
    if (input.length === 0) return input;
    const slots: string[] = [];
    // Slots that hold a value kept as written (put back by --allow or --allow-rule): not a change.
    const kept = new Set<number>();
    const protect = (s: string, keep = false) => {
      const i = slots.push(s) - 1;
      if (keep) kept.add(i);
      return `${S_OPEN}${String.fromCharCode(0xe100 + (i >> 10), 0xe100 + (i & 1023))}${S_CLOSE}`;
    };
    const expand = (s: string): string => {
      let out = s;
      while (out.includes(S_OPEN)) {
        out = out.replace(SENTINEL, (_, code: string) => slots[((code.charCodeAt(0) - 0xe100) << 10) + (code.charCodeAt(1) - 0xe100)] ?? '');
      }
      return out;
    };
    let t = input;
    // The rule a replacement counts under, when not sub's own: null counts nothing (counted already).
    let countAs: string | null | undefined;
    // Replaces each match the decide function accepts; it returns the replacement (protected), or
    // undefined to leave it. A replacement that changes the text counts once, under its rule.
    const sub = (pattern: RegExp, rule: RuleName, decide: (m: string, groups: string[], offset: number, whole: string) => string | undefined) => {
      t = t.replace(pattern, (...args: unknown[]) => {
        const m = args[0] as string;
        const offsetIndex = args.findIndex((a, i) => i > 0 && typeof a === 'number');
        const groups = args.slice(1, offsetIndex) as string[];
        const offset = args[offsetIndex] as number;
        const whole = args[offsetIndex + 1] as string;
        countAs = undefined;
        const r = decide(m, groups, offset, whole);
        if (r === undefined) return m;
        const as = countAs === undefined ? rule : countAs;
        if (as !== null && expand(r) !== expand(m)) this.count(field, as);
        return r;
      });
    };
    const context = (whole: string, offset: number, length: number) => ({
      before: expand(whole.slice(Math.max(0, offset - 400), offset)),
      after: expand(whole.slice(offset + length, offset + length + 400)),
    });
    // A value that rule 2 replaces unless its rule is allowed (then it's kept, and listed for review).
    const soft = (rule: RuleName, value: string, offset: number, whole: string, placeholder: string) => {
      if (this.allowRules.has(rule)) {
        const { before, after } = context(whole, offset, value.length);
        this.flagEntry(rule, expand(value), field, before, after, true, this.allowedId(rule, expand(value)));
        return protect(expand(value), true);
      }
      return protect(placeholder);
    };
    // Rule 4: a questionable value becomes [flagged-N], unless --allow or --allow-rule puts it back.
    const flag = (rule: FlagRule, value: string, offset: number, whole: string) => {
      const { before, after } = context(whole, offset, value.length);
      const plain = expand(value);
      const id = this.flagId(plain);
      const allowed = this.allowIds.has(id) || this.allowRules.has(rule);
      this.flagEntry(rule, plain, field, before, after, allowed, id);
      countAs = rule;
      return protect(allowed ? plain : `[${id}]`, allowed);
    };

    // Rule 2 first: secrets as captured text has them, so nothing later splits one.
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      t = t.replace(pattern, (...args: unknown[]) => {
        const m = args[0] as string;
        if (/\[redacted/.test(m)) return m;
        this.count(field, 'secret');
        const groups = args.slice(1).filter((a) => typeof a === 'string' || a === undefined) as Array<string | undefined>;
        return replacement.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '').replace(/\[redacted[^\]]*\]/g, (p) => protect(p));
      });
    }
    for (const pattern of PUBLIC_KEY_PATTERNS) sub(pattern, 'public-key', () => protect('[public key]'));
    sub(CONNECTION_PASSWORD, 'connection-string', (_m, [keep]) => `${keep}${protect('[redacted]')}`);
    sub(ENV_LINE, 'env', (_m, [keep]) => `${keep}${protect('[redacted]')}`);
    if (this.remoteNeedles.length > 0) {
      for (const needle of this.remoteNeedles) sub(new RegExp(escapeRegExp(needle), 'gi'), 'remote', () => protect('[remote]'));
    }
    // Trailers name people by ident: the person's pseudonym or the agent's name, without the email.
    sub(/^([ \t]*(?:Co-Authored-By|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Helped-by):[ \t]*)([^\n<]*?)[ \t]*<([^>\n]*)>[ \t]*$/gim, 'person', (_m, [keep, name, email]) => {
      countAs = null; // who() counts a person; an agent's line only loses its email
      return `${keep}${protect(this.who(`${name} <${email}>`, field))}`;
    });
    // Stack traces from other projects, before their paths are rewritten.
    sub(/(?:^[ \t]*(?:at .*?\(?(?:\/|[A-Za-z]:\\)[^\n]*|File "[^"\n]+", line \d+[^\n]*)(?:\n|$)){3,}/gm, 'foreign-trace', (m, _g, offset, whole) => {
      const paths = [...m.matchAll(/(?<=[(\s"])(?:\/|[A-Za-z]:\\)[^\s:)"']+/g)].map((p) => p[0]);
      return paths.some((p) => !this.insideProject(p)) ? flag('foreign-trace', m.replace(/\n$/, ''), offset, whole) + (m.endsWith('\n') ? '\n' : '') : undefined;
    });
    sub(EMAIL, 'email', (m, _g, offset, whole) => soft('email', m, offset, whole, this.number('email', m.toLowerCase())));

    // Rule 1: paths. The known roots first, as literal text (they may hold spaces), then any other.
    sub(/\bfile:\/\/([^\s"'`<>)\]}]*)/gi, 'path', (m, [rest], offset, whole) => {
      const { path, tail } = trimTrailing(rest);
      if (path.startsWith('/')) return protect(this.mapPath(decodeURIComponentSafe(path))) + tail;
      return flag('unresolved-path', trimTrailing(m).path, offset, whole) + tail;
    });
    for (const { re, root } of this.rootPatterns) sub(re, 'path', (_m, [rest]) => this.rootReplacement(root, rest, protect));
    sub(new RegExp(`(?<![\\w.~/\\\\-])~(/${PATH_CHARS}*)?${PATH_END}`, 'g'), 'path', (m, [rest]) => {
      const { path, tail } = trimTrailing(rest ?? '');
      return protect(this.mapPath(this.ctx.homeDir.replace(/\/+$/, '') + path, path === '' ? '~' : m)) + tail;
    });
    sub(/(?<![\w\\])\\\\[A-Za-z0-9._$-]+\\[^\s"'`<>|;,)\]}]*/g, 'unresolved-path', (m, _g, offset, whole) => {
      const { path, tail } = trimTrailing(m);
      return flag('unresolved-path', path, offset, whole) + tail;
    });
    sub(/(?<![\w])[A-Za-z]:[\\/][^\s"'`<>|;,)\]}]*/g, 'path', (m) => {
      const { path, tail } = trimTrailing(m);
      return protect(placeholderPath(path)) + tail;
    });
    sub(new RegExp(`(?<=^|[\\s"'\`(\\[{<=,;|>:])/(?!/)${SEG_CHARS}+(?:/${SEG_CHARS}*)+${PATH_END}`, 'g'), 'path', (m) => {
      const { path, tail } = trimTrailing(m);
      return protect(this.mapPath(path)) + tail;
    });

    for (const { re, word } of this.denyPatterns) sub(re, 'deny', () => protect(this.number('denied', word.toLowerCase())));

    // People by name (pseudonyms), then this machine's user and host.
    for (const { re, person } of this.peopleNamePatterns()) sub(re, 'person', () => protect(person.pseudonym));
    for (const value of [this.ctx.userName]) {
      if (value && value.length >= 2) sub(wordPattern(value), 'user', () => protect('[user]'));
    }
    const hosts = [this.ctx.hostName, this.ctx.hostName.split('.')[0]].filter((h, i, all) => h && h.length >= 2 && h.toLowerCase() !== 'localhost' && all.indexOf(h) === i);
    for (const h of hosts) sub(wordPattern(h), 'host', () => protect('[host]'));

    // URLs to hosts that aren't public.
    sub(/\b(?:https?|wss?|ftp|ssh|git|svn):\/\/([^\s/?#"'`<>)\]}@]*@)?([^\s/?#"'`<>)\]}:]+)(?::\d+)?[^\s"'`<>)\]}]*/gi, 'internal-url', (m, [, host], offset, whole) => {
      if (host.includes(S_OPEN) || isPublicHost(host)) return undefined;
      const { path, tail } = trimTrailing(m);
      return flag('internal-url', path, offset, whole) + tail;
    });

    sub(MAC, 'mac', (m, _g, offset, whole) => soft('mac', m, offset, whole, '[mac]'));
    // A dotted quad that reads as a version (pkg@1.2.3.4, Chrome/120.0.61.109) is kept. The context is
    // read as the export will hold it, so the final check reads it the same way.
    sub(IPV4, 'ip', (m, _g, offset, whole) => {
      if (!isReportableIp(m)) return undefined;
      const before = expand(whole.slice(0, offset));
      if (isVersionContext(before + m + expand(whole.slice(offset + m.length)), before.length, m.length)) return undefined;
      return soft('ip', m, offset, whole, this.number('ip', m));
    });
    sub(IPV6, 'ip', (m, _g, offset, whole) => (isReportableIp(m) ? soft('ip', m, offset, whole, this.number('ip', m.toLowerCase())) : undefined));
    sub(CARD, 'card', (m, _g, offset, whole) => (isCardNumber(m) ? soft('card', m, offset, whole, '[card]') : undefined));
    for (const pattern of PHONE_PATTERNS) sub(pattern, 'phone', (m, _g, offset, whole) => (isPhoneNumber(m) ? soft('phone', m, offset, whole, '[phone]') : undefined));

    // SHAs: one matching a known commit is re-keyed (private) or kept as written (public); a hex run
    // that might be one but matches none (a container id, an editor's storage hash) is flagged either way.
    sub(SHA_LIKE, 'sha', (m, _g, offset, whole) => {
      const full = this.knownPrefix(m);
      if (full) return this.ctx.privacy === 'private' ? protect(this.rekeyedSha(full).slice(0, m.length)) : undefined;
      if (!isShaLike(m)) return undefined;
      return flag('unknown-sha', m, offset, whole);
    });

    sub(LONG_TOKEN, 'high-entropy', (m, _g, offset, whole) => {
      // A URL path ending in a token (/code/session_01Mi...): flag only the token, when every segment
      // before it reads as a plain word, so the rest of the URL (its host, for one) stays readable.
      const cut = m.lastIndexOf('/');
      if (cut > 0) {
        const head = m.slice(0, cut + 1);
        const last = m.slice(cut + 1);
        const plainHead = head.split('/').every((seg) => seg.length <= 30 && !/[A-Z]/.test(seg.replace(/^[A-Z]/, '')) && !isHighEntropy(seg));
        if (plainHead && isHighEntropy(last)) return head + flag('high-entropy', last, offset + cut + 1, whole);
      }
      return isHighEntropy(m) ? flag('high-entropy', m, offset, whole) : undefined;
    });

    // @mentions: a known person's becomes their pseudonym, an agent's stays, anyone else's is flagged.
    sub(/(?<![\w.@/\\\]\uE001-])@([A-Za-z][A-Za-z0-9-]{1,38})(?![\w/@-])/g, 'mention', (m, [handle], offset, whole) => {
      const h = handle.toLowerCase();
      if (NOT_MENTIONS.has(h) || isAgentIdentity(handle, undefined, this.agentNames)) return undefined;
      const person = this.personByName.get(h);
      if (person) {
        countAs = 'person';
        return `@${protect(person.pseudonym)}`;
      }
      return flag('mention', m, offset, whole);
    });
    // A part of a known person's name standing alone ("Dave", of "Dave Example").
    for (const re of this.partialNamePatterns()) sub(re, 'name', (m, _g, offset, whole) => flag('name', m, offset, whole));

    // URLs as a whole, after every other rule, so a rewritten URL never still reads as a working link
    // (a person's pseudonym in place of a GitHub login would make a valid link to someone else).
    // A link into the project's own repository becomes [repo <what>]; any other URL a rule changed
    // inside becomes [url-N host]. A URL no rule touched stays as written.
    sub(URL_SPAN, 'url', (m) => {
      const { path: url, tail } = trimTrailing(m);
      const changed = [...url.matchAll(SENTINEL)].some(([, code]) => !kept.has(((code.charCodeAt(0) - 0xe100) << 10) + (code.charCodeAt(1) - 0xe100)));
      const plain = expand(url);
      const parsed = /^(?:git\+)?(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([^/:?#\s]+)(?::\d+)?(\/[^?#]*)?(?:\?[^#]*)?(#.*)?$/i.exec(plain);
      if (!parsed) {
        // A rule replaced a span that took in the host (a long token): name the host from the text as written.
        if (!changed) return undefined;
        const host = /^(?:git\+)?(?:[a-z][a-z0-9+.-]*:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(url)?.[1];
        return protect(host ? this.number('url', plain).replace(/\]$/, ` ${host}]`) : this.number('url', plain)) + tail;
      }
      const [, host, pathPart = '', fragment = ''] = parsed;
      if (FORGE_HOST.test(host)) {
        const segs = pathPart.split('/').filter(Boolean);
        if (segs.length >= 2 && this.isProjectRepository(segs[1])) {
          countAs = 'remote';
          const what = segs.slice(2).join('/') + fragment;
          return protect(what ? `[repo ${what}]` : '[repo]') + tail;
        }
      }
      if (!changed) return undefined;
      return protect(this.number('url', plain).replace(/\]$/, ` ${host.includes('[') ? '' : host}]`).replace(/ \]$/, ']')) + tail;
    });

    return expand(t);
  }

  /** Whether a forge URL's repository name is this project's (its folder's name, or a worktree's). */
  private isProjectRepository(name: string): boolean {
    const repo = name.replace(/\.git$/i, '').toLowerCase();
    const names = [this.ctx.projectRoot, ...(this.ctx.worktreeRoots ?? [])].map((r) => r.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase());
    return names.includes(repo);
  }

  private rootReplacement(root: string, rest: string, protect: (s: string) => string): string {
    const { path, tail } = trimTrailing(rest);
    return protect(this.mapPath(root + path)) + tail;
  }

  /** An absolute path, as the export writes it. */
  private mapPath(abs: string, asWritten = abs): string {
    const p = abs.replace(/\\/g, '/');
    for (const r of this.roots) {
      if (p === r.root || p.startsWith(r.root + '/')) {
        const rest = p.slice(r.root.length).replace(/^\/+/, '');
        if (r.kind === 'project') return rest === '' ? '.' : rest;
        if (r.kind === 'home') return rest === '' ? '~' : `~/${placeholderPath(rest)}`;
        return rest === '' ? r.label : `${r.label}/${rest}`;
      }
    }
    return asWritten === '~' ? '~' : placeholderPath(p);
  }

  private insideProject(abs: string): boolean {
    const p = abs.replace(/\\/g, '/');
    return this.roots.some((r) => r.kind !== 'home' && (p === r.root || p.startsWith(r.root + '/')));
  }

  private peopleNamePatterns(): Array<{ re: RegExp; person: Person }> {
    if (!this.namePatterns) {
      const entries: Array<{ name: string; person: Person }> = [];
      for (const person of new Set(this.people.values())) for (const name of person.names) if (name.length >= 3) entries.push({ name, person });
      entries.sort((a, b) => b.name.length - a.name.length);
      this.namePatterns = entries.map(({ name, person }) => ({ re: wordPattern(name), person }));
    }
    return this.namePatterns;
  }

  private partialNamePatterns(): RegExp[] {
    if (!this.partialPatterns) {
      const words = new Set<string>();
      for (const person of new Set(this.people.values())) {
        for (const name of person.names) {
          const parts = name.split(/\s+/);
          if (parts.length < 2) continue;
          for (const w of parts) if (w.length >= 3 && /^\p{Lu}/u.test(w)) words.add(w);
        }
      }
      // Case-sensitive: a name is capitalized, and "will" or "rose" in a sentence isn't one.
      this.partialPatterns = [...words].map((w) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(w)}(?![\\p{L}\\p{N}_])`, 'gu'));
    }
    return this.partialPatterns;
  }

  // ---- bookkeeping --------------------------------------------------------------------------

  private begin(key: string): void {
    this.recordKey = key;
    this.counts = new Map();
  }

  private end(): Redaction[] {
    const out: Redaction[] = [];
    for (const [field, rules] of this.counts) for (const [rule, count] of rules) out.push({ field, rule, count });
    this.counts = new Map();
    return out;
  }

  private count(field: string, rule: string): void {
    const rules = this.counts.get(field) ?? new Map<string, number>();
    rules.set(rule, (rules.get(rule) ?? 0) + 1);
    this.counts.set(field, rules);
    this.totals.set(rule, (this.totals.get(rule) ?? 0) + 1);
  }

  /** A numbered placeholder, the same for the same value throughout the export: [email-1]. */
  private number(kind: string, value: string): string {
    const k = `${kind}\0${value}`;
    let p = this.numbered.get(k);
    if (!p) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      p = `[${kind}-${n}]`;
      this.numbered.set(k, p);
    }
    return p;
  }

  private flagId(value: string): string {
    let id = this.flagIds.get(value);
    if (!id) {
      id = `flagged-${this.flagIds.size + 1}`;
      this.flagIds.set(value, id);
    }
    return id;
  }

  /**
   * A rule 2 value --allow-rule kept: listed for review as allowed-N, numbered apart from the
   * flags so allowing a rule never renumbers them (--allow ids stay valid between runs).
   */
  private allowedId(rule: RuleName, value: string): string {
    return this.number('allowed', `${rule}\0${value}`).slice(1, -1);
  }

  private flagEntry(rule: RuleName, value: string, field: string, before: string, after: string, allowed: boolean, id = this.flagId(value)): void {
    const entry: ReviewEntry = { id, rule, record: this.recordKey, field, value, before: before.slice(-80), after: after.slice(0, 80) };
    if (allowed) {
      entry.allowed = true;
      this.allowedValues.add(value);
    }
    this.review.push(entry);
  }
}

/** @-words that aren't people: JSDoc and TypeScript tags, decorators, npm dist-tags. */
const NOT_MENTIONS = new Set([
  'param', 'returns', 'return', 'type', 'typedef', 'template', 'example', 'see', 'link', 'deprecated', 'override', 'internal', 'throws',
  'ts-ignore', 'ts-expect-error', 'ts-nocheck', 'ts-check', 'eslint-disable', 'license', 'author', 'since', 'default', 'property', 'private',
  'public', 'protected', 'readonly', 'abstract', 'async', 'callback', 'module', 'namespace', 'class', 'interface', 'enum', 'todo', 'fixme',
  'latest', 'next', 'beta', 'canary', 'injectable', 'component', 'input', 'output', 'test', 'before', 'after', 'media', 'import', 'keyframes',
  'font-face', 'supports', 'layer', 'apply', 'tailwind', 'here', 'channel', 'everyone',
]);

/** Splits trailing punctuation that ends a sentence off a path or URL. */
function trimTrailing(token: string): { path: string; tail: string } {
  const m = /[.,:;!?]+$/.exec(token);
  if (!m || m.index === 0) return { path: token, tail: '' };
  return { path: token.slice(0, m.index), tail: m[0] };
}

/** [path], keeping only the extension: [path].ts. */
function placeholderPath(p: string): string {
  const last = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(last);
  return ext && ext.index > 0 ? `[path].${ext[1]}` : '[path]';
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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

/** The forms a remote URL takes in text: as given, without .git, and as host/path. */
function remoteNeedles(remotes: string[]): string[] {
  const out = new Set<string>();
  for (const raw of remotes) {
    const r = raw.trim();
    if (!r) continue;
    out.add(r);
    const bare = r.replace(/\.git$/, '');
    out.add(bare);
    const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(bare);
    const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(bare);
    const hostPath = scp ? `${scp[1]}/${scp[2]}` : url ? `${url[1]}/${url[2]}` : undefined;
    if (hostPath) out.add(hostPath);
  }
  return [...out].filter((n) => n.length >= 8).sort((a, b) => b.length - a.length);
}

function dedupeLiterals(literals: FinalCheckSpec['literals']): FinalCheckSpec['literals'] {
  const seen = new Set<string>();
  return literals.filter((l) => {
    const k = `${l.rule}\0${l.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The people a set of records names (git idents and bd actors), for SanitizeContext.people. */
export function peopleIn(input: ExportInput): string[] {
  const out = new Set<string>();
  for (const r of input.git ?? []) {
    if (r.record === 'commit') {
      out.add(r.author);
      out.add(r.committer);
      for (const a of r.coAuthors) out.add(a);
      for (const m of (r.body ?? '').matchAll(/^[ \t]*Co-Authored-By:[ \t]*([^\n<]*?<[^>\n]*>)/gim)) out.add(m[1]);
    }
  }
  for (const r of input.plan ?? []) {
    if (r.record === 'item') for (const p of [r.assignee, r.owner, r.createdBy]) if (p) out.add(p);
    if (r.record === 'transition') out.add(r.actor);
  }
  return [...out].filter((p) => p.trim().length > 0);
}

/** The commits a set of records names by full SHA, for SanitizeContext.knownCommits. */
export function commitsIn(input: ExportInput): string[] {
  const out = new Set<string>();
  for (const r of input.git ?? []) {
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

/**
 * Sanitizes one project's selected records in one go. People and commits the records name are
 * added to the context first, so text anywhere is scrubbed of all of them. Records come out in
 * the order they went in; flag numbers follow that order, so the same input numbers its flags
 * the same way and --allow on a second run puts back what the first run's review listed.
 */
export function sanitizeExport(input: ExportInput, ctx: SanitizeContext): SanitizedExport {
  const s = new ExportSanitizer({
    ...ctx,
    people: [...(ctx.people ?? []), ...peopleIn(input)],
    knownCommits: [...(ctx.knownCommits ?? []), ...commitsIn(input)],
  });
  const out: SanitizedExport = {
    events: [],
    sessions: [],
    commits: [],
    branches: [],
    checkouts: [],
    planItems: [],
    transitions: [],
    links: [],
    findings: [],
    summary: undefined as unknown as SanitizeSummary,
  };
  for (const r of input.git ?? []) {
    if (r.record === 'commit') out.commits.push(s.commit(r));
    else if (r.record === 'branch') out.branches.push(s.branch(r));
    else out.checkouts.push(s.checkout(r));
  }
  for (const r of input.plan ?? []) {
    if (r.record === 'item') out.planItems.push(s.planItem(r));
    else out.transitions.push(s.transition(r));
  }
  for (const e of input.events ?? []) out.events.push(s.event(e));
  for (const r of input.sessions ?? []) out.sessions.push(s.session(r));
  for (const r of input.links ?? []) {
    const l = s.link(r);
    if (l) out.links.push(l);
  }
  for (const r of input.findings ?? []) out.findings.push(s.finding(r));
  out.summary = s.summary();
  return out;
}

