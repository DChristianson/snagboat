import * as fs from 'fs';
import * as path from 'path';
import { Host, HostDisposable } from './host';

/**
 * Snagboat's settings outside VS Code (docs/design/handoff-3c.md, 3c-3a), for
 * the core and the CLI. Keys are VS Code's setting names without the
 * `snagboat.` prefix (`captureContent`, `retention.textDays`,
 * `heuristics.stalled.minutes`), so the engine reads them through the same
 * Host interface it uses in VS Code.
 *
 * Layers, lowest first:
 *   1. built-in defaults (the fallback each reader passes)
 *   2. ~/.snagboat/config.json "defaults": your choices for every project
 *   3. ~/.snagboat/config.json "projects"[<folder>]: one project's, the
 *      nearest folder containing the project
 *   4. <project>/.snagboat.json "settings": committed with the project and
 *      shared with whoever clones it, so it may set only team settings
 *      (thresholds, rules, shell categories), and privacy settings only to be
 *      more private: capture off, shorter retention, not collected
 * VS Code windows write their user and workspace settings into layers 2 and 3
 * (vscode/configSync.ts), so VS Code's settings stay the place to edit them.
 */

export interface SnagboatConfig {
  version: 1;
  defaults: Record<string, unknown>;
  projects: Record<string, Record<string, unknown>>;
}

export const CONFIG_FILE = 'config.json';
export const PROJECT_FILE = '.snagboat.json';

/**
 * Settings that decide what is recorded and kept, with their built-in values.
 * A project file may only move them toward more private (`tighter`).
 * package.json declares the same defaults; config.unit.test.ts checks they match.
 */
export const PRIVACY_DEFAULTS = {
  captureContent: true,
  'retention.rawDays': 90,
  'retention.textDays': 30,
  'retention.aggregateDays': -1,
  'copilot.captureStructure': false,
  'claudeCode.configureHooks': true,
  /** Record this project at all (config and project files only; not a VS Code setting). */
  collect: true,
  /** Read the project's git history (read-only) for commit outcomes (RFC step 4b). */
  'outcomes.git': true,
} as const;

/** Whether `value` is at least as private as `than` for a privacy key. */
function tighter(key: keyof typeof PRIVACY_DEFAULTS, value: unknown, than: unknown): boolean {
  if (typeof PRIVACY_DEFAULTS[key] === 'boolean') {
    if (typeof value !== 'boolean') return false;
    // captureStructure records more when on; the others record (or touch the project) more when on.
    return value === false || value === than;
  }
  if (typeof value !== 'number' || typeof than !== 'number') return false;
  // aggregateDays: -1 keeps forever, so anything is as short or shorter; nothing is longer than -1.
  const days = (n: number) => (n < 0 ? Infinity : n);
  return days(value) <= days(than);
}

/** Team settings a project file may set freely: they change what's flagged, not what's recorded or sent. */
const TEAM_PREFIXES = ['heuristics.', 'tokenBudget.', 'discovery.', 'nudges.'];
const TEAM_KEYS = new Set(['rules', 'toolCategories']);

function isTeamKey(key: string): boolean {
  return TEAM_KEYS.has(key) || TEAM_PREFIXES.some((p) => key.startsWith(p));
}

