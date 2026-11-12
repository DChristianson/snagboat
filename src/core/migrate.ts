import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { EventLog } from './eventLog';
import { userDataDir, WorkspaceInfo, workspaceStoreDir } from './userStore';

/**
 * The copy-only migration from VS Code's per-window storage to the per-user
 * store (docs/design/handoff-3c.md, step 3c-1).
 *
 * It copies and never moves or deletes: the VS Code stores are left exactly as
 * they were, so turning snagboat.storage.perUserStore off goes back to them.
 * Events gain `workspace` and are deduplicated on eventId, so copying the same
 * store twice, or two stores of the same workspace (VS Code and Cursor), never
 * duplicates an event. A marker per source store records what was copied; a
 * rerun with the source unchanged is a no-op, and one after the source has grown
 * copies only what's new.
 */

export interface MigrationSource {
  /** The VS Code storage folder (the one holding events/). */
  dir: string;
  /** For people: which app and folder it is. */
  label: string;
  info: WorkspaceInfo;
}

export interface StoreReport {
  source: string;
  label: string;
  workspace: string;
  dest: string;
  /** up-to-date: the marker matches the source, so nothing was read. */
  status: 'copied' | 'would-copy' | 'up-to-date';
  days: number;
  /** Events in the source, each counted once. */
  events: number;
  /** Of those, the ones the per-user store doesn't have yet. */
  newEvents: number;
  aggregates: number;
  responses: number;
  checkpoints: number;
}

export interface GlobalReport {
  name: string;
  from: string;
  to: string;
  /** exists: the per-user store already has one (from an earlier run, or another app's copy). */
  status: 'copied' | 'would-copy' | 'exists';
}

export interface MigrationReport {
  stores: StoreReport[];
  globals: GlobalReport[];
}

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.endsWith('.tmp'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Names, sizes and modification times of everything migrated from a store: changes when the store does. */
function fingerprint(dir: string): string {
  const entries: string[] = [];
  for (const sub of ['events', 'aggregates', 'checkpoints']) {
    for (const name of listFiles(path.join(dir, sub))) {
      const st = fs.statSync(path.join(dir, sub, name));
      entries.push(`${sub}/${name} ${st.size} ${st.mtimeMs}`);
    }
  }
  try {
    const st = fs.statSync(path.join(dir, 'finding-responses.jsonl'));
    entries.push(`finding-responses.jsonl ${st.size} ${st.mtimeMs}`);
  } catch {
    // none
  }
  return sha(entries.join('\n'));
}

export function markerFile(home: string, sourceDir: string): string {
  return path.join(userDataDir(home), 'migrated', `${sha(sourceDir).slice(0, 16)}.json`);
}

interface Marker {
  source: string;
  workspace: string;
  fingerprint: string;
  migratedAt: string;
}

function readMarker(file: string): Marker | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Marker;
  } catch {
    return undefined;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, text, 'utf8');
  await fs.promises.rename(temp, file);
}

