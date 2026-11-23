import * as crypto from 'crypto';
import { PlanItemKind, PlanItemRecord, PlanItemStatus, TransitionRecord, TransitionType } from '@snagboat/schema';
import { BeadsEvent, BeadsIssue, isBeadId } from './beadsExport';

/**
 * What the plan job (service/planRecordsJob.ts) makes of a project's plan, for plan.jsonl
 * (docs/design/export.md, "Plan: plan/items.jsonl, plan/transitions.jsonl"): bd's issues and
 * audit events mapped to PlanItemRecord and TransitionRecord, or plan items inferred from
 * planning markdown. Pure: the job runs bd and git and hands their output here.
 */

// ---- beads ----------------------------------------------------------------------------------

/** bd's issue_type to a plan item's kind. Anything else bd has (molecule, gate, spike, ...) is a task. */
export const BEADS_KINDS: Readonly<Record<string, PlanItemKind>> = {
  epic: 'epic',
  feature: 'feature',
  task: 'task',
  bug: 'bug',
  chore: 'task',
  decision: 'decision',
  question: 'question',
  milestone: 'milestone',
  note: 'note',
  step: 'step',
};

/** bd's status to a plan item's status. Anything else is open. */
export const BEADS_STATUSES: Readonly<Record<string, PlanItemStatus>> = {
  open: 'open',
  in_progress: 'in_progress',
  hooked: 'in_progress',
  blocked: 'blocked',
  deferred: 'deferred',
  pinned: 'open',
  closed: 'done',
  tombstone: 'dropped',
};

/** bd audit event types kept as transitions, with the type each becomes. Others (bd adds some over time) are skipped. */
const BEADS_EVENT_TYPES: Readonly<Record<string, TransitionType>> = {
  created: 'created',
  claimed: 'claimed',
  status_changed: 'status_changed',
  updated: 'updated',
  closed: 'closed',
  reopened: 'reopened',
  dependency_added: 'dependency_added',
  dependency_removed: 'dependency_removed',
  commented: 'commented',
  comment_added: 'commented',
  label_added: 'label_added',
  label_removed: 'label_removed',
};

/** An ISO 8601 UTC time with milliseconds, as the other store records have it; undefined when it isn't a time. */
export function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function beadsStatus(status: unknown): PlanItemStatus {
  return (typeof status === 'string' && BEADS_STATUSES[status]) || 'open';
}

/**
 * A bead as a plan item. `text` (description, design, notes, acceptance criteria) only when the
 * project captures content. People are bd's raw names; the export pseudonymizes them.
 */