function isPrivacyKey(key: string): key is keyof typeof PRIVACY_DEFAULTS {
  return Object.prototype.hasOwnProperty.call(PRIVACY_DEFAULTS, key);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function configPath(home: string): string {
  return path.join(home, CONFIG_FILE);
}

/** Reads ~/.snagboat/config.json; a missing file is an empty config, an unreadable one an empty config plus a problem. */
export function loadConfig(home: string): { config: SnagboatConfig; problems: string[] } {
  const empty: SnagboatConfig = { version: 1, defaults: {}, projects: {} };
  let text: string;
  try {
    text = fs.readFileSync(configPath(home), 'utf8');
  } catch {
    return { config: empty, problems: [] };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const projects: Record<string, Record<string, unknown>> = {};
    if (isObject(raw.projects)) for (const [folder, settings] of Object.entries(raw.projects)) if (isObject(settings)) projects[folder] = settings;
    return { config: { version: 1, defaults: isObject(raw.defaults) ? raw.defaults : {}, projects }, problems: [] };
  } catch (err) {
    return { config: empty, problems: [`${configPath(home)} isn't valid JSON, so it's ignored: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** Writes config.json atomically, owner-only. */
export function saveConfig(home: string, config: SnagboatConfig): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = configPath(home);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function isInside(dir: string, folder: string): boolean {
  const rel = path.relative(folder, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The config.json project entry for dir: the nearest folder containing it. */
function projectEntry(config: SnagboatConfig, dir: string): { folder: string; settings: Record<string, unknown> } | undefined {
  const folder = Object.keys(config.projects)
    .filter((f) => isInside(dir, f))
    .sort((a, b) => b.length - a.length)[0];
  return folder === undefined ? undefined : { folder, settings: config.projects[folder] };
}

/** The nearest .snagboat.json at or above dir, stopping at the repository root (a folder with .git) or at `stopAt`. */
export function findProjectFile(dir: string, stopAt?: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const candidate = path.join(current, PROJECT_FILE);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, '.git')) || (stopAt !== undefined && path.resolve(stopAt) === current)) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export type SettingSource = 'user' | 'project' | 'repository';

export interface EffectiveSettings {
  /** Settings that differ from the built-in defaults, by key. */
  values: Record<string, unknown>;
  sources: Record<string, SettingSource>;
  /** Where each layer came from, for people. */
  files: { config: string; projectFolder?: string; projectFile?: string };
  /** Settings ignored, and why. */
  problems: string[];
}

/** The settings that apply to a project folder (or any folder inside it). */
export function effectiveSettings(home: string, dir: string): EffectiveSettings {
  const { config, problems } = loadConfig(home);
  const values: Record<string, unknown> = {};
  const sources: Record<string, SettingSource> = {};
  for (const [key, value] of Object.entries(config.defaults)) {
    values[key] = value;
    sources[key] = 'user';
  }
  const entry = projectEntry(config, dir);
  for (const [key, value] of Object.entries(entry?.settings ?? {})) {
    values[key] = value;
    sources[key] = 'project';
  }
  const file = findProjectFile(dir, entry?.folder);
  if (file) {
    let settings: unknown;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      settings = raw.settings;
      if (!isObject(settings)) throw new Error('it has no "settings" object');
    } catch (err) {
      problems.push(`${file} is ignored: ${err instanceof Error ? err.message : String(err)}`);
      settings = {};
    }
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (isPrivacyKey(key)) {
        const inherited = key in values ? values[key] : PRIVACY_DEFAULTS[key];
        if (!tighter(key, value, inherited)) {
          problems.push(`${file}: ${key} is ignored; a project file can only make it more private than ${JSON.stringify(inherited)}`);
          continue;
        }
      } else if (!isTeamKey(key)) {
        problems.push(`${file}: ${key} is ignored; a project file can set only heuristics, budgets, rules, shell categories, discovery and nudges, and privacy settings toward more private`);
        continue;
      }
      values[key] = value;
      sources[key] = 'repository';
    }
  }
  return { values, sources, files: { config: configPath(home), projectFolder: entry?.folder, projectFile: file }, problems };
}

/**
 * A Host for the engine outside VS Code, answering from effectiveSettings for
 * one project. `scope` (a folder) picks another project's settings, as VS
 * Code's resource scope does. No workspace folders: the core decides which
 * project an event belongs to by itself.
 */
export function configHost(home: string, projectDir: string): Host {
  const settingsFor = (scope?: string) => effectiveSettings(home, scope ?? projectDir).values;
  const noop: HostDisposable = { dispose: () => undefined };
  const strip = (section: string) => (section === 'snagboat' ? '' : section.startsWith('snagboat.') ? section.slice('snagboat.'.length) : undefined);
  return {
    section: (section) => {
      const prefix = strip(section);
      if (prefix === undefined) return {};
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(settingsFor())) {
        if (prefix === '') out[key] = value;
        else if (key.startsWith(prefix + '.')) out[key.slice(prefix.length + 1)] = value;
      }
      return out;
    },
    get: <T>(section: string, key: string, fallback: T, scope?: string): T => {
      const prefix = strip(section);
      if (prefix === undefined) return fallback;
      const full = prefix === '' ? key : `${prefix}.${key}`;
      const values = settingsFor(scope);
      return (full in values ? values[full] : fallback) as T;
    },
    workspaceFolders: () => [],
    onWorkspaceFoldersChanged: () => noop,
    onSettingChanged: () => noop,
  };
}

/** A synced setting changed in config.json by something other than VS Code (the core's advisor UI, an edit). */
export interface ExternalChange {
  /** Your user settings, or a folder's. */
  scope: 'user' | { folder: string };
  key: string;
  /** Undefined: removed. */
  value: unknown;
}

/**
 * The synced settings that differ between what a VS Code window last wrote to config.json and
 * what's there now (RFC step 5c-2): changes made elsewhere, for the window to take into its own
 * settings, so its next sync doesn't undo them. Only its own folders' entries are compared.
 */
export function externalChanges(lastWritten: SnagboatConfig, now: SnagboatConfig, syncedKeys: string[], folders: string[]): ExternalChange[] {
  const keys = syncedKeys.filter(isSyncedSetting);
  const out: ExternalChange[] = [];
  const diff = (scope: ExternalChange['scope'], before: Record<string, unknown>, after: Record<string, unknown>) => {
    for (const key of keys) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out.push({ scope, key, value: after[key] });
  };
  diff('user', lastWritten.defaults, now.defaults);
  for (const folder of folders) diff({ folder }, lastWritten.projects[folder] ?? {}, now.projects[folder] ?? {});
  return out;
}

/**
 * Which VS Code settings windows copy into config.json: all of Snagboat's but
 * where its data lives (storage.*) and the advisor settings only VS Code uses
 * (headlines, the weekly review, model tiers, audit). Which advisors exist and
 * which one each ability uses are copied (RFC step 5c-2b), so the core can ask
 * the local ones; it reads them from your user settings only. API keys are
 * never settings: they stay in VS Code's secret storage.
 */
const SYNCED_ADVISOR_SETTINGS = new Set(['advisors', 'advisor.providers', 'advisor.defaults', 'advisor.explainProvider', 'advisor.proposeProvider', 'advisor.reviewProvider', 'advisor.nudgeProvider']);

export function isSyncedSetting(key: string): boolean {
  if (key.startsWith('storage.')) return false;
  if (key === 'advisors' || key.startsWith('advisor.')) return SYNCED_ADVISOR_SETTINGS.has(key);
  return true;
}

/**
 * config.json with one VS Code window's settings written in: `user` (set in
 * User settings) replaces the synced keys in "defaults", and each folder's
 * workspace settings replace the synced keys in its "projects" entry. Keys
 * VS Code doesn't have (added by hand, like `collect`) and other projects'
 * entries are kept. An entry left empty is removed.
 */
export function withVsCodeSettings(
  config: SnagboatConfig,
  syncedKeys: string[],
  user: Record<string, unknown>,
  projects: Record<string, Record<string, unknown>>
): SnagboatConfig {
  const synced = new Set(syncedKeys.filter(isSyncedSetting));
  const replace = (current: Record<string, unknown>, next: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) if (!synced.has(key)) out[key] = value;
    for (const [key, value] of Object.entries(next)) if (synced.has(key)) out[key] = value;
    return out;
  };
  const result: SnagboatConfig = { version: 1, defaults: replace(config.defaults, user), projects: { ...config.projects } };
  for (const [folder, settings] of Object.entries(projects)) {
    const entry = replace(config.projects[folder] ?? {}, settings);
    if (Object.keys(entry).length > 0) result.projects[folder] = entry;
    else delete result.projects[folder];
  }
  return result;
}
