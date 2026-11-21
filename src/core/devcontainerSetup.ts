/**
 * Checks, and on request sets up, a project's dev container so the core on this machine reads the Claude Code sessions
 * run inside it (snagboat-05p). The container needs:
 *
 *   - the project mounted at the same path as on the host (workspaceMount/workspaceFolder), so paths in its transcripts
 *     name the same folder on both sides;
 *   - its ~/.claude/projects bind-mounted to <folder>/.snagboat/claude-projects, which `snagboat containers allow` lets
 *     the core read;
 *   - the project folder marked as a git safe.directory on start (its path in the container changes with the mount);
 *   - in a project with beads (a .beads folder), the beads exporter started on start (snagboat-93b.10.8): bd runs only in
 *     the container, so .snagboat/bin/beads-export.sh writes bd export and bd history to .snagboat/beads/ every minute,
 *     for the core here to read (beadsExport.ts). The script is written into the project (it's git-ignored with the rest
 *     of .snagboat/), and the start step does nothing where it's missing.
 *
 * devcontainer.json is usually committed and shared, so nothing here edits it unasked. By default the changes go in a
 * personal config, .devcontainer/snagboat/devcontainer.json: the shared one plus the changes, with paths relative to the
 * config rewritten, that git ignores in this clone only (.git/info/exclude). Dev Containers has no per-user override that
 * merges into a committed config, so it's a copy: its header records fingerprints of the shared config it was made from
 * and of what was generated, so a later run regenerates it when the shared one changes but never overwrites hand edits
 * (without force). inPlace edits the shared devcontainer.json instead, for a repository only you use. Edits go through
 * jsonc-parser, so comments survive.
 *
 * planDevcontainer only reads; applyDevcontainerPlan writes. Carrying earlier transcripts into the new mount (out of the
 * container's Docker volume) is scripts/devcontainerSetup.js's job, not this module's.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as jsonc from 'jsonc-parser';
import { BEADS_EXPORT_SCRIPT } from './beadsExportScript';

export const SAME_PATH_MOUNT = 'source=${localWorkspaceFolder},target=${localWorkspaceFolder},type=bind';
export const SAFE_DIRECTORY =
  'git config --global --get-all safe.directory 2>/dev/null | grep -qxF "${containerWorkspaceFolder}" || git config --global --add safe.directory "${containerWorkspaceFolder}"';
/** Where --edit writes the beads exporter in a project, relative to the folder. */
export const BEADS_EXPORT_REL = '.snagboat/bin/beads-export.sh';
/** The postStartCommand step that starts it in the background; a no-op where the script isn't there (a collaborator's clone). */
export const BEADS_EXPORT_START = '[ ! -f .snagboat/bin/beads-export.sh ] || sh .snagboat/bin/beads-export.sh start "${containerWorkspaceFolder}"';
export { BEADS_EXPORT_SCRIPT };
const HEADER_MARK = '// snagboat-personal-config';

export interface DevcontainerOptions {
  /** Edit the shared devcontainer.json rather than writing the personal config. */
  inPlace?: boolean;
  /** Replace a workspaceMount that isn't the same-path one, and a personal config edited by hand. */
  force?: boolean;
}