export function beadsItem(issue: BeadsIssue, opts: { text: boolean; now: string }): PlanItemRecord {
  const updated = isoTime(issue.updated_at) ?? isoTime(issue.created_at) ?? opts.now;
  const parents: string[] = [];
  const blockedBy: string[] = [];
  for (const d of Array.isArray(issue.dependencies) ? issue.dependencies : []) {
    if (!d || d.issue_id !== issue.id || typeof d.depends_on_id !== 'string') continue;
    if (d.type === 'parent-child') parents.push(d.depends_on_id);
    else if (d.type === 'blocks' && !blockedBy.includes(d.depends_on_id)) blockedBy.push(d.depends_on_id);
  }
  const labels = Array.isArray(issue.labels) ? (issue.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
  const text: NonNullable<PlanItemRecord['text']> = {};
  if (opts.text) {
    const description = nonEmpty(issue.description);
    const design = nonEmpty(issue.design);
    const notes = nonEmpty(issue.notes);
    const acceptance = nonEmpty(issue.acceptance_criteria);
    if (description) text.description = description;
    if (design) text.design = design;
    if (notes) text.notes = notes;
    if (acceptance) text.acceptance = acceptance;
  }
  const started = isoTime(issue.started_at);
  const closed = isoTime(issue.closed_at);
  const item: PlanItemRecord = {
    record: 'item',
    version: 1,
    id: issue.id,
    kind: (typeof issue.issue_type === 'string' && BEADS_KINDS[issue.issue_type]) || 'task',
    title: typeof issue.title === 'string' ? issue.title : issue.id,
    status: beadsStatus(issue.status),
    ...(typeof issue.priority === 'number' ? { priority: issue.priority } : {}),
    ...(parents.length ? { parent: parents[0] } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
    labels: [...new Set(labels)].sort(),
    created: isoTime(issue.created_at) ?? updated,
    ...(started ? { started } : {}),
    updated,
    ...(closed ? { closed } : {}),
    ...(nonEmpty(issue.close_reason) ? { closeReason: issue.close_reason } : {}),
    ...(nonEmpty(issue.assignee) ? { assignee: issue.assignee } : {}),
    ...(nonEmpty(issue.owner) ? { owner: issue.owner } : {}),
    ...(nonEmpty(issue.created_by) ? { createdBy: issue.created_by } : {}),
    ...(Object.keys(text).length ? { text } : {}),
    source: 'beads',
    confidence: 'observed',
  };
  return item;
}

function parseObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The bead ids in a dependency event's text ("Added dependency: a blocks b", "Removed dependency on b"), other than the bead's own. */
function otherBead(text: string, own: string): string | undefined {
  // Bead ids share the project's prefix ("snagboat-"), which bd's words (parent-child, blocks) don't have.
  const dash = own.indexOf('-');
  const prefix = dash > 0 ? own.slice(0, dash + 1) : undefined;
  for (const token of text.split(/[\s,:;()]+/)) {
    if (token && token !== own && isBeadId(token) && (prefix ? token.startsWith(prefix) : /\d/.test(token))) return token;
  }
  return undefined;
}

/**
 * A bd audit event as a transition, or undefined for an event type this doesn't keep. Status
 * changes (claimed, status_changed) carry from and to, mapped as items' statuses are; closed and
 * reopened carry to; 'updated' carries only the names of bd's fields it changed; a dependency
 * names the other bead in to, a label the label.
 */
export function beadsTransition(e: BeadsEvent): TransitionRecord | undefined {
  const type = BEADS_EVENT_TYPES[e.event_type];
  const at = isoTime(e.created_at);
  if (!type || !at) return undefined;
  const t: TransitionRecord = { record: 'transition', version: 1, id: e.id, item: e.issue_id, at, type, actor: nonEmpty(e.actor) ?? 'unknown', confidence: 'observed' };
  const oldState = parseObject(e.old_value);
  const newState = parseObject(e.new_value);
  const note = nonEmpty(e.new_value) ?? nonEmpty(e.comment) ?? '';
  switch (type) {
    case 'claimed':
    case 'status_changed':
      if (oldState && typeof oldState.status === 'string') t.from = beadsStatus(oldState.status);
      if (newState && typeof newState.status === 'string') t.to = beadsStatus(newState.status);
      else if (type === 'claimed') t.to = 'in_progress';
      break;
    case 'closed':
      t.to = 'done';
      break;
    case 'reopened':
      t.to = 'open';
      break;
    case 'updated': {
      const fields = Object.keys(newState ?? {}).filter((k) => !oldState || JSON.stringify(oldState[k] ?? null) !== JSON.stringify(newState![k] ?? null));
      t.fields = fields.sort();
      break;
    }
    case 'dependency_added':
    case 'dependency_removed': {
      const other = otherBead(note, e.issue_id);
      if (other) t.to = other;
      break;
    }
    case 'label_added':
    case 'label_removed': {
      const m = /label:\s*(.+?)\s*$/i.exec(note);
      if (m) t.to = m[1];
      break;
    }
    default:
      break;
  }
  return t;
}

// ---- markdown -------------------------------------------------------------------------------

/** One item found in a markdown file, before times: the job adds those from git blame. */
export interface MarkdownItem {
  id: string;
  kind: PlanItemKind;
  title: string;
  /** Its own status: a heading's is worked out from its items (markdownItems does that). */
  status: PlanItemStatus;
  /** 'heading' or 'task'. */
  shape: 'heading' | 'task';
  parent?: string;
  /** 1-based line in the file. */
  line: number;
  /** Heading path, ' > ' joined, for from.heading. */
  heading?: string;
  /** An ISO date (YYYY-MM-DD) written on its line. */
  date?: string;
  /** A heading whose own line says its status (a marker or strikethrough), so it isn't worked out from its items. */
  ownStatus: boolean;
}

/** The first 12 hex of SHA-256 over the parts joined by newlines, after 'md-'. */
export function markdownItemId(parts: string[]): string {
  return `md-${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12)}`;
}

/** A markdown transition's id: 'md-t-' and 16 hex of SHA-256 over `${item}\n${at}\n${type}\n${to ?? ''}`. */
export function markdownTransitionId(item: string, at: string, type: TransitionType, to?: string): string {
  return `md-t-${crypto.createHash('sha256').update(`${item}\n${at}\n${type}\n${to ?? ''}`).digest('hex').slice(0, 16)}`;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const CHECKBOX = /^([ \t]*)[-*+][ \t]+\[([ xX~/-])\][ \t]+(.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,4})[.)][ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const DATE = /\b(20\d\d-[01]\d-[0-3]\d)\b/;
const MILESTONE = /\b(milestones?|phases?|releases?|sprints?|stages?|steps?|weeks?|v?\d+\.\d+(?:\.\d+)?)\b/i;

/** Words that say an item's status, checked in this order (so "not started" isn't "started"). */
const STATUS_WORDS: Array<[RegExp, PlanItemStatus]> = [
  [/^(?:dropped|cancell?ed|abandoned|won'?t do|wontfix|obsolete|superseded)\b/i, 'dropped'],
  [/^(?:deferred|postponed|on hold|parked)\b/i, 'deferred'],
  [/^blocked\b/i, 'blocked'],
  [/^(?:not started|not built|planned|todo|to do|next)\b/i, 'open'],
  [/^(?:in progress|in-progress|wip|underway|started|ongoing)\b/i, 'in_progress'],
  [/^(?:done|built|shipped|merged|complete|completed|finished|landed|released)\b/i, 'done'],
];

function wordStatus(clause: string): PlanItemStatus | undefined {
  const c = clause.replace(/^[\s*_`]+/, '');
  for (const [re, status] of STATUS_WORDS) if (re.test(c)) return status;
  return undefined;
}

/**
 * The status a line's text says, if any: strikethrough at its start, a ✅, a parenthesized or
 * bracketed note with a status word starting one of its clauses ("(done)", "(designed 2026-11-16;
 * built ...)", "[blocked]"), a bold lead that is one ("**Done:**"), or one after a dash or colon
 * at the end ("— done.", ": built").
 */
export function textStatus(text: string): PlanItemStatus | undefined {
  const t = text.trim();
  if (/^~~[^~].*?~~/.test(t)) return 'done';
  if (/[✅✔☑]/u.test(t)) return 'done';
  for (const m of t.matchAll(/[([]([^()[\]]{1,200})[)\]]/g)) {
    for (const clause of m[1].split(/[;,]/)) {
      const s = wordStatus(clause);
      if (s) return s;
    }
  }
  const bold = /^(?:\*\*|__)([^*_]{1,40}?)[:.]?(?:\*\*|__)/.exec(t);
  if (bold) {
    const s = wordStatus(bold[1]);
    if (s && bold[1].trim().split(/\s+/).length <= 3) return s;
  }
  const tail = /(?:\s[—–-]{1,2}|:)\s*([A-Za-z' -]{2,20}?)\s*[.!]?\s*(?:\*\*|__)?\s*[.!]?\s*$/.exec(t);
  if (tail) {
    const s = wordStatus(tail[1]);
    if (s) return s;
  }
  // The same, inside a bold lead: "**Move the files — done.** More text".
  const inBold = /^(?:\*\*|__)(.{1,200}?)(?:\*\*|__)/.exec(t);
  if (inBold) {
    const lead = /(?:\s[—–-]{1,2}|:)\s*([A-Za-z' -]{2,20}?)\s*[.!]?\s*$/.exec(inBold[1]);
    if (lead) {
      const s = wordStatus(lead[1]);
      if (s) return s;
    }
  }
  return undefined;
}

/** A title for people: markdown links, emphasis and code marks removed, at most 200 characters. */
export function plainTitle(text: string): string {
  const t = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/** A heading's text for its id: without strikethrough or a status note, so marking it done keeps its id. */
function headingKey(text: string): string {
  return plainTitle(text)
    .replace(/\s*[([][^()[\]]*[)\]]\s*$/, '')
    .replace(/\s*(?:[—–-]{1,2}|:)\s*[A-Za-z' -]{2,20}[.!]?\s*$/, (m) => (wordStatus(m.replace(/^[\s—–:-]+/, '')) ? '' : m))
    .replace(/[✅✔☑]/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * The plan items in one markdown file (path relative to the project), docs/design/export.md's
 * inference:
 * - `- [ ]` / `- [x]` checklists and numbered steps are tasks. `[x]` is done, `[~]` or `[/]` in
 *   progress, `[-]` dropped; otherwise the line's text decides (textStatus), else open. Nested
 *   under another task (indented deeper), its parent is that task.
 * - Headings become epics, or milestones when they name one (phase, milestone, release, step,
 *   a version...), but only headings with a task somewhere below them, so a design doc's prose
 *   sections aren't plan items. A heading's status is its own marker, else worked out from its
 *   items: all done (or dropped) is done, any done or in progress is in progress, else open.
 * - Ids: a heading's is md- + SHA-256 of `file`, then each heading of its path (lowercased,
 *   without status notes, a repeated sibling heading numbered "#2"), joined by newlines. A task's
 *   adds `#` and its position under its heading ("#3", "#3.1" for a nested one). So rewording an
 *   item, or marking it done, keeps its id; inserting a task above it in the same list doesn't.
 * Fenced code blocks are skipped.
 */
export function parseMarkdownPlan(file: string, text: string): MarkdownItem[] {
  const lines = text.split(/\r?\n/);
  const items: MarkdownItem[] = [];
  const headings: Array<{ level: number; key: string; title: string; item: MarkdownItem }> = [];
  const siblingCounts = new Map<string, number>();
  let tasks: Array<{ indent: number; ordinal: string; item: MarkdownItem; children: number }> = [];
  let topOrdinal = 0;
  let fence: string | undefined;
  const usedHeadings = new Set<MarkdownItem>();

  const headingPath = () => headings.map((h) => h.key);
  const headingLabel = () => (headings.length ? headings.map((h) => h.title).join(' > ') : undefined);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      const base = headingKey(h[2]) || '(untitled)';
      const sibling = `${headingPath().join('\n')}\n${base}`;
      const n = (siblingCounts.get(sibling) ?? 0) + 1;
      siblingCounts.set(sibling, n);
      const key = n > 1 ? `${base} #${n}` : base;
      const title = plainTitle(h[2]) || '(untitled)';
      const own = textStatus(h[2]);
      const parent = headings[headings.length - 1]?.item.id;
      const path = [...headingPath(), key];
      const item: MarkdownItem = {
        id: markdownItemId([file, ...path]),
        kind: MILESTONE.test(title) ? 'milestone' : 'epic',
        title,
        status: own ?? 'open',
        shape: 'heading',
        ...(parent ? { parent } : {}),
        line: i + 1,
        heading: [...headings.map((x) => x.title), title].join(' > '),
        ...(DATE.exec(h[2]) ? { date: DATE.exec(h[2])![1] } : {}),
        ownStatus: own !== undefined,
      };
      headings.push({ level, key, title, item });
      tasks = [];
      topOrdinal = 0;
      continue;
    }

    const c = CHECKBOX.exec(line);
    const num = c ? undefined : NUMBERED.exec(line);
    if (!c && !num) continue;
    const indent = (c ? c[1] : num![1]).replace(/\t/g, '    ').length;
    const body = c ? c[3] : num![3];
    while (tasks.length && tasks[tasks.length - 1].indent >= indent) tasks.pop();
    const enclosing = tasks[tasks.length - 1];
    let ordinal: string;
    if (enclosing) ordinal = `${enclosing.ordinal}.${++enclosing.children}`;
    else ordinal = String(++topOrdinal);
    let status: PlanItemStatus | undefined;
    if (c) {
      const mark = c[2];
      if (mark === 'x' || mark === 'X') status = 'done';
      else if (mark === '~' || mark === '/') status = 'in_progress';
      else if (mark === '-') status = 'dropped';
    }
    status ??= textStatus(body) ?? 'open';
    const heading = headings[headings.length - 1]?.item;
    if (heading) for (const x of headings) usedHeadings.add(x.item);
    const date = DATE.exec(body)?.[1];
    const item: MarkdownItem = {
      id: markdownItemId([file, ...headingPath(), `#${ordinal}`]),
      kind: 'task',
      title: plainTitle(body) || `(step ${ordinal})`,
      status,
      shape: 'task',
      ...(enclosing ? { parent: enclosing.item.id } : heading ? { parent: heading.id } : {}),
      line: i + 1,
      ...(headingLabel() ? { heading: headingLabel() } : {}),
      ...(date ? { date } : {}),
      ownStatus: true,
    };
    items.push(item);
    tasks.push({ indent, ordinal, item, children: 0 });
  }

  // Headings with tasks below them, in file order, then their statuses from their items.
  const kept = [...usedHeadings].sort((a, b) => a.line - b.line);
  const all = [...kept, ...items].sort((a, b) => a.line - b.line);
  const children = new Map<string, MarkdownItem[]>();
  for (const it of all) if (it.parent) children.set(it.parent, [...(children.get(it.parent) ?? []), it]);
  const derive = (it: MarkdownItem): PlanItemStatus => {
    if (it.shape === 'task' || it.ownStatus) return it.status;
    const kids = (children.get(it.id) ?? []).map(derive);
    if (kids.length === 0) return it.status;
    if (kids.every((s) => s === 'dropped')) return 'dropped';
    if (kids.every((s) => s === 'done' || s === 'dropped')) return 'done';
    if (kids.some((s) => s === 'done' || s === 'in_progress')) return 'in_progress';
    if (kids.every((s) => s === 'blocked' || s === 'deferred')) return kids[0];
    return 'open';
  };
  for (const it of kept) it.status = derive(it);
  return all;
}

/** Where a line's text last changed: from git blame. */
export interface LineOrigin {
  /** The commit's committer time (ISO 8601, UTC). */
  at: string;
  /** Its author's git ident, "Name <email>". */
  author: string;
}

/**
 * `git blame --porcelain` output as each final line's origin, 1-based. Lines not yet committed
 * (blame of a working tree) have no origin; the plan job blames HEAD, so all have one.
 */
export function parseBlame(out: string): Map<number, LineOrigin> {
  const commits = new Map<string, { name?: string; mail?: string; time?: number }>();
  const lines = new Map<number, LineOrigin>();
  let sha: string | undefined;
  let final = 0;
  const pending: number[] = [];
  const flush = () => {
    if (!sha) return;
    const c = commits.get(sha);
    if (c?.time !== undefined && !/^0+$/.test(sha)) {
      const origin = { at: new Date(c.time * 1000).toISOString(), author: `${c.name ?? ''} ${c.mail ?? '<>'}`.trim() };
      for (const n of pending) lines.set(n, origin);
    }
    pending.length = 0;
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      pending.push(final);
      flush();
      continue;
    }
    const head = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (head) {
      sha = head[1];
      final = Number(head[2]);
      if (!commits.has(sha)) commits.set(sha, {});
      continue;
    }
    const c = sha ? commits.get(sha) : undefined;
    if (!c) continue;
    if (line.startsWith('author ')) c.name = line.slice(7);
    else if (line.startsWith('author-mail ')) c.mail = line.slice(12);
    else if (line.startsWith('committer-time ')) c.time = Number(line.slice(15));
  }
  return lines;
}

/** A markdown item with times: created from what's stored (else its line's commit, or an earlier date on its line), updated from its line's commit. */
export function markdownRecord(
  file: string,
  it: MarkdownItem,
  origin: LineOrigin,
  stored: PlanItemRecord | undefined
): PlanItemRecord {
  const dateIso = it.date ? isoTime(`${it.date}T00:00:00Z`) : undefined;
  const created = stored?.created ?? (dateIso && dateIso < origin.at && it.status !== 'done' ? dateIso : origin.at);
  const done = it.status === 'done' || it.status === 'dropped';
  // A done item's closing: a date written on its line, else when its line last changed, kept once known.
  const closed = done ? (stored?.closed && (stored.status === 'done' || stored.status === 'dropped') ? stored.closed : (dateIso ?? origin.at)) : undefined;
  return {
    record: 'item',
    version: 1,
    id: it.id,
    kind: it.kind,
    title: it.title,
    status: it.status,
    ...(it.parent ? { parent: it.parent } : {}),
    labels: [],
    created: created > origin.at ? origin.at : created,
    updated: origin.at,
    ...(closed ? { closed } : {}),
    source: 'markdown',
    from: { file, ...(it.heading ? { heading: it.heading } : {}) },
    confidence: 'inferred',
  };
}

/** The transition a status change between two runs makes: closed, reopened, or status_changed. */
export function markdownTransition(item: string, from: PlanItemStatus | undefined, to: PlanItemStatus, origin: LineOrigin): TransitionRecord {
  const type: TransitionType = from === undefined ? 'created' : to === 'done' ? 'closed' : from === 'done' ? 'reopened' : 'status_changed';
  return {
    record: 'transition',
    version: 1,
    id: markdownTransitionId(item, origin.at, type, to),
    item,
    at: origin.at,
    type,
    ...(from !== undefined ? { from } : {}),
    to,
    actor: origin.author,
    confidence: 'inferred',
  };
}
