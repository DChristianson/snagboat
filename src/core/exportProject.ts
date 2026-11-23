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
import { denyWords, effectiveSettings, EXPORT_DENY_KEY } from './config';
import { EventLog } from './eventLog';
import { ensureExportKey, exportKeyPath, ExportInput, finalCheck, FinalCheckHit, RepositoryPrivacy, ReviewEntry, sanitizeExport, SanitizedExport, utc } from './export';
import { EXPORT_SCHEMAS, readmeFile, README_FILE, schemaFiles, zipFiles } from './exportPackage';
import { sessionRecords } from './sessionRecords';
import { readStoreRecordLines } from './storeRecordFiles';
import { listUserStores, UserStore } from './userStore';

/**
 * snagboat export (docs/design/export.md, "The command"): one project's records from the
 * per-user store, through the privacy rules (src/core/export), written as an export folder plus
 * <out>.review/ beside it. It only reads the store: no git, no bd, no transcripts, and nothing
 * is written back to the store (the export key, ~/.snagboat/export-keys/, is made on first use).
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
  /** --allow: flag ids (flagged-3) put back. */
  allow?: string[];
  /** --allow-rule: rules put back. */
  allowRules?: string[];
  /** Write nothing when anything is flagged. */
  failOnFlags?: boolean;
  /** Also write <out>.zip: the export folder's files under one folder named for it, never the review folder. */
  zip?: boolean;
  /** --match: more paths (absolute) whose workspaces' records are the project's. */
  match?: string[];
  /** For manifest.snagboatVersion. */
  version: string;
  now?: Date;
  /** This machine, for rule 1; default os.homedir(), os.userInfo().username, os.hostname(). */
  machine?: { homeDir: string; userName: string; hostName: string };
  /** Tests only: changes the files after sanitizing and before the final check. */
  beforeCheck?: (files: ExportFile[]) => void;
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
  /** The project's first commit, which names its export key; absent without git records. */
  firstCommit?: string;
}

export type ExportResult =
  | {
      ok: true;
      out: string;
      manifest: ExportManifest;
      /** <out>.zip, with --zip. */
      zipFile?: string;
      /** <out>.review/flags.jsonl, when anything was flagged (or put back). */
      reviewFile?: string;
      review: ReviewEntry[];
      selection: ExportSelection;
      keyFile: string;
      files: string[];
      notes: string[];
    }
  | {
      ok: false;
      reason: 'refused' | 'no-records' | 'flags' | 'final-check';
      message: string;
      /** final-check: which rule hit which file, how often. Never the values. */
      hits?: FinalCheckHit[];
      /** flags: how many values were flagged, by rule. */
      flagsByRule?: Record<string, number>;
      selection?: ExportSelection;
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
  for (const dir of [out, `${out}.review`]) {
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) return `${dir} exists and isn't a folder.`;
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) continue;
    if (dir === out && !isExportFolder(out)) return `${out} already holds something that isn't a Snagboat export; give an empty or new folder.`;
    if (dir !== out && entries.some((e) => e !== 'flags.jsonl')) return `${dir} holds more than an export's review file; move it first.`;
  }
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