export interface DevcontainerPlan {
  folder: string;
  /** The shared config: .devcontainer/devcontainer.json or .devcontainer.json. */
  configPath: string;
  /** Where the changes go: the personal config, or configPath with inPlace. */
  outPath: string;
  inPlace: boolean;
  /**
   * ready: nothing to change. changes: applyDevcontainerPlan would write something. refused: it can't be done here
   * (problem says why, and what to do instead).
   */
  state: 'ready' | 'changes' | 'refused';
  problem?: string;
  /** One line per change, for people. */
  changes: string[];
  /** Things to know that aren't changes (a postStartCommand to edit by hand, files git already tracks). */
  notes: string[];
  /** The file the change is shown against, and its text (for a diff). */
  beforePath: string;
  before: string;
  /** outPath's text after the change; equal to before when nothing in it changes. */
  after: string;
  /** Whether outPath's text changes. */
  writesConfig: boolean;
  /** The personal config's name, to pick it out in VS Code's "which configuration" prompt (not with inPlace). */
  personalName?: string;
  transcriptsDir: string;
  /** transcriptsDir doesn't exist yet (Docker won't start with a missing bind source). */
  createsTranscriptsDir: boolean;
  /** The beads exporter's path in the project, when the folder has beads and its container should run it. */
  beadsExportPath?: string;
  /** beadsExportPath is missing or isn't this version's script. */
  writesBeadsExport: boolean;
  /** The file to add ignoreLines to: .gitignore with inPlace, else this clone's .git/info/exclude. */
  ignoreFile?: string;
  ignoreLines: string[];
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The folder's devcontainer.json, if it has one. */
export function findDevcontainerConfig(folder: string): string | undefined {
  return [path.join(folder, '.devcontainer', 'devcontainer.json'), path.join(folder, '.devcontainer.json')].find((p) => fs.existsSync(p));
}

export function personalConfigPath(folder: string): string {
  return path.join(folder, '.devcontainer', 'snagboat', 'devcontainer.json');
}

const fingerprint = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const posix = (p: string) => p.split(path.sep).join('/');

type Config = Record<string, unknown> & {
  name?: unknown;
  build?: { dockerfile?: unknown; context?: unknown };
  dockerFile?: unknown;
  context?: unknown;
  features?: Record<string, unknown>;
  workspaceMount?: unknown;
  workspaceFolder?: unknown;
  mounts?: unknown[];
  postStartCommand?: unknown;
  remoteUser?: unknown;
  containerUser?: unknown;
  containerEnv?: Record<string, unknown>;
  remoteEnv?: Record<string, unknown>;
  dockerComposeFile?: unknown;
};

/** Where Claude Code keeps transcripts in the container: $CLAUDE_CONFIG_DIR/projects, else the container user's ~/.claude/projects. */
export function containerProjectsTarget(config: Config): string {
  const user = (typeof config.remoteUser === 'string' && config.remoteUser) || (typeof config.containerUser === 'string' && config.containerUser) || 'root';
  const env = config.containerEnv?.CLAUDE_CONFIG_DIR ?? config.remoteEnv?.CLAUDE_CONFIG_DIR;
  const claudeDir = typeof env === 'string' && env ? env : user === 'root' ? '/root/.claude' : `/home/${user}/.claude`;
  return `${claudeDir.replace(/\/+$/, '')}/projects`;
}

/** What it would take to set up the folder's dev container for Snagboat; undefined when it has no devcontainer.json. */
export function planDevcontainer(folder: string, options: DevcontainerOptions = {}): DevcontainerPlan | undefined {
  const configPath = findDevcontainerConfig(folder);
  if (!configPath) return undefined;
  const inPlace = options.inPlace === true;
  const force = options.force === true;
  const outPath = inPlace ? configPath : personalConfigPath(folder);
  const transcriptsDir = path.join(folder, '.snagboat', 'claude-projects');
  const original = fs.readFileSync(configPath, 'utf8');
  const plan: DevcontainerPlan = {
    folder,
    configPath,
    outPath,
    inPlace,
    state: 'ready',
    changes: [],
    notes: [],
    beforePath: configPath,
    before: original,
    after: original,
    writesConfig: false,
    transcriptsDir,
    createsTranscriptsDir: false,
    writesBeadsExport: false,
    ignoreLines: [],
  };
  const refuse = (problem: string): DevcontainerPlan => ({ ...plan, state: 'refused', problem, changes: [], after: plan.before, writesConfig: false });
  const rel = (p: string) => posix(path.relative(folder, p));

  const errors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(original, errors, { allowTrailingComma: true });
  if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refuse(`${rel(configPath)} isn't valid JSON with comments`);
  const config = parsed as Config;
  if (config.dockerComposeFile) {
    return refuse(
      `${rel(configPath)} uses dockerComposeFile, so its mounts live in the compose file: edit that by hand. In the service's volumes:\n` +
        '  - <folder>:<folder>     (the same path as on the host; set workspaceFolder to <folder>)\n' +
        `  - <folder>/.snagboat/claude-projects:${containerProjectsTarget(config)}`
    );
  }

  const projectsTarget = containerProjectsTarget(config);
  const transcriptsMount = `source=\${localWorkspaceFolder}/.snagboat/claude-projects,target=${projectsTarget},type=bind`;
  const fmt: jsonc.ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } };
  let text = original;
  const set = (jsonPath: jsonc.JSONPath, value: unknown) => {
    text = jsonc.applyEdits(text, jsonc.modify(text, jsonPath, value, fmt));
  };
  // Changes the project needs (not the personal config's own bookkeeping): none means the shared config is already set up.
  const needed: string[] = [];

  // 1. Same-path workspace mount.
  if (config.workspaceMount !== SAME_PATH_MOUNT) {
    if (config.workspaceMount && !force) {
      return refuse(`workspaceMount in ${rel(configPath)} is\n  ${String(config.workspaceMount)}\nnot the same-path mount. Rerun with --force to replace it.`);
    }
    set(['workspaceMount'], SAME_PATH_MOUNT);
    needed.push('workspaceMount: the project at the same path as on the host');
  }
  if (config.workspaceFolder !== '${localWorkspaceFolder}') {
    set(['workspaceFolder'], '${localWorkspaceFolder}');
    needed.push(`workspaceFolder: \${localWorkspaceFolder}. The project moves in the container: it opens at ${folder}, not /workspaces/${path.basename(folder)}`);
  }

  // 2. Transcripts bind mount (string mounts; an object mount naming the same target counts too).
  const mounts = Array.isArray(config.mounts) ? config.mounts : [];
  const targetOf = (m: unknown): string | undefined => {
    if (typeof m === 'string') return /(?:^|,)\s*(?:target|destination|dst)=([^,]+)/.exec(m)?.[1];
    const t = (m as { target?: unknown } | null)?.target;
    return typeof t === 'string' ? t : undefined;
  };
  const existing = mounts.find((m) => targetOf(m)?.replace(/\/+$/, '') === projectsTarget);
  if (existing === undefined) {
    set(['mounts', mounts.length], transcriptsMount);
    needed.push(`mounts: ${projectsTarget} -> <folder>/.snagboat/claude-projects`);
  } else {
    const source = typeof existing === 'string' ? existing : String((existing as { source?: unknown }).source ?? '');
    if (!source.includes('.snagboat/claude-projects')) {
      return refuse(`a mount in ${rel(configPath)} already targets ${projectsTarget}, but not .snagboat/claude-projects:\n  ${JSON.stringify(existing)}\nChange it by hand.`);
    }
  }

  // 3. git safe.directory on start, and (with beads) the beads exporter. A postStartCommand that already starts a
  // beads-export.sh of its own (this repository's .devcontainer one) needs neither the step nor the script.
  const post = config.postStartCommand;
  const beadsExport = path.join(folder, ...BEADS_EXPORT_REL.split('/'));
  const hasBeads = isDirectory(path.join(folder, '.beads'));
  const ownExporter = typeof post === 'string' && post.includes('beads-export.sh') && !post.includes(BEADS_EXPORT_REL);
  if (post === undefined || typeof post === 'string') {
    let next = post ?? '';
    if (!next.includes('safe.directory')) {
      next = next ? `${SAFE_DIRECTORY}; ${next}` : SAFE_DIRECTORY;
      needed.push('postStartCommand: marks the project folder as a git safe.directory first');
    }
    if (hasBeads && !ownExporter && !next.includes(BEADS_EXPORT_REL)) {
      next = `${next}; ${BEADS_EXPORT_START}`;
      needed.push(`postStartCommand: starts ${BEADS_EXPORT_REL} last, which exports bd's issues and history to .snagboat/beads/ every minute for the core here`);
    }
    if (next !== (post ?? '')) set(['postStartCommand'], next);
  } else {
    plan.notes.push(`postStartCommand isn't a string; add this to it yourself:\n  ${SAFE_DIRECTORY}${hasBeads ? `\n  ${BEADS_EXPORT_START}` : ''}`);
  }
  if (hasBeads && !ownExporter) {
    plan.beadsExportPath = beadsExport;
    let current: string | undefined;
    try {
      current = fs.readFileSync(beadsExport, 'utf8');
    } catch {
      current = undefined;
    }
    plan.writesBeadsExport = current !== BEADS_EXPORT_SCRIPT;
  }

  // The transcripts folder must be a real folder in the project: a link would hand the container somewhere else on this machine.
  // So must the beads exporter's folder, and the script a real file (it's replaced, never written through).
  const dirs = [path.join(folder, '.snagboat'), transcriptsDir, ...(plan.beadsExportPath ? [path.dirname(plan.beadsExportPath)] : [])];
  for (const p of dirs) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) return refuse(`${p} is a link or a file, not a folder: replace it with a real folder first`);
  }
  if (plan.beadsExportPath) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(plan.beadsExportPath);
    } catch {
      st = undefined;
    }
    if (st && !st.isFile()) return refuse(`${plan.beadsExportPath} is a link or a folder, not a file: remove it first`);
  }
  plan.createsTranscriptsDir = !fs.existsSync(transcriptsDir);

  const personalExists = fs.existsSync(outPath) && !inPlace;
  if (!inPlace && needed.length === 0 && !personalExists) {
    // The shared config already has it all: no personal config needed.
    plan.changes = [];
  } else if (inPlace) {
    plan.changes = needed;
    plan.after = text;
    plan.writesConfig = text !== original;
  } else {
    // 0. The personal config lives one folder down: paths relative to the config file are rewritten to point at the same
    // files, and it gets a name of its own for VS Code's "which configuration" prompt.
    const baseDir = path.dirname(configPath);
    const outDir = path.dirname(outPath);
    const rebase = (p: string) => posix(path.relative(outDir, path.resolve(baseDir, p))) || '.';
    const own: string[] = [];
    const name = typeof config.name === 'string' && config.name ? config.name : path.basename(folder);
    plan.personalName = `${name} (Snagboat)`;
    set(['name'], plan.personalName);
    own.push(`name: "${name} (Snagboat)", to pick it out when reopening in the container`);
    if (config.build && typeof config.build === 'object') {
      if (typeof config.build.dockerfile === 'string') set(['build', 'dockerfile'], rebase(config.build.dockerfile));
      // The build context defaults to the config's own folder, so it's always set explicitly here.
      set(['build', 'context'], rebase(typeof config.build.context === 'string' ? config.build.context : '.'));
      own.push("build: dockerfile and context point at the shared config's");
    }
    if (typeof config.dockerFile === 'string') {
      set(['dockerFile'], rebase(config.dockerFile));
      set(['context'], rebase(typeof config.context === 'string' ? config.context : '.'));
      own.push("dockerFile and context point at the shared config's");
    }
    if (config.features && typeof config.features === 'object') {
      for (const [id, featureOptions] of Object.entries(config.features)) {
        if (!id.startsWith('./') && !id.startsWith('../')) continue;
        set(['features', id], undefined);
        set(['features', rebase(id).replace(/^(?!\.)/, './')], featureOptions);
        own.push(`features: local feature ${id} at its new relative path`);
      }
    }
    const eol = fmt.formattingOptions!.eol!;
    const header = [
      `// Personal dev container config for Snagboat, made from ${posix(path.relative(outDir, configPath))} by \`snagboat containers allow --edit\`.`,
      '// Only in this clone: git ignores it here (.git/info/exclude), so it never reaches collaborators. Run that again',
      '// after the shared config changes to bring this one up to date.',
      `${HEADER_MARK} base=${fingerprint(original)} generated=${fingerprint(text)}`,
    ].join(eol);
    const generated = `${header}${eol}${text}`;
    if (personalExists) {
      const previous = fs.readFileSync(outPath, 'utf8');
      const mark = new RegExp(`^${HEADER_MARK} base=(\\w+) generated=(\\w+)\\r?$`, 'm').exec(previous);
      const body = mark ? previous.slice(previous.indexOf('\n', mark.index) + 1) : undefined;
      if (!mark || body === undefined || fingerprint(body) !== mark[2]) {
        if (!force) return refuse(`${rel(outPath)} has been edited since it was made (or wasn't made by Snagboat). Rerun with --force to replace it, edits and all.`);
        plan.notes.push(`--force: replacing ${rel(outPath)}, edits and all`);
      } else if (mark[1] !== fingerprint(original)) {
        plan.notes.push(`${rel(configPath)} changed since ${rel(outPath)} was made: regenerating it`);
      }
      plan.beforePath = outPath;
      plan.before = previous;
    }
    plan.after = generated;
    plan.writesConfig = plan.before !== generated || !personalExists;
    plan.changes = plan.writesConfig ? [...own, ...needed] : [];
  }

  // What git should ignore, and where: .gitignore (committed) with inPlace, else this clone's .git/info/exclude. git itself
  // says whether a path is ignored already, by any ignore file (a nested .snagboat/claude-projects/.gitignore counts).
  const gitPath = spawnSync('git', ['-C', folder, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  if (gitPath.status === 0 && gitPath.stdout.trim()) {
    const ignored = (p: string) => spawnSync('git', ['-C', folder, 'check-ignore', '-q', '--no-index', p]).status === 0;
    const transcriptsIgnored = ignored('.snagboat/claude-projects/session.jsonl');
    if (inPlace) {
      plan.ignoreFile = path.join(folder, '.gitignore');
      if (!transcriptsIgnored) plan.ignoreLines = ['.snagboat/'];
    } else {
      plan.ignoreFile = path.resolve(folder, gitPath.stdout.trim());
      if (!transcriptsIgnored) plan.ignoreLines.push('/.snagboat/');
      if ((plan.writesConfig || personalExists) && !ignored('.devcontainer/snagboat/devcontainer.json')) plan.ignoreLines.push('/.devcontainer/snagboat/');
    }
    const tracked = spawnSync('git', ['-C', folder, 'ls-files', '--', '.devcontainer/snagboat', '.snagboat'], { encoding: 'utf8' });
    const trackedFiles = (tracked.stdout ?? '').split('\n').filter((f) => f && path.basename(f) !== '.gitignore');
    if (trackedFiles.length) plan.notes.push(`git already tracks some of these, which ignoring doesn't hide:\n${trackedFiles.join('\n')}`);
  } else if (inPlace) {
    plan.ignoreFile = path.join(folder, '.gitignore');
    const has = (fs.existsSync(plan.ignoreFile) ? fs.readFileSync(plan.ignoreFile, 'utf8') : '').split(/\r?\n/).some((l) => ['.snagboat', '.snagboat/', '/.snagboat', '/.snagboat/'].includes(l.trim()));
    if (!has) plan.ignoreLines = ['.snagboat/'];
  } else {
    plan.notes.push(`${folder} isn't a git repository, so nothing is set to be ignored`);
  }

  if (plan.writesConfig || plan.createsTranscriptsDir || plan.writesBeadsExport || plan.ignoreLines.length) plan.state = 'changes';
  return plan;
}

/** Makes the plan's changes; returns one line per thing written. Writes nothing for a refused plan. */
export function applyDevcontainerPlan(plan: DevcontainerPlan): string[] {
  if (plan.state !== 'changes') return [];
  const done: string[] = [];
  const rel = (p: string) => (p.startsWith(plan.folder + path.sep) ? posix(path.relative(plan.folder, p)) : p);
  if (plan.writesConfig) {
    fs.mkdirSync(path.dirname(plan.outPath), { recursive: true });
    fs.writeFileSync(plan.outPath, plan.after);
    done.push(`wrote ${rel(plan.outPath)}`);
  }
  if (plan.createsTranscriptsDir) {
    fs.mkdirSync(plan.transcriptsDir, { recursive: true });
    done.push(`created ${rel(plan.transcriptsDir)}/`);
  }
  if (plan.writesBeadsExport && plan.beadsExportPath) {
    // Written beside it and renamed over it: a link put there since the plan is replaced, not followed, and a copy
    // already running keeps reading the file it started with.
    fs.mkdirSync(path.dirname(plan.beadsExportPath), { recursive: true });
    const tmp = `${plan.beadsExportPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, BEADS_EXPORT_SCRIPT, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, plan.beadsExportPath);
    done.push(`wrote ${rel(plan.beadsExportPath)}`);
  }
  if (plan.ignoreFile && plan.ignoreLines.length) {
    const before = fs.existsSync(plan.ignoreFile) ? fs.readFileSync(plan.ignoreFile, 'utf8') : '';
    fs.mkdirSync(path.dirname(plan.ignoreFile), { recursive: true });
    fs.writeFileSync(plan.ignoreFile, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${plan.ignoreLines.map((l) => `${l}\n`).join('')}`);
    done.push(`added ${plan.ignoreLines.join(' and ')} to ${rel(plan.ignoreFile)}`);
  }
  return done;
}

