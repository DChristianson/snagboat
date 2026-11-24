import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BranchRecord,
  CheckoutRecord,
  CommitRecord,
  currentLinks,
  ExportManifest,
  FindingRecord,
  foldStoreRecords,
  GitRecord,
  LinkRecord,
  NormalizedEvent,
  PlanItemRecord,
  PlanRecord,
  SessionRecord,
  TransitionRecord,
} from '@snagboat/schema';
import { denyWords, effectiveSettings, EXPORT_DENY_KEY, EXPORT_RULES_KEY } from './config';
import { EventLog } from './eventLog';
import { commitsIn, ExportInput, ExportRecords, exportRecords, peopleIn, utc } from './exportFields';
import { EXPORT_SCHEMAS, readmeFile, README_FILE, schemaFiles, zipFiles } from './exportPackage';
import {
  Action,
  Filter,
  FilterMode,
  foldReviewFile,
  loadDecisions,
  makeContext,
  removeReviewFile,
  resolveActions,
  ReviewItem,
  RuleCounts,
  RULES,
  writeReviewFile,
} from './filter';
import { sessionRecords } from './sessionRecords';
import { readStoreRecordLines } from './storeRecordFiles';
import { listUserStores, UserStore } from './userStore';

/**
 * snagboat export (docs/design/export.md, "The command"): plumbing. It selects one project's
 * records from the per-user store, runs them through the privacy filter (core/filter, by way of
 * the one adapter that knows the records' fields, exportFields.ts), and either writes the export
 * folder or, while values the filter found are undecided, writes nothing and returns them for
 * review. It reads no git, no bd and no transcripts. In the store it writes only the filter's
 * state, in the project's own folder: its decisions, and the review file while one is pending.
 *
 * The CLI (`snagboat export`) and the VS Code command (Snagboat: Export Project...) both call
 * exportProject; neither does anything else but ask for the options and show the result.
 */

export interface ExportOptions {
  /** The Snagboat home folder (~/.snagboat, or SNAGBOAT_HOME). */
  home: string;
  /** The project's root, absolute: a repository's working tree, usually. */
  project: string;
  /** The export folder, absolute. */
  out: string;
  /** The project's name in the manifest; default the project folder's name. */
  name?: string;
  /** ISO 8601 bounds, by each record's own time: since inclusive, until exclusive. */
  since?: string;
  until?: string;
  text?: 'redacted' | 'none';
  /** --rule id=action, by rule id. */
  rules?: Record<string, Action>;
  /** --rewrite-all: every rule rewrites (a value you decided to keep stays kept). */
  rewriteAll?: boolean;
  /** --no-filter: every rule off. */
  noFilter?: boolean;
  /** Also write <out>.zip: the export folder's files under one folder named for it. */
  zip?: boolean;
  /** --match: more paths (absolute) whose workspaces' records are the project's. */
  match?: string[];
  /** For manifest.snagboatVersion. */
  version: string;
  now?: Date;
  /** This machine's home folder, for the home-path rule; default os.homedir(). */
  homeDir?: string;
}

/** One file of the export, by its path relative to the export folder. */
export interface ExportFile {
  file: string;
  text: string;
}

export interface ExportSelection {
  /** The workspaces read, by path. */
  workspaces: string[];
  /** Their working trees other than the project's: [worktree-1], [worktree-2], in this order. */
  worktrees: string[];
  /** The project's first commit; absent without git records. */
  firstCommit?: string;
}

export type ExportResult =
  | {
      ok: true;
      out: string;
      manifest: ExportManifest;
      /** <out>.zip, with --zip. */
      zipFile?: string;
      selection: ExportSelection;
      files: string[];
      notes: string[];
    }
  | {
      ok: false;
      reason: 'refused' | 'no-records';
      message: string;
      selection?: ExportSelection;
      notes: string[];
    }
  | {
      ok: false;
      reason: 'review';
      message: string;
      /** The review file, in the project's folder of the store: it holds the values. */
      reviewFile: string;
      /** The values still to decide. */
      pending: ReviewItem[];
      /** How many values each rule has undecided. */
      pendingByRule: Record<string, number>;
      selection: ExportSelection;
      notes: string[];
    };

/** manifest.json's format. */
const FORMAT = 'snagboat-export';

