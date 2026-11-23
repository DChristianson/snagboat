import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PlanItemRecord, PlanRecord, storeRecordKey, TransitionRecord } from '@snagboat/schema';
import { BeadsEvent, BeadsIssue, parseBeadsHistory, parseBeadsIssues, readBeadsExport } from '../beadsExport';
import { effectiveSettings } from '../config';
import { locateRepo, RepoLocation } from '../gitRecords';
import {
  beadsItem,
  beadsTransition,
  LineOrigin,
  MarkdownItem,
  markdownRecord,
  markdownTransition,
  parseBlame,
  parseMarkdownPlan,
} from '../planRecords';
import { oldestKeptDay, oldestTextDay } from '../retention';
import { foldStoreFile, storeRecordTime } from '../storeRecordFiles';
import { listUserStores, UserStore } from '../userStore';
import { GitRunner, runGit } from '../../outcomes/gitOutcomes';
import { ACTIVE_MS } from './gitRecordsJob';
import { retentionPolicyFor, StoreWriter } from './storeWriter';

/**
 * The plan job (docs/design/export.md, "Plan: plan/items.jsonl, plan/transitions.jsonl" and "The
 * store records it"): for each workspace in the per-user store, with `collect` and `outcomes.git`
 * not turned off, it appends to the workspace's plan.jsonl its plan items as they change and each
 * transition once (planRecords.ts maps them).
 *
 * Where the plan comes from, first that applies:
 * 1. bd on PATH and a `.beads` folder: `bd --readonly export`, and `bd --readonly history <id>
 *    --events --json` for the beads whose updated_at differs from what's stored (a bead whose
 *    history fails isn't stored this run, so the next run asks again).
 * 2. A dev container's export (beadsExport.ts, `<folder>/.snagboat/beads/`, or the main working
 *    tree's for another worktree), fresh or stale: it's what bd knew when it last ran. Staleness
 *    is logged when it changes.
 * 3. A `.beads` folder with neither: nothing, logged once. Beads win, so markdown isn't inferred
 *    for a project that keeps its plan in beads.
 * 4. Markdown: the files git tracks at HEAD under docs/, or under the project's `plans` setting
 *    (paths relative to the project folder), not README, CONTRIBUTING or CHANGELOG unless named.
 *    Items inferred (parseMarkdownPlan), timed and attributed by `git blame HEAD` of their lines.
 *    A status that differs from what's stored becomes a transition at the commit that changed
 *    the line, by its author. An item gone from its file that wasn't done becomes dropped, at the
 *    file's last commit. A file is blamed again only when its blob changes.
 *
 * Cadence, like the repository job: ticked every few minutes (PLAN_RECORDS_TICK_MS), a
 * repository is read when one of its workspaces had events in the last ACTIVE_MS, or an hour has
 * passed. One run at a time. Worktrees of a repository share one read of its beads; markdown is
 * each working tree's own HEAD.
 *
 * Retention: records follow the store's retention.rawDays by storeRecordTime (an item's closing,
 * a transition's time), and nothing older is appended. Item text (description, design, notes,
 * acceptance) is stored only while the project captures content, and only for items updated
 * within retention.textDays, which storeWriter's retention also strips from older lines.
 */

export const PLAN_RECORDS_TICK_MS = 5 * 60_000;
export const PLAN_RECORDS_IDLE_MS = 60 * 60_000;
export const PLAN_RECORDS_FILE = 'plan.jsonl';

/** Runs bd (an absolute path) read-only; rejects on failure. */
export type BdRunner = (bd: string, args: string[], cwd: string) => Promise<string>;