/** The export's files and manifest from the sanitized records. */
function exportFiles(out: SanitizedExport, manifestBase: Omit<ExportManifest, 'counts' | 'range' | 'redactions' | 'flags' | 'rulesVersion' | 'readme' | 'schemas'>, range: ExportManifest['range']): { files: ExportFile[]; manifest: ExportManifest } {
  const days = new Map<string, unknown[]>();
  for (const e of out.events) {
    const day = e.ts.slice(0, 10);
    let list = days.get(day);
    if (!list) days.set(day, (list = []));
    list.push(e);
  }
  const recs = <T>(xs: Array<{ record: T }>) => xs.map((x) => x.record);
  const first = out.events[0]?.ts;
  const last = out.events[out.events.length - 1]?.ts;
  const manifest: ExportManifest = {
    ...manifestBase,
    range: { ...range, ...(first ? { first } : {}), ...(last ? { last } : {}) },
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
    rulesVersion: out.summary.rulesVersion,
    redactions: out.summary.redactions,
    flags: out.summary.flags,
    readme: README_FILE,
    schemas: EXPORT_SCHEMAS,
  };
  // Key order as the schema lists them, so two manifests compare line by line.
  const ordered: ExportManifest = {
    format: manifest.format,
    version: manifest.version,
    eventSchema: manifest.eventSchema,
    generatedAt: manifest.generatedAt,
    project: manifest.project,
    range: manifest.range,
    text: manifest.text,
    counts: manifest.counts,
    rulesVersion: manifest.rulesVersion,
    snagboatVersion: manifest.snagboatVersion,
    redactions: manifest.redactions,
    flags: manifest.flags,
    repository: manifest.repository,
    readme: manifest.readme,
    schemas: manifest.schemas,
  };
  const files: ExportFile[] = [
    { file: 'manifest.json', text: JSON.stringify(ordered, null, 2) + '\n' },
    ...[...days.keys()].sort().map((day) => ({ file: `events/${day}.jsonl`, text: jsonl(days.get(day)!) })),
    { file: 'sessions.jsonl', text: jsonl(recs(out.sessions)) },
    { file: 'findings.jsonl', text: jsonl(recs(out.findings)) },
    { file: 'git/commits.jsonl', text: jsonl(recs(out.commits)) },
    { file: 'git/branches.jsonl', text: jsonl(recs(out.branches)) },
    { file: 'git/checkouts.jsonl', text: jsonl(recs(out.checkouts)) },
    { file: 'plan/items.jsonl', text: jsonl(recs(out.planItems)) },
    { file: 'plan/transitions.jsonl', text: jsonl(recs(out.transitions)) },
    { file: 'links.jsonl', text: jsonl(recs(out.links)) },
    readmeFile(),
    ...schemaFiles(),
  ];
  return { files, manifest: ordered };
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
  // Directly under .snagboat/: ignore just this export and its review folder.
  const lines = [`/${path.basename(out)}/`, `/${path.basename(out)}.review/`, `/${path.basename(out)}.zip`, '/.*.snagboat-tmp-*'];
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

/** Runs one export. Writes nothing unless every check passes. */
export async function exportProject(opts: ExportOptions): Promise<ExportResult> {
  const notes: string[] = [];
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

  // Privacy, deny words and the key, from the project's settings (config.ts: a .snagboat.json can't make it public).
  const settings = effectiveSettings(opts.home, project);
  for (const p of settings.problems) notes.push(`setting ignored: ${p}`);
  const privacy: RepositoryPrivacy = settings.values['export.public'] === true ? 'public' : 'private';
  let keyFile: string;
  if (privacy === 'private' && firstCommit) keyFile = exportKeyPath(opts.home, 'private', firstCommit);
  else {
    keyFile = exportKeyPath(opts.home, 'public');
    if (privacy === 'private') notes.push("the store has no commits for this project, so its pseudonyms use this machine's key (~/.snagboat/export.key), not a repository key");
  }
  const key = ensureExportKey(keyFile);
  notes.push('remote URLs: the store records none, so none are searched for; name the project with --name, never its remote');

  const machine = opts.machine ?? { homeDir: os.homedir(), userName: safeUserName(), hostName: os.hostname() };
  // A container's stock account (vscode, node, root) names nobody, and replacing it as a word
  // would turn .vscode/settings.json into .[user]/settings.json. The home folder is still a path.
  const genericUser = GENERIC_USERS.has(machine.userName.toLowerCase());
  if (genericUser) notes.push(`the user name "${machine.userName}" is a stock account name, so it isn't replaced as a word (paths under ${machine.homeDir} still are)`);
  const sanitized = sanitizeExport(input, {
    projectRoot: project,
    worktreeRoots: worktrees,
    matchPaths: match,
    homeDir: machine.homeDir,
    userName: genericUser ? '' : machine.userName,
    hostName: machine.hostName,
    privacy,
    key,
    text: opts.text ?? 'redacted',
    deny: denyWords(settings.values[EXPORT_DENY_KEY]),
    remotes: [],
    allow: opts.allow ?? [],
    allowRules: opts.allowRules ?? [],
  });

  const flagsByRule: Record<string, number> = {};
  for (const r of sanitized.summary.review) if (!r.allowed) flagsByRule[r.rule] = (flagsByRule[r.rule] ?? 0) + 1;
  if (opts.failOnFlags && sanitized.summary.flags > 0) {
    return {
      ok: false,
      reason: 'flags',
      message: `${sanitized.summary.flags} value${sanitized.summary.flags === 1 ? ' was' : 's were'} flagged for review, and --fail-on-flags writes nothing then. Run without it to see them in the review file.`,
      flagsByRule,
      selection,
      notes,
    };
  }

  const range: ExportManifest['range'] = { ...(opts.since ? { since: opts.since } : {}), ...(opts.until ? { until: opts.until } : {}) };
  const { files, manifest } = exportFiles(
    sanitized,
    {
      format: FORMAT,
      version: 1,
      eventSchema: 4,
      generatedAt: (opts.now ?? new Date()).toISOString(),
      project: opts.name ?? path.basename(project),
      text: opts.text ?? 'redacted',
      snagboatVersion: opts.version,
      repository: { privacy },
    },
    range
  );
  opts.beforeCheck?.(files);

  // Rule 5: the final check over every file, before anything reaches --out.
  const hits = finalCheck(files, sanitized.summary.finalCheck);
  if (hits.length > 0) {
    return {
      ok: false,
      reason: 'final-check',
      message: `The final check found values the rules should have removed, so nothing was written:\n${hits.map((h) => `  ${h.rule} in ${h.file} (${h.count})`).join('\n')}\nThis is a bug in the privacy rules; please report the rule and file (not the value).`,
      hits,
      selection,
      notes,
    };
  }

  // Write beside --out, then rename into place: a rerun replaces the export whole, or not at all.
  const parent = path.dirname(out);
  fs.mkdirSync(parent, { recursive: true });
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const temp = path.join(parent, `.${path.basename(out)}.snagboat-tmp-${tag}`);
  const reviewDir = `${out}.review`;
  const reviewTemp = `${temp}.review`;
  const zipFile = `${out}.zip`;
  const zipTemp = `${temp}.zip`;
  const review = sanitized.summary.review;
  try {
    ignoreInProject(out, [project, ...worktrees, ...match]);
    writeFolder(temp, files);
    if (review.length > 0) writeFolder(reviewTemp, [{ file: 'flags.jsonl', text: jsonl(review) }]);
    // The zip holds exactly the files the final check read, never the review folder.
    if (opts.zip) fs.writeFileSync(zipTemp, zipFiles(path.basename(out), files, new Date(manifest.generatedAt)), { mode: 0o600 });
    swapIn(temp, out);
    if (opts.zip) fs.renameSync(zipTemp, zipFile);
    else fs.rmSync(zipFile, { force: true }); // an old zip would be another export
    if (review.length > 0) swapIn(reviewTemp, reviewDir);
    else fs.rmSync(reviewDir, { recursive: true, force: true }); // an old review would describe another export
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(reviewTemp, { recursive: true, force: true });
    fs.rmSync(zipTemp, { force: true });
  }
  return {
    ok: true,
    out,
    manifest,
    ...(opts.zip ? { zipFile } : {}),
    ...(review.length > 0 ? { reviewFile: path.join(reviewDir, 'flags.jsonl') } : {}),
    review,
    selection,
    keyFile,
    files: files.map((f) => f.file),
    notes,
  };
}

/** Accounts dev containers and CI images run as: no one's name. */
const GENERIC_USERS = new Set(['root', 'vscode', 'node', 'codespace', 'ubuntu', 'debian', 'user', 'dev', 'developer', 'admin', 'runner']);

function safeUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return path.basename(os.homedir());
  }
}