/** The root of the repository containing dir: the nearest folder with a .git (a folder or a worktree's file). Found by looking, not by running git. */
export function findProjectRoot(dir: string): string {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dir);
    current = parent;
  }
}

/** Parses --since / --until: a date (YYYY-MM-DD, UTC; --until's whole day is included) or an ISO time. */
export function parseExportTime(value: string, end: boolean): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const t = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(t)) return undefined;
    return new Date(end ? t + 86_400_000 : t).toISOString();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function inside(dir: string, folder: string): boolean {
  const norm = (x: string) => (process.platform === 'darwin' || process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const rel = path.relative(norm(folder), norm(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const same = (a: string, b: string) => inside(a, b) && inside(b, a);

/** A store's path: its folder, else its .code-workspace file or identity. */
const storePath = (s: UserStore) => s.folder ?? s.workspaceFile ?? s.workspace;

/**
 * The git common dir of a working tree, by reading its .git (a folder, or a worktree's
 * `gitdir:` file and that folder's commondir), never by running git. undefined when unreadable.
 */
export function gitCommonDir(worktree: string): string | undefined {
  const dotGit = path.join(worktree, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return path.resolve(dotGit);
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return undefined;
    const gitdir = path.resolve(worktree, m[1]);
    try {
      return path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    } catch {
      // <common>/worktrees/<name>
      return path.basename(path.dirname(gitdir)) === 'worktrees' ? path.dirname(path.dirname(gitdir)) : undefined;
    }
  } catch {
    return undefined;
  }
}

/** The repository's root commits in a set of git records: commits with no parents, earliest first. */
function rootCommits(git: GitRecord[]): CommitRecord[] {
  return git
    .filter((r): r is CommitRecord => r.record === 'commit' && r.parents.length === 0)
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.sha.localeCompare(b.sha));
}

/** A store's working tree: where its checkouts happened (their `where`), else its folder. */
function workingTree(s: UserStore, git: GitRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of git) if (r.record === 'checkout') counts.set(r.where, (counts.get(r.where) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return best ?? storePath(s);
}

interface Selected {
  store: UserStore;
  /** Its working tree, absolute. */
  root: string;
  git: GitRecord[];
}

/**
 * The workspaces whose records are the project's: the project's own, any inside it, any inside
 * a --match path, and the repository's other worktrees: workspaces whose git.jsonl has the
 * project's root commit and (when both can be read from disk) the same git common dir, so a
 * separate clone of the same repository isn't one.
 */
export function selectWorkspaces(home: string, project: string, match: string[] = []): { selected: Selected[]; firstCommit?: string } {
  const stores = listUserStores(home).sort((a, b) => storePath(a).localeCompare(storePath(b)));
  const gitOf = new Map<string, GitRecord[]>();
  const git = (s: UserStore) => {
    let g = gitOf.get(s.dir);
    if (!g) gitOf.set(s.dir, (g = readStoreRecordLines<GitRecord>(path.join(s.dir, 'git.jsonl'))));
    return g;
  };
  const direct = stores.filter((s) => inside(storePath(s), project) || match.some((m) => inside(storePath(s), m)));
  const own = direct.filter((s) => inside(storePath(s), project));
  const roots = rootCommits(own.flatMap(git));
  const rootShas = new Set(roots.map((c) => c.sha));
  const commonDir = gitCommonDir(project);
  const siblings = rootShas.size === 0
    ? []
    : stores.filter((s) => {
        if (direct.includes(s)) return false;
        if (!rootCommits(git(s)).some((c) => rootShas.has(c.sha))) return false;
        const theirs = s.folder ? gitCommonDir(s.folder) : undefined;
        return !commonDir || !theirs || same(commonDir, theirs);
      });
  const selected = [...direct, ...siblings].map((store) => ({ store, root: workingTree(store, git(store)), git: git(store) }));
  return { selected, firstCommit: roots[0]?.sha };
}

/** Why --out can't be used, or undefined: inside the project or one of its trees (outside their .snagboat/), in the store, or an existing folder that isn't an export. */
export function checkOut(out: string, home: string, trees: string[]): string | undefined {
  for (const t of trees) {
    if (!inside(out, t)) continue;
    const snagboatDir = path.join(t, '.snagboat');
    if (inside(out, snagboatDir) && !same(out, snagboatDir)) continue;
    return `--out ${out} is inside the project (${t}), where an export could get committed. Give a folder outside it, or one under its .snagboat/ folder (the export makes that ignored).`;
  }
  if (inside(out, path.join(home, 'data'))) return `--out ${out} is inside Snagboat's store (${path.join(home, 'data')}); the export writes nothing there.`;
  let st: fs.Stats;
  try {
    st = fs.statSync(out);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return `${out} exists and isn't a folder.`;
  if (fs.readdirSync(out).length > 0 && !isExportFolder(out)) return `${out} already holds something that isn't a Snagboat export; give an empty or new folder.`;
  return undefined;
}

function isExportFolder(dir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { format?: string }).format === FORMAT;
  } catch {
    return false;
  }
}

const ms = (t: string | undefined) => (t === undefined ? NaN : Date.parse(t));

/** Whether [from, to] (to absent: still going) overlaps the range. */
function overlaps(from: string | undefined, to: string | undefined, since?: string, until?: string): boolean {
  const a = ms(from);
  const b = to === undefined ? Infinity : ms(to);
  if (since !== undefined && !(b >= ms(since))) return false;
  if (until !== undefined && !(Number.isNaN(a) ? true : a < ms(until))) return false;
  return true;
}

const at = (t: string | undefined, since?: string, until?: string) => overlaps(t, t, since, until);

/** Reads the selected workspaces' records, folded by key across them, in the range, in a stable order. */
async function readRecords(selected: Selected[], since?: string, until?: string): Promise<ExportInput & { sessions: SessionRecord[] }> {
  const commits = new Map<string, CommitRecord>();
  const branches = new Map<string, BranchRecord>();
  const checkouts = new Map<string, CheckoutRecord>();
  const items = new Map<string, PlanItemRecord>();
  const transitions = new Map<string, TransitionRecord>();
  const links = new Map<string, LinkRecord>();
  const findings = new Map<string, FindingRecord>();
  const events = new Map<string, NormalizedEvent>();
  const sessions = new Map<string, SessionRecord>();
  for (const { store, root, git } of selected) {
    for (const r of foldStoreRecords(git)) {
      if (r.record === 'commit') {
        if (at(r.committedAt, since, until)) commits.set(r.sha, r);
      } else if (r.record === 'branch') {
        if (overlaps(r.createdAt ?? r.firstSeenAt, r.deletedAt ?? r.merged?.at, since, until)) {
          const have = branches.get(r.id);
          // The same branch in two worktrees' files: the one that knows more (merged, deleted).
          if (!have || JSON.stringify(r).length >= JSON.stringify(have).length) branches.set(r.id, r);
        }
      } else if (at(r.at, since, until)) checkouts.set(r.id, r);
    }
    for (const r of foldStoreRecords(readStoreRecordLines<PlanRecord>(path.join(store.dir, 'plan.jsonl')))) {
      if (r.record === 'item') {
        if (!overlaps(r.created, r.closed, since, until)) continue;
        const have = items.get(r.id);
        if (!have || r.updated >= have.updated) items.set(r.id, r);
      } else if (r.record === 'transition' && at(r.at, since, until)) transitions.set(r.id, r);
    }
    const linkLines = readStoreRecordLines<LinkRecord>(path.join(store.dir, 'links.jsonl'));
    for (const l of currentLinks(linkLines)) if (l.at === undefined || at(l.at, since, until)) links.set(l.id, l);
    for (const f of foldStoreRecords(readStoreRecordLines<FindingRecord>(path.join(store.dir, 'findings.jsonl')))) {
      if (overlaps(f.firstTs, f.lastTs, since, until)) findings.set(f.id, f);
    }
    const own: NormalizedEvent[] = [];
    for (const e of await new EventLog(store.dir).readAll()) {
      if (!at(e.ts, since, until) || events.has(e.eventId)) continue;
      events.set(e.eventId, e);
      own.push(e);
    }
    for (const s of sessionRecords({ events: own, links: linkLines, git, where: root })) if (!sessions.has(s.sessionId)) sessions.set(s.sessionId, s);
  }
  const by = <T>(xs: Iterable<T>, key: (x: T) => string) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    git: [
      ...by(commits.values(), (c) => `${utc(c.committedAt)}\0${c.sha}`),
      ...by(branches.values(), (b) => b.id),
      ...by(checkouts.values(), (c) => `${utc(c.at)}\0${c.id}`),
    ],
    plan: [...by(items.values(), (i) => i.id), ...by(transitions.values(), (t) => `${utc(t.at)}\0${t.id}`)],
    events: by(events.values(), (e) => `${utc(e.ts)}\0${e.eventId}`),
    sessions: by(sessions.values(), (s) => `${utc(s.firstTs)}\0${s.sessionId}`),
    links: by(links.values(), (l) => l.id),
    findings: by(findings.values(), (f) => `${utc(f.firstTs)}\0${f.id}`),
  };
}

const jsonl = (rs: unknown[]) => rs.map((r) => JSON.stringify(r) + '\n').join('');


/** The export's files and manifest from the filtered records. */
function exportFiles(
  out: ExportRecords,
  manifestBase: Pick<ExportManifest, 'generatedAt' | 'project' | 'text' | 'snagboatVersion' | 'filter' | 'rules'>,
  range: ExportManifest['range']
): { files: ExportFile[]; manifest: ExportManifest } {
  const days = new Map<string, unknown[]>();
  for (const e of out.events) {
    const day = e.ts.slice(0, 10);
    let list = days.get(day);
    if (!list) days.set(day, (list = []));
    list.push(e);
  }
  const first = out.events[0]?.ts;
  const last = out.events[out.events.length - 1]?.ts;
  // Key order as the schema lists them, so two manifests compare line by line.
  const manifest: ExportManifest = {
    format: FORMAT,
    version: 2,
    eventSchema: 4,
    generatedAt: manifestBase.generatedAt,
    project: manifestBase.project,
    range: { ...range, ...(first ? { first } : {}), ...(last ? { last } : {}) },
    text: manifestBase.text,
    counts: {
      days: days.size,
      events: out.events.length,
      sessions: out.sessions.length,
      findings: out.findings.length,
      commits: out.commits.length,
      branches: out.branches.length,
      checkouts: out.checkouts.length,
      planItems: out.planItems.length,
      transitions: out.transitions.length,
      links: out.links.length,
    },
    snagboatVersion: manifestBase.snagboatVersion,
    filter: manifestBase.filter,
    rules: manifestBase.rules,
    readme: README_FILE,
    schemas: EXPORT_SCHEMAS,
  };
  const files: ExportFile[] = [
    { file: 'manifest.json', text: JSON.stringify(manifest, null, 2) + '\n' },
    ...[...days.keys()].sort().map((day) => ({ file: `events/${day}.jsonl`, text: jsonl(days.get(day)!) })),
    { file: 'sessions.jsonl', text: jsonl(out.sessions) },
    { file: 'findings.jsonl', text: jsonl(out.findings) },
    { file: 'git/commits.jsonl', text: jsonl(out.commits) },
    { file: 'git/branches.jsonl', text: jsonl(out.branches) },
    { file: 'git/checkouts.jsonl', text: jsonl(out.checkouts) },
    { file: 'plan/items.jsonl', text: jsonl(out.planItems) },
    { file: 'plan/transitions.jsonl', text: jsonl(out.transitions) },
    { file: 'links.jsonl', text: jsonl(out.links) },
    readmeFile(),
    ...schemaFiles(),
  ];
  return { files, manifest };
}

/** Writes files under a new folder (owner-only). */
function writeFolder(dir: string, files: ExportFile[]): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const p = path.join(dir, ...f.file.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, f.text, { mode: 0o600 });
  }
}