export const runBd: BdRunner = (bd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(bd, args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' }, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** An executable named `name` on PATH, or undefined. */
export function findOnPath(name: string, searchPath = process.env.PATH ?? ''): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** Where a workspace's plan came from on its last run. */
export interface PlanSource {
  source: 'bd' | 'export' | 'markdown' | 'none';
  /** export: the exporter ran recently. */
  fresh?: boolean;
  /** export: when it last ran. */
  lastRun?: string;
  detail?: string;
}

export interface PlanRecordsJobOptions {
  log?: (line: string) => void;
  git?: GitRunner;
  clock?: () => number;
  /** bd's path; null: none. Default: looked up on PATH each run. */
  bd?: string | null;
  runBd?: BdRunner;
}

interface Member {
  store: UserStore;
  folder: string;
  loc?: RepoLocation;
  file: string;
  /** The oldest record time this store keeps (rawDays). */
  cutoff: string;
  /** Items updated before this keep no text (textDays). */
  textCutoff: string;
  /** The project captures content. */
  text: boolean;
  plans?: string[];
}

interface Beads {
  issues: BeadsIssue[];
  /** Each bead's events, for the beads read this run. */
  events: Map<string, BeadsEvent[]>;
  /** Beads whose history couldn't be read: their items wait for the next run. */
  failed: Set<string>;
  source: PlanSource;
}

/** One markdown file as last read: its blob, items, and each item's line origin. */
interface MarkdownFile {
  blob: string;
  items: MarkdownItem[];
  origins: Map<string, LineOrigin>;
}

const DEFAULT_PLANS = ['docs'];
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const NOT_PLANS = /^(readme|contributing|changelog)(\.[a-z]+)?$/i;

export class PlanRecordsJob {
  private running?: Promise<number>;
  private readonly lastRun = new Map<string, number>();
  private readonly activity = new Map<string, number>();
  private readonly markdown = new Map<string, Map<string, MarkdownFile>>();
  private readonly sources = new Map<string, PlanSource>();
  private readonly said = new Map<string, string>();
  private readonly stopListening: () => void;
  private readonly log: (line: string) => void;
  private readonly git: GitRunner;
  private readonly clock: () => number;
  private readonly runBd: BdRunner;

  constructor(
    private readonly home: string,
    private readonly writer: StoreWriter,
    private readonly opts: PlanRecordsJobOptions = {}
  ) {
    this.log = opts.log ?? (() => undefined);
    this.git = opts.git ?? runGit;
    this.clock = opts.clock ?? Date.now;
    this.runBd = opts.runBd ?? runBd;
    this.stopListening = writer.onWritten((workspace) => this.activity.set(workspace, this.clock()));
  }

  dispose(): void {
    this.stopListening();
  }

  /** Where each workspace's plan came from on its last run. */
  sourceOf(workspace: string): PlanSource | undefined {
    return this.sources.get(workspace);
  }

  /** Reads the projects due now (or every one, with `force`) and appends what changed; how many records. A run already going is joined. */
  run(opts: { force?: boolean } = {}): Promise<number> {
    this.running ??= this.runNow(opts.force ?? false).finally(() => (this.running = undefined));
    return this.running;
  }

  private async runNow(force: boolean): Promise<number> {
    const now = this.clock();
    const today = new Date(now).toISOString().slice(0, 10);
    const groups = new Map<string, Member[]>();
    for (const store of listUserStores(this.home)) {
      if (!store.folder || !fs.existsSync(store.folder)) continue;
      const settings = effectiveSettings(this.home, store.folder).values;
      if (settings['outcomes.git'] === false || settings.collect === false) continue;
      const loc = await locateRepo(store.folder, this.git);
      const policy = retentionPolicyFor(this.home, store.workspace);
      const rawDays = Math.max(1, Math.floor(policy.rawDays));
      const plans = plansSetting(settings.plans);
      const member: Member = {
        store,
        folder: store.folder,
        loc,
        file: path.join(store.dir, PLAN_RECORDS_FILE),
        cutoff: `${oldestKeptDay(today, rawDays)}T00:00:00.000Z`,
        textCutoff: `${oldestTextDay(today, policy)}T00:00:00.000Z`,
        text: settings.captureContent !== false,
        ...(plans ? { plans } : {}),
      };
      const key = loc?.commonDir ?? store.folder;
      groups.set(key, [...(groups.get(key) ?? []), member]);
    }
    let total = 0;
    for (const [key, members] of groups) {
      const last = this.lastRun.get(key);
      const active = members.some((m) => now - (this.activity.get(m.store.workspace) ?? -Infinity) < ACTIVE_MS);
      if (!force && last !== undefined && now - last < PLAN_RECORDS_IDLE_MS && !active) continue;
      this.lastRun.set(key, now);
      try {
        total += await this.record(members, now);
      } catch (err) {
        this.log(`plan records for ${members[0].folder}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (total > 0) this.log(`recorded ${total} plan record(s)`);
    return total;
  }

  /** Says a line once per workspace and topic, again only when it changes. */
  private sayOnce(topic: string, line: string): void {
    if (this.said.get(topic) === line) return;
    this.said.set(topic, line);
    this.log(line);
  }

  private async record(members: Member[], now: number): Promise<number> {
    const folds = members.map((m) => foldStoreFile<PlanRecord>(m.file));
    const withBeads = members.filter((m) => fs.existsSync(path.join(m.folder, '.beads')));
    const beads = await this.readBeads(members, withBeads, folds, now);
    let total = 0;
    if (beads) {
      for (const [i, m] of members.entries()) {
        this.sources.set(m.store.workspace, beads.source);
        total += await this.appendBeads(m, folds[i], beads, now);
      }
      return total;
    }
    if (withBeads.length > 0) {
      for (const m of members) this.sources.set(m.store.workspace, { source: 'none', detail: 'beads, but no bd and no .snagboat/beads export' });
      this.sayOnce(`none:${members[0].folder}`, `plan for ${members[0].folder}: it has .beads, but bd isn't installed here and there's no .snagboat/beads export from a dev container, so nothing is recorded`);
      return 0;
    }
    for (const [i, m] of members.entries()) {
      if (!m.loc) {
        this.sources.set(m.store.workspace, { source: 'none', detail: 'not a git repository' });
        continue;
      }
      this.sources.set(m.store.workspace, { source: 'markdown' });
      try {
        total += await this.appendMarkdown(m, folds[i]);
      } catch (err) {
        this.log(`plan from markdown in ${m.folder}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return total;
  }

  // ---- beads ----------------------------------------------------------------------------------

  private async readBeads(members: Member[], withBeads: Member[], folds: Array<Map<string, PlanRecord>>, now: number): Promise<Beads | undefined> {
    const bd = this.opts.bd === undefined ? findOnPath('bd') : (this.opts.bd ?? undefined);
    if (bd && withBeads.length > 0) {
      const folder = withBeads[0].folder;
      try {
        return await this.readHostBd(bd, folder, members, folds, now);
      } catch (err) {
        this.sayOnce(`bd:${folder}`, `plan for ${folder}: bd export failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); trying .snagboat/beads`);
      }
    }
    const candidates = [...new Set([...members.map((m) => m.folder), ...members.flatMap((m) => (m.loc && path.basename(m.loc.commonDir) === '.git' ? [path.dirname(m.loc.commonDir)] : []))])];
    for (const folder of candidates) {
      const exported = readBeadsExport(folder, { now: new Date(now) });
      if (!exported || exported.issues.length === 0) {
        if (exported?.problems.length) this.sayOnce(`export-problems:${folder}`, `plan for ${folder}: ${exported.problems.join('; ')}`);
        continue;
      }
      const lastRun = exported.lastRun?.toISOString();
      const ago = exported.lastRun ? Math.round((now - exported.lastRun.getTime()) / 60_000) : undefined;
      this.sayOnce(
        `export:${folder}`,
        exported.fresh
          ? `plan for ${folder}: from the dev container's beads export (${exported.issues.length} beads)`
          : `plan for ${folder}: the dev container's beads export is stale (last ran ${ago ?? '?'} minute(s) ago); recording what it has`
      );
      if (exported.problems.length) this.sayOnce(`export-problems:${folder}`, `plan for ${folder}: ${exported.problems.join('; ')}`);
      return {
        issues: exported.issues,
        events: exported.events,
        // An export's missing history is the exporter not there yet: the item is stored, its transitions come later.
        failed: new Set(),
        source: { source: 'export', fresh: exported.fresh, ...(lastRun ? { lastRun } : {}), detail: exported.dir },
      };
    }
    return undefined;
  }

  private async readHostBd(bd: string, folder: string, members: Member[], folds: Array<Map<string, PlanRecord>>, now: number): Promise<Beads> {
    const { issues, bad } = parseBeadsIssues(await this.runBd(bd, ['--readonly', 'export'], folder));
    if (bad) this.sayOnce(`bd-bad:${folder}`, `plan for ${folder}: skipped ${bad} line(s) of bd export that aren't issues`);
    const nowIso = new Date(now).toISOString();
    const oldest = members.map((m) => m.cutoff).sort()[0];
    const events = new Map<string, BeadsEvent[]>();
    const failed = new Set<string>();
    for (const issue of issues) {
      const item = beadsItem(issue, { text: false, now: nowIso });
      if (item.closed !== undefined && item.closed < oldest) continue;
      const changed = folds.some((fold) => {
        const have = fold.get(storeRecordKey(item));
        return !have || have.record !== 'item' || have.updated !== item.updated;
      });
      if (!changed) continue;
      try {
        const parsed = parseBeadsHistory(JSON.parse(await this.runBd(bd, ['--readonly', 'history', issue.id, '--events', '--json'], folder)), issue.id);
        if (!parsed) throw new Error("its history isn't a list of events");
        events.set(issue.id, parsed.events);
      } catch (err) {
        failed.add(issue.id);
        this.log(`plan for ${folder}: bd history ${issue.id} failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); trying again next run`);
      }
    }
    this.said.delete(`bd:${folder}`);
    return { issues, events, failed, source: { source: 'bd', detail: bd } };
  }

  private async appendBeads(m: Member, fold: Map<string, PlanRecord>, beads: Beads, now: number): Promise<number> {
    const nowIso = new Date(now).toISOString();
    const items: PlanItemRecord[] = [];
    const transitions: TransitionRecord[] = [];
    const present = new Set<string>();
    for (const issue of beads.issues) {
      present.add(issue.id);
      if (beads.failed.has(issue.id)) continue;
      const draft = beadsItem(issue, { text: m.text, now: nowIso });
      items.push(draft.text && draft.updated < m.textCutoff ? withoutText(draft) : draft);
      for (const e of beads.events.get(issue.id) ?? []) {
        const t = beadsTransition(e);
        if (t) transitions.push(t);
      }
    }
    // A bead deleted from bd: its item is kept, as dropped.
    if (beads.issues.length > 0) {
      for (const r of fold.values()) {
        if (r.record !== 'item' || r.source !== 'beads' || present.has(r.id) || r.status === 'dropped') continue;
        items.push({ ...r, status: 'dropped', updated: nowIso });
      }
    }
    transitions.sort((a, b) => a.at.localeCompare(b.at));
    return this.appendChanged(m, fold, [...items, ...transitions]);
  }

  /** Appends what isn't stored as it is, nothing older than the store keeps. */
  private async appendChanged(m: Member, fold: Map<string, PlanRecord>, wanted: PlanRecord[]): Promise<number> {
    const append = wanted.filter((r) => {
      const at = storeRecordTime(r);
      if (at !== undefined && at < m.cutoff) return false;
      const have = fold.get(storeRecordKey(r));
      return !have || JSON.stringify(have) !== JSON.stringify(r);
    });
    if (append.length === 0) return 0;
    await this.writer.appendRecords(m.file, append);
    for (const r of append) fold.set(storeRecordKey(r), r);
    return append.length;
  }

  // ---- markdown -------------------------------------------------------------------------------

  /** The planning markdown git tracks at HEAD, relative to the folder, with each file's blob. */
  private async planFiles(m: Member): Promise<Map<string, string>> {
    const specs = m.plans ?? DEFAULT_PLANS;
    const named = new Set(specs.map((s) => path.posix.normalize(s.split(path.sep).join('/')).replace(/^\.\//, '')));
    let out: string;
    try {
      out = await this.git(['ls-tree', '-r', '-z', 'HEAD', '--', ...specs], m.folder);
    } catch {
      return new Map(); // no commits yet
    }
    const files = new Map<string, string>();
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, type, blob] = entry.slice(0, tab).split(' ');
      const file = entry.slice(tab + 1);
      if (type !== 'blob' || !MARKDOWN.test(file)) continue;
      if (NOT_PLANS.test(path.posix.basename(file)) && !named.has(file)) continue;
      files.set(file, blob);
    }
    return files;
  }

  private async readMarkdownFile(m: Member, file: string, blob: string): Promise<MarkdownFile> {
    const text = await this.git(['cat-file', 'blob', blob], m.folder);
    const items = parseMarkdownPlan(file, text);
    const origins = new Map<string, LineOrigin>();
    if (items.length === 0) return { blob, items, origins };
    const lines = parseBlame(await this.git(['blame', '--porcelain', 'HEAD', '--', file], m.folder));
    const byId = new Map(items.map((it) => [it.id, it]));
    const children = new Map<string, MarkdownItem[]>();
    for (const it of items) if (it.parent && byId.has(it.parent)) children.set(it.parent, [...(children.get(it.parent) ?? []), it]);
    const originOf = (it: MarkdownItem): LineOrigin | undefined => {
      const known = origins.get(it.id);
      if (known) return known;
      let best = lines.get(it.line);
      // A heading worked out from its items changed when the latest of them did.
      if (it.shape === 'heading') for (const kid of children.get(it.id) ?? []) {
        const o = originOf(kid);
        if (o && (!best || o.at > best.at)) best = o;
      }
      if (best) origins.set(it.id, best);
      return best;
    };
    for (const it of items) originOf(it);
    return { blob, items, origins };
  }

  private async appendMarkdown(m: Member, fold: Map<string, PlanRecord>): Promise<number> {
    const files = await this.planFiles(m);
    let cache = this.markdown.get(m.store.workspace);
    if (!cache) this.markdown.set(m.store.workspace, (cache = new Map()));
    for (const file of [...cache.keys()]) if (!files.has(file)) cache.delete(file);

    const storedFiles = new Set<string>();
    for (const r of fold.values()) if (r.record === 'item' && r.source === 'markdown' && r.from) storedFiles.add(r.from.file);

    const items: PlanItemRecord[] = [];
    const transitions: TransitionRecord[] = [];
    const present = new Set<string>();
    for (const [file, blob] of files) {
      let read = cache.get(file);
      if (!read || read.blob !== blob) cache.set(file, (read = await this.readMarkdownFile(m, file, blob)));
      for (const it of read.items) {
        const origin = read.origins.get(it.id);
        if (!origin) continue;
        present.add(it.id);
        const have = fold.get(`item:${it.id}`);
        const stored = have?.record === 'item' ? have : undefined;
        items.push(markdownRecord(file, it, origin, stored));
        if (stored && stored.status !== it.status) transitions.push(markdownTransition(it.id, stored.status, it.status, origin));
        else if (!stored && storedFiles.has(file)) transitions.push(markdownTransition(it.id, undefined, it.status, origin));
      }
    }

    // Items gone from their file that weren't finished: dropped, at the file's last commit.
    const lastCommit = new Map<string, LineOrigin | undefined>();
    for (const r of fold.values()) {
      if (r.record !== 'item' || r.source !== 'markdown' || !r.from || present.has(r.id)) continue;
      if (r.status === 'done' || r.status === 'dropped') continue;
      if (!files.has(r.from.file) && (await this.existsAtHead(m, r.from.file))) continue; // out of scope now, not gone
      if (!lastCommit.has(r.from.file)) lastCommit.set(r.from.file, await this.lastCommitOf(m, r.from.file));
      const origin = lastCommit.get(r.from.file);
      if (!origin) continue;
      items.push({ ...r, status: 'dropped', updated: origin.at, closed: origin.at });
      transitions.push(markdownTransition(r.id, r.status, 'dropped', origin));
    }
    transitions.sort((a, b) => a.at.localeCompare(b.at));
    return this.appendChanged(m, fold, [...items, ...transitions]);
  }

  private async existsAtHead(m: Member, file: string): Promise<boolean> {
    try {
      await this.git(['cat-file', '-e', `HEAD:./${file}`], m.folder);
      return true;
    } catch {
      return false;
    }
  }

  private async lastCommitOf(m: Member, file: string): Promise<LineOrigin | undefined> {
    try {
      const out = (await this.git(['log', '-1', '--format=%ct%x1f%an <%ae>', 'HEAD', '--', file], m.folder)).trim();
      const [ct, author] = out.split('\x1f');
      if (!ct) return undefined;
      return { at: new Date(Number(ct) * 1000).toISOString(), author: author ?? '' };
    } catch {
      return undefined;
    }
  }
}

function withoutText(item: PlanItemRecord): PlanItemRecord {
  const { text: _text, ...rest } = item;
  return rest;
}

/** The `plans` setting: a path or a list of paths relative to the project folder; undefined when it isn't set or has none. */
export function plansSetting(value: unknown): string[] | undefined {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const paths = list.filter((p): p is string => typeof p === 'string' && p.trim() !== '' && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'));
  return paths.length ? paths : undefined;
}