/** A short summary of what the folder's dev container still needs, for status lines and notifications. */
export function describePlan(plan: DevcontainerPlan | undefined): string {
  if (!plan) return 'no devcontainer.json';
  const rel = (p: string) => posix(path.relative(plan.folder, p));
  if (plan.state === 'refused') return `can't be set up automatically: ${plan.problem!.split('\n')[0]}`;
  if (plan.state === 'ready') return `set up (${rel(plan.beforePath)})`;
  const parts: string[] = [];
  if (plan.writesConfig) parts.push(fs.existsSync(plan.outPath) ? `${rel(plan.outPath)} to update` : `${rel(plan.outPath)} to write`);
  if (plan.createsTranscriptsDir) parts.push(`${rel(plan.transcriptsDir)}/ to create`);
  if (plan.writesBeadsExport && plan.beadsExportPath) parts.push(`${rel(plan.beadsExportPath)} to ${fs.existsSync(plan.beadsExportPath) ? 'update' : 'write'}`);
  if (plan.ignoreLines.length) parts.push('git to ignore .snagboat/');
  return `not set up: ${parts.join(', ')}`;
}

/** A unified diff of two texts (3 lines of context), for showing a change before it's made. */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  if (a === b) return '';
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  // Longest common subsequence, from the end: configs are small.
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Array<{ op: ' ' | '-' | '+'; line: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ op: ' ', line: x[i], ai: i++, bi: j++ });
    else if (i < x.length && (j >= y.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ op: '-', line: x[i], ai: i++, bi: j });
    else ops.push({ op: '+', line: y[j], ai: i, bi: j++ });
  }
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  const context = 3;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    // Extend the hunk while changes are within 2 * context lines of each other.
    for (let m = k; m < ops.length; m++) {
      if (ops[m].op !== ' ') end = m;
      else if (m - end > 2 * context) break;
    }
    const stop = Math.min(ops.length, end + context + 1);
    const hunk = ops.slice(start, stop);
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${ops[start].ai + 1},${aLen} +${ops[start].bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
    k = stop;
  }
  return out.join('\n') + '\n';
}