/** Puts a freshly written folder at dest, replacing what's there: rename the old one aside, rename the new one in, remove the old. */
function swapIn(temp: string, dest: string): void {
  const old = `${temp}.old`;
  let moved = false;
  if (fs.existsSync(dest)) {
    fs.renameSync(dest, old);
    moved = true;
  }
  try {
    fs.renameSync(temp, dest);
  } catch (err) {
    if (moved) fs.renameSync(old, dest);
    throw err;
  }
  if (moved) fs.rmSync(old, { recursive: true, force: true });
}

/** Under a project's .snagboat/: makes the export's folder ignored, as the beads exporter does (.snagboat/beads/.gitignore), without running git. */
function ignoreInProject(out: string, trees: string[]): void {
  const t = trees.find((t) => inside(out, path.join(t, '.snagboat')));
  if (!t) return;
  const parent = path.dirname(out);
  const file = path.join(parent, '.gitignore');
  if (inside(parent, path.join(t, '.snagboat')) && !same(parent, path.join(t, '.snagboat')) && !fs.existsSync(file)) {
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(file, '# Snagboat exports (snagboat export): never committed.\n*\n');
    return;
  }
  // Directly under .snagboat/: ignore just this export and its zip.
  const lines = [`/${path.basename(out)}/`, `/${path.basename(out)}.zip`, '/.*.snagboat-tmp-*'];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // none yet
  }
  const missing = lines.filter((l) => !text.split('\n').includes(l));
  if (missing.length === 0 || text.split('\n').includes('*')) return;
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(file, (text && !text.endsWith('\n') ? text + '\n' : text) + (text ? '' : '# Snagboat exports (snagboat export): never committed.\n') + missing.join('\n') + '\n');
}