/** Copies a file unless the destination exists; returns whether it did (or would). */
async function copyIfMissing(from: string, to: string, dryRun: boolean): Promise<boolean> {
  if (fs.existsSync(to)) return false;
  if (dryRun) return true;
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  return true;
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

/**
 * Event ids already copied, or (in a dry run) counted as to be copied, per
 * destination day file during one migrate() call, so a dry run counts an event
 * two stores share once, as the real run copies it.
 */
type Planned = Map<string, Set<string>>;

async function migrateStore(source: MigrationSource, home: string, dryRun: boolean, planned: Planned): Promise<StoreReport> {
  const dest = workspaceStoreDir(home, source.info.workspace);
  const report: StoreReport = {
    source: source.dir,
    label: source.label,
    workspace: source.info.workspace,
    dest,
    status: dryRun ? 'would-copy' : 'copied',
    days: 0,
    events: 0,
    newEvents: 0,
    aggregates: 0,
    responses: 0,
    checkpoints: 0,
  };
  const markerPath = markerFile(home, source.dir);
  const print = fingerprint(source.dir);
  if (readMarker(markerPath)?.fingerprint === print) return { ...report, status: 'up-to-date' };

  if (!dryRun) {
    await fs.promises.mkdir(dest, { recursive: true });
    const infoFile = path.join(dest, 'workspace.json');
    if (!fs.existsSync(infoFile)) await writeAtomic(infoFile, JSON.stringify(source.info, null, 2) + '\n');
  }

  // Events, day by day, appended after what the per-user store already has.
  const from = new EventLog(source.dir);
  const to = new EventLog(dest);
  for (const day of await from.listDays()) {
    const events = await from.readDay(day);
    if (events.length === 0) continue;
    report.days += 1;
    report.events += events.length;
    const dayFile = path.join(to.dir, `${day}.jsonl`);
    let have = planned.get(dayFile);
    if (!have) {
      have = new Set((await to.readDay(day)).map((e) => e.eventId));
      planned.set(dayFile, have);
    }
    const fresh: NormalizedEvent[] = events.filter((e) => !have!.has(e.eventId)).map((e) => (e.workspace ? e : { ...e, workspace: source.info.workspace }));
    for (const e of fresh) have.add(e.eventId);
    report.newEvents += fresh.length;
    if (!dryRun && fresh.length > 0) {
      await fs.promises.mkdir(to.dir, { recursive: true });
      await fs.promises.appendFile(dayFile, fresh.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
    }
  }

  // Daily aggregates (days already rolled up), checkpoints: copied where the per-user store has none.
  for (const name of listFiles(path.join(source.dir, 'aggregates'))) {
    if (await copyIfMissing(path.join(source.dir, 'aggregates', name), path.join(dest, 'aggregates', name), dryRun)) report.aggregates += 1;
  }
  // Read positions in the agents' logs, so a window using the per-user store
  // resumes where the old one stopped instead of re-reading every transcript.
  for (const name of listFiles(path.join(source.dir, 'checkpoints'))) {
    if (await copyIfMissing(path.join(source.dir, 'checkpoints', name), path.join(dest, 'checkpoints', name), dryRun)) report.checkpoints += 1;
  }

  // Finding responses: lines the per-user store doesn't have.
  const responsesFile = path.join(dest, 'finding-responses.jsonl');
  const haveLines = new Set(readLines(responsesFile));
  const freshLines = readLines(path.join(source.dir, 'finding-responses.jsonl')).filter((l) => !haveLines.has(l));
  report.responses = freshLines.length;
  if (!dryRun && freshLines.length > 0) await fs.promises.appendFile(responsesFile, freshLines.map((l) => l + '\n').join(''), 'utf8');

  if (!dryRun) {
    const marker: Marker = { source: source.dir, workspace: source.info.workspace, fingerprint: print, migratedAt: new Date().toISOString() };
    await writeAtomic(markerPath, JSON.stringify(marker, null, 2) + '\n');
  }
  return report;
}

/** Where each file from VS Code's global storage goes in the per-user store. */
function globalDestinations(home: string): Array<{ name: string; to: string }> {
  const data = userDataDir(home);
  return [
    { name: 'rules.json', to: path.join(home, 'rules.json') },
    { name: 'context-limits.json', to: path.join(data, 'context-limits.json') },
    { name: 'advisor-audit.jsonl', to: path.join(data, 'advisor-audit.jsonl') },
  ];
}

async function migrateGlobals(globalDirs: string[], home: string, dryRun: boolean): Promise<GlobalReport[]> {
  const reports: GlobalReport[] = [];
  // The first app's copy wins (globalDirs come in a fixed order, VS Code first); later ones are reported as exists.
  for (const dir of globalDirs) {
    for (const { name, to } of globalDestinations(home)) {
      const from = path.join(dir, name);
      if (!fs.existsSync(from)) continue;
      const copied = await copyIfMissing(from, to, dryRun);
      reports.push({ name, from, to, status: copied ? (dryRun ? 'would-copy' : 'copied') : 'exists' });
    }
    const structure = path.join(dir, 'copilot-structure');
    for (const name of listFiles(structure)) {
      const to = path.join(userDataDir(home), 'copilot-structure', name);
      const copied = await copyIfMissing(path.join(structure, name), to, dryRun);
      reports.push({ name: `copilot-structure/${name}`, from: path.join(structure, name), to, status: copied ? (dryRun ? 'would-copy' : 'copied') : 'exists' });
    }
  }
  return reports;
}

/**
 * Copies each VS Code store into its workspace's folder in the per-user store,
 * and the files in VS Code's global storage (globalDirs) into the per-user
 * store's shared files. With dryRun, reads and counts but writes nothing.
 */
export async function migrate(sources: MigrationSource[], globalDirs: string[], home: string, opts: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? false;
  const stores: StoreReport[] = [];
  const planned: Planned = new Map();
  for (const source of sources) stores.push(await migrateStore(source, home, dryRun, planned));
  const globals = await migrateGlobals(globalDirs, home, dryRun);
  return { stores, globals };
}