/** The human summary `snagboat export` prints. */
export function exportSummaryText(r: Extract<ExportResult, { ok: true }>): string {
  const c = r.manifest.counts;
  const lines = [
    `Exported ${r.manifest.project} to ${r.out}${r.zipFile ? `, and ${r.zipFile}` : ''}`,
    `  ${c.events} events over ${c.days} day${c.days === 1 ? '' : 's'}, ${c.sessions} sessions, ${c.findings} findings`,
    `  git: ${c.commits} commits, ${c.branches} branches, ${c.checkouts} checkouts`,
    `  plan: ${c.planItems} items, ${c.transitions} transitions; ${c.links} links`,
    `  from ${r.selection.workspaces.length} workspace${r.selection.workspaces.length === 1 ? '' : 's'}${r.selection.worktrees.length ? ` (${r.selection.worktrees.length} other worktree${r.selection.worktrees.length === 1 ? '' : 's'})` : ''}`,
    `  repository: ${r.manifest.repository.privacy}${r.manifest.repository.privacy === 'private' ? ' (commit SHAs re-keyed)' : ' (export.public: SHAs kept)'}; key ${r.keyFile}`,
    `  text: ${r.manifest.text}`,
  ];
  const red = Object.entries(r.manifest.redactions);
  lines.push(red.length ? `Replaced, by rule: ${red.map(([k, v]) => `${k} ${v}`).join(', ')}` : 'Replaced: nothing');
  const flags = new Map<string, number>();
  for (const e of r.review) if (!e.allowed) flags.set(e.rule, (flags.get(e.rule) ?? 0) + 1);
  const allowed = r.review.filter((e) => e.allowed).length;
  if (r.manifest.flags > 0) {
    lines.push(`Flagged for review: ${r.manifest.flags} (${[...flags.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}), each [flagged-N] in the export.`);
  } else lines.push('Flagged for review: nothing');
  if (allowed > 0) lines.push(`Put back by --allow / --allow-rule: ${allowed}`);
  if (r.reviewFile) lines.push(`Review file (never inside the export): ${r.reviewFile}`, '  --allow flagged-3,flagged-7 or --allow-rule <rule> on a rerun puts values back.');
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.join('\n') + '\n';
}