/**
 * The store folder that keeps the project's filter state (decisions, the review file): the
 * project's own workspace's, else the first selected.
 */
function filterStateDir(selected: Selected[], project: string): string {
  return (selected.find((s) => s.store.folder && same(s.store.folder, project)) ?? selected[0]).store.dir;
}

/** Runs one export. Writes nothing while values are undecided, or when a check fails. */
export async function exportProject(opts: ExportOptions): Promise<ExportResult> {
  const notes: string[] = [];
  const now = opts.now ?? new Date();
  const project = path.resolve(opts.project);
  const out = path.resolve(opts.out);
  const match = (opts.match ?? []).map((m) => path.resolve(m));
  const { selected, firstCommit } = selectWorkspaces(opts.home, project, match);
  const worktrees = [...new Set(selected.map((s) => s.root))]
    .filter((r) => !same(r, project) && !match.some((m) => inside(r, m)) && path.isAbsolute(r))
    .sort();
  const selection: ExportSelection = { workspaces: selected.map((s) => storePath(s.store)), worktrees, ...(firstCommit ? { firstCommit } : {}) };

  const refused = checkOut(out, opts.home, [project, ...worktrees, ...match]);
  if (refused) return { ok: false, reason: 'refused', message: refused, selection, notes };
  if (selected.length === 0) {
    return { ok: false, reason: 'no-records', message: `Snagboat's store (${path.join(opts.home, 'data')}) has no workspace at or inside ${project}${match.length ? ' or the --match paths' : ''}.`, selection, notes };
  }

  const input = await readRecords(selected, opts.since, opts.until);

  // The filter: what it knows about the project, and each rule's action (config.ts: a
  // .snagboat.json can set neither export.rules nor anything that makes an export less private).
  const settings = effectiveSettings(opts.home, project);
  for (const p of settings.problems) notes.push(`setting ignored: ${p}`);
  const { actions, mode, problems } = resolveActions(RULES, { setting: settings.values[EXPORT_RULES_KEY], rules: opts.rules, rewriteAll: opts.rewriteAll, noFilter: opts.noFilter });
  for (const p of problems) notes.push(`setting ignored: ${p}`);
  // Commits the repository has, from each workspace's whole git.jsonl, so a SHA outside the
  // export's range is still a known commit; people from the whole of it too.
  const allGit = selected.flatMap((s) => s.git);
  const ctx = makeContext({
    projectRoot: project,
    worktrees,
    matchPaths: match,
    homes: [opts.homeDir ?? os.homedir()],
    people: peopleIn({ git: [...allGit, ...(input.git ?? [])], plan: input.plan }),
    commits: commitsIn(allGit),
    deny: denyWords(settings.values[EXPORT_DENY_KEY]),
  });
  const filter = new Filter(RULES, ctx, actions);
  const text = opts.text ?? 'redacted';
  exportRecords(input, (s) => (filter.scan(s), s), { text });

  // Decisions: what the review file says now, folded into what was decided before.
  const stateDir = filterStateDir(selected, project);
  const folded = foldReviewFile(stateDir, now);
  for (const p of folded.problems) notes.push(`review file: ${p}`);
  const decisions = loadDecisions(stateDir);
  const pending = filter.settle((id) => decisions.get(id));
  if (pending.length > 0) {
    const reviewFile = writeReviewFile(stateDir, project, pending, now);
    const pendingByRule: Record<string, number> = {};
    for (const p of pending) pendingByRule[p.rule] = (pendingByRule[p.rule] ?? 0) + 1;
    return {
      ok: false,
      reason: 'review',
      message: `${pending.length} value${pending.length === 1 ? '' : 's'} the privacy filter found need${pending.length === 1 ? 's' : ''} a decision before anything is exported.`,
      reviewFile,
      pending,
      pendingByRule,
      selection,
      notes,
    };
  }

  const records = exportRecords(input, (s) => filter.apply(s), { text });
  const range: ExportManifest['range'] = { ...(opts.since ? { since: opts.since } : {}), ...(opts.until ? { until: opts.until } : {}) };
  const { files, manifest } = exportFiles(
    records,
    { generatedAt: now.toISOString(), project: opts.name ?? path.basename(project), text, snagboatVersion: opts.version, filter: mode, rules: filter.counts() },
    range
  );

  // Write beside --out, then rename into place: a rerun replaces the export whole, or not at all.
  const parent = path.dirname(out);
  fs.mkdirSync(parent, { recursive: true });
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const temp = path.join(parent, `.${path.basename(out)}.snagboat-tmp-${tag}`);
  const zipFile = `${out}.zip`;
  const zipTemp = `${temp}.zip`;
  try {
    ignoreInProject(out, [project, ...worktrees, ...match]);
    writeFolder(temp, files);
    if (opts.zip) fs.writeFileSync(zipTemp, zipFiles(path.basename(out), files, new Date(manifest.generatedAt)), { mode: 0o600 });
    swapIn(temp, out);
    if (opts.zip) fs.renameSync(zipTemp, zipFile);
    else fs.rmSync(zipFile, { force: true }); // an old zip would be another export
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(zipTemp, { force: true });
  }
  removeReviewFile(stateDir);
  return { ok: true, out, manifest, ...(opts.zip ? { zipFile } : {}), selection, files: files.map((f) => f.file), notes };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each rule did, for people: "email 2 rewritten, sha 14 kept". */
export function ruleCountsText(rules: RuleCounts): string {
  const parts = Object.entries(rules).map(([id, c]) => [id, ...(c.rewritten ? [`${c.rewritten} rewritten`] : []), ...(c.kept ? [`${c.kept} kept`] : [])].join(' '));
  return parts.length ? parts.join(', ') : 'nothing found';
}

/** The human summary `snagboat export` prints. */
export function exportSummaryText(r: Extract<ExportResult, { ok: true }>): string {
  const c = r.manifest.counts;
  const lines = [
    `Exported ${r.manifest.project} to ${r.out}${r.zipFile ? `, and ${r.zipFile}` : ''}`,
    `  ${c.events} events over ${plural(c.days, 'day')}, ${c.sessions} sessions, ${c.findings} findings`,
    `  git: ${c.commits} commits, ${c.branches} branches, ${c.checkouts} checkouts`,
    `  plan: ${c.planItems} items, ${c.transitions} transitions; ${c.links} links`,
    `  from ${plural(r.selection.workspaces.length, 'workspace')}${r.selection.worktrees.length ? ` (${plural(r.selection.worktrees.length, 'other worktree')})` : ''}`,
    `  text: ${r.manifest.text}`,
    r.manifest.filter === 'none' ? 'Privacy filter: off (--no-filter); nothing was rewritten' : `Privacy filter (${r.manifest.filter}), values by rule: ${ruleCountsText(r.manifest.rules)}`,
  ];
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.join('\n') + '\n';
}

/** What `snagboat export` prints while values are undecided. */
export function reviewSummaryText(r: Extract<ExportResult, { reason: 'review' }>): string {
  const lines = [
    `Nothing exported: ${r.message}`,
    ...Object.entries(r.pendingByRule).map(([rule, n]) => `  ${rule}: ${plural(n, 'value')}`),
    `Review file (in Snagboat's store, never in the project; it holds the values): ${r.reviewFile}`,
    '  Set each item\'s "decision" to "rewrite" or "keep" and run the export again; decisions are kept for later exports.',
    '  Or decide a whole rule: --rule <rule>=rewrite (or keep), or --rewrite-all.',
  ];
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.join('\n') + '\n';
}
