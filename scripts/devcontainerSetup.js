#!/usr/bin/env node
/*
 * Sets up a project's dev container so Snagboat on this machine sees the Claude Code sessions run
 * inside it (a stopgap for snagboat-05p, until `snagboat containers allow` offers this itself):
 *
 *   1. A personal dev container config, .devcontainer/snagboat/devcontainer.json: the project's own
 *      config, plus the project mounted at the same path as on the host, the container's
 *      ~/.claude/projects bind-mounted to <folder>/.snagboat/claude-projects, and the project folder
 *      marked as a git safe.directory on start. Paths relative to the config (Dockerfile, build
 *      context, local features) are rewritten to point at the shared ones. Made with jsonc-parser,
 *      so comments survive. Dev Containers has no per-user override that merges into a committed
 *      config, so this is a copy: it records a fingerprint of the shared config, and rerunning the
 *      script regenerates it, unless it was edited by hand (then only with --force).
 *      Committed, these changes would apply to everyone who opens the container, Snagboat or not.
 *      --in-place makes them in the shared devcontainer.json instead, for a repository only you use.
 *   2. Creates .snagboat/claude-projects (Docker won't start with a missing bind source) and has git
 *      ignore it and the personal config in this clone only (.git/info/exclude), or with --in-place
 *      adds .snagboat/ to .gitignore.
 *   3. Carries Claude Code's history into .snagboat/claude-projects, so `claude --resume` in the
 *      rebuilt container still lists it (the new mount hides what was there):
 *        - each of the folder's containers' own transcripts (the shared config's and the personal
 *          one's are different containers), copied out of its Docker volume (which outlives a rebuild,
 *          so this works before or after one), in a throwaway container from its image, with no network;
 *        - those saved under the project's old path (/workspaces/<name>) moved to its new path's name;
 *        - this machine's own sessions in the project (~/.claude/projects/<key>), copied in.
 *      Copies only: never links, never deletes, and a file is replaced only by a newer copy, so
 *      rerunning it brings over what was written since. The memory folder beside the transcripts
 *      comes too, so the container sees this machine's memory for the project.
 *   4. Runs `snagboat containers allow <folder>` with this repo's built CLI.
 *
 * Run it on the host (not in a container), from anywhere:
 *   node scripts/devcontainerSetup.js <folder> [--dry-run] [--in-place] [--no-allow] [--no-save] [--no-host-sessions] [--force]
 *
 * --dry-run prints the changes and writes nothing. --force replaces a workspaceMount that isn't
 * the same-path one, and a personal config edited by hand (otherwise it stops). --no-save skips
 * the containers' transcripts, and --no-host-sessions this machine's. Then reopen in the container,
 * picking "<name> (Snagboat)", or with --in-place rebuild it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const jsonc = require('jsonc-parser');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const known = new Set(['--dry-run', '--in-place', '--no-allow', '--no-save', '--no-host-sessions', '--force']);
for (const f of flags) if (!known.has(f)) fail(`unknown option ${f}`);
if (positional.length !== 1) fail('usage: node scripts/devcontainerSetup.js <folder> [--dry-run] [--in-place] [--no-allow] [--no-save] [--no-host-sessions] [--force]');
const dryRun = flags.has('--dry-run');

function fail(msg) {
  process.stderr.write(`devcontainerSetup: ${msg}\n`);
  process.exit(1);
}

const folder = fs.realpathSync(path.resolve(positional[0]));
const candidates = [path.join(folder, '.devcontainer', 'devcontainer.json'), path.join(folder, '.devcontainer.json')];
const configPath = candidates.find((p) => fs.existsSync(p));
if (!configPath) fail(`no devcontainer.json in ${folder} (looked for ${candidates.map((p) => path.relative(folder, p)).join(', ')})`);

// By default the changes go in a personal config beside the shared one, which git is told to ignore in this clone only
// (.git/info/exclude): a committed change would apply to everyone who opens the container. --in-place edits the shared one.
const inPlace = flags.has('--in-place');
const personalPath = path.join(folder, '.devcontainer', 'snagboat', 'devcontainer.json');
const outPath = inPlace ? configPath : personalPath;
const posix = (p) => p.split(path.sep).join('/');
const crypto = require('crypto');
const fingerprint = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const HEADER_MARK = '// snagboat-personal-config';

const original = fs.readFileSync(configPath, 'utf8');
const errors = [];
const config = jsonc.parse(original, errors, { allowTrailingComma: true });
if (errors.length || typeof config !== 'object' || config === null) fail(`couldn't parse ${configPath}`);
if (config.dockerComposeFile) {
  fail(
    `${configPath} uses dockerComposeFile: mounts live in the compose file, so edit it by hand. In the service's volumes:\n` +
      `  - <folder>:<folder>                                   (same path as on the host; set workspaceFolder to <folder>)\n` +
      `  - <folder>/.snagboat/claude-projects:<container home>/.claude/projects`
  );
}

// Where Claude Code keeps transcripts in the container: $CLAUDE_CONFIG_DIR/projects, else the container user's ~/.claude/projects.
const user = config.remoteUser || config.containerUser || 'root';
const claudeDir = config.containerEnv?.CLAUDE_CONFIG_DIR || config.remoteEnv?.CLAUDE_CONFIG_DIR || (user === 'root' ? '/root/.claude' : `/home/${user}/.claude`);
const projectsTarget = `${claudeDir.replace(/\/+$/, '')}/projects`;

const SAME_PATH_MOUNT = 'source=${localWorkspaceFolder},target=${localWorkspaceFolder},type=bind';
const TRANSCRIPTS_MOUNT = `source=\${localWorkspaceFolder}/.snagboat/claude-projects,target=${projectsTarget},type=bind`;
const SAFE_DIRECTORY =
  'git config --global --get-all safe.directory 2>/dev/null | grep -qxF "${containerWorkspaceFolder}" || git config --global --add safe.directory "${containerWorkspaceFolder}"';

const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } };
let text = original;
const changes = [];
const set = (jsonPath, value) => {
  text = jsonc.applyEdits(text, jsonc.modify(text, jsonPath, value, fmt));
};

// 0. A personal config lives one folder down, so paths that are relative to the config file are rewritten to point at the
// same files, and it gets a name of its own for VS Code's "which configuration" prompt.
if (!inPlace) {
  const baseDir = path.dirname(configPath);
  const outDir = path.dirname(outPath);
  const rebase = (p) => {
    const r = posix(path.relative(outDir, path.resolve(baseDir, p)));
    return r === '' ? '.' : r;
  };
  const name = typeof config.name === 'string' && config.name ? config.name : path.basename(folder);
  set(['name'], `${name} (Snagboat)`);
  changes.push(`name: "${name} (Snagboat)", to pick it out when reopening in the container`);
  if (config.build && typeof config.build === 'object') {
    if (typeof config.build.dockerfile === 'string') set(['build', 'dockerfile'], rebase(config.build.dockerfile));
    // The build context defaults to the config's own folder, so it's always set explicitly here.
    set(['build', 'context'], rebase(typeof config.build.context === 'string' ? config.build.context : '.'));
    changes.push('build: dockerfile and context point at the shared config\'s');
  }
  if (typeof config.dockerFile === 'string') {
    set(['dockerFile'], rebase(config.dockerFile));
    set(['context'], rebase(typeof config.context === 'string' ? config.context : '.'));
    changes.push('dockerFile and context point at the shared config\'s');
  }
  if (config.features && typeof config.features === 'object') {
    for (const [id, options] of Object.entries(config.features)) {
      if (!id.startsWith('./') && !id.startsWith('../')) continue;
      set(['features', id], undefined);
      set(['features', rebase(id).replace(/^(?!\.)/, './')], options);
      changes.push(`features: local feature ${id} at its new relative path`);
    }
  }
}

// 1. Same-path workspace mount.
if (config.workspaceMount !== SAME_PATH_MOUNT) {
  if (config.workspaceMount && !flags.has('--force')) {
    fail(`workspaceMount is already set to\n  ${config.workspaceMount}\nnot the same-path mount. Rerun with --force to replace it.`);
  }
  set(['workspaceMount'], SAME_PATH_MOUNT);
  changes.push('workspaceMount: the project at the same path as on the host');
}
if (config.workspaceFolder !== '${localWorkspaceFolder}') {
  set(['workspaceFolder'], '${localWorkspaceFolder}');
  changes.push('workspaceFolder: ${localWorkspaceFolder} (the window reopens at the host path, not /workspaces/<name>)');
}

// 2. Transcripts bind mount (string mounts only; an object mount naming the same target counts too).
const mounts = Array.isArray(config.mounts) ? config.mounts : [];
const targetOf = (m) => (typeof m === 'string' ? /(?:^|,)\s*(?:target|destination|dst)=([^,]+)/.exec(m)?.[1] : m?.target);
const existing = mounts.find((m) => targetOf(m)?.replace(/\/+$/, '') === projectsTarget);
if (!existing) {
  set(['mounts', mounts.length], TRANSCRIPTS_MOUNT);
  changes.push(`mounts: ${projectsTarget} -> <folder>/.snagboat/claude-projects`);
} else if (!(typeof existing === 'string' ? existing : existing.source ?? '').includes('.snagboat/claude-projects')) {
  fail(`a mount already targets ${projectsTarget} but not .snagboat/claude-projects:\n  ${JSON.stringify(existing)}\nChange it by hand.`);
}

// 3. git safe.directory on start (the project's path in the container changes with the same-path mount).
const post = config.postStartCommand;
if (post === undefined || typeof post === 'string') {
  if (!post?.includes('safe.directory')) {
    set(['postStartCommand'], post ? `${SAFE_DIRECTORY}; ${post}` : SAFE_DIRECTORY);
    changes.push('postStartCommand: marks the project folder as a git safe.directory first');
  }
} else {
  process.stdout.write(`note: postStartCommand isn't a string; add this to it yourself:\n  ${SAFE_DIRECTORY}\n`);
}

// The personal config starts with a header recording the shared config it was made from, and a fingerprint of what was
// generated: a rerun after the shared config changes regenerates it, but never overwrites edits made by hand (without --force).
const rel = path.relative(folder, configPath);
const outRel = path.relative(folder, outPath);
const eol = fmt.formattingOptions.eol;
let previous;
if (!inPlace) {
  const header = [
    `// Personal dev container config for Snagboat, made from ${posix(path.relative(path.dirname(outPath), configPath))} by snagboat's scripts/devcontainerSetup.js.`,
    '// Only in this clone: git ignores it here (.git/info/exclude), so it never reaches collaborators. Rerun the script',
    '// after the shared config changes to bring this one up to date.',
    `${HEADER_MARK} base=${fingerprint(original)} generated=${fingerprint(text)}`,
  ].join(eol);
  text = `${header}${eol}${text}`;
  if (fs.existsSync(outPath)) {
    previous = fs.readFileSync(outPath, 'utf8');
    const mark = new RegExp(`^${HEADER_MARK} base=(\\w+) generated=(\\w+)\\r?$`, 'm').exec(previous);
    const body = mark ? previous.slice(previous.indexOf('\n', mark.index) + 1) : undefined;
    if (!mark || fingerprint(body) !== mark[2]) {
      if (!flags.has('--force')) fail(`${outRel} has been edited since it was made (or wasn't made by this script). Rerun with --force to replace it.`);
      process.stdout.write(`--force: replacing ${outRel}, edits and all\n`);
    } else if (mark[1] !== fingerprint(original)) {
      process.stdout.write(`${rel} changed since ${outRel} was made: regenerating it\n`);
    }
  }
}

// Show what changed: the shared config against what's written.
const compareWith = inPlace ? configPath : previous !== undefined ? outPath : configPath;
const unchanged = inPlace ? !changes.length : previous === text;
if (!unchanged) {
  process.stdout.write(`${outRel}${inPlace ? '' : ` (from ${rel})`}:\n${changes.map((c) => `  + ${c}`).join('\n')}\n\n`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devcontainer-setup-'));
  const after = path.join(tmp, 'devcontainer.json');
  fs.writeFileSync(after, text);
  const diff = spawnSync('diff', ['-u', '--label', `a/${path.relative(folder, compareWith)}`, '--label', `b/${outRel}`, compareWith, after], { encoding: 'utf8' });
  process.stdout.write(diff.stdout || '(diff not available)\n');
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  process.stdout.write(`${outRel}: already set up\n`);
}

const transcripts = path.join(folder, '.snagboat', 'claude-projects');
const ignorePatterns = ['.snagboat', '.snagboat/', '/.snagboat', '/.snagboat/'];
const hasLine = (file, patterns) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/).some((l) => patterns.includes(l.trim()));
const appendLines = (file, lines) => {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${lines.map((l) => `${l}\n`).join('')}`);
};

// What git should ignore, and where: .gitignore (committed) for --in-place, else this clone's .git/info/exclude.
let ignoreFile;
let ignoreLines = [];
if (inPlace) {
  ignoreFile = path.join(folder, '.gitignore');
  if (!hasLine(ignoreFile, ignorePatterns)) ignoreLines = ['.snagboat/'];
} else {
  const gitPath = spawnSync('git', ['-C', folder, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  if (gitPath.status === 0 && gitPath.stdout.trim()) {
    ignoreFile = path.resolve(folder, gitPath.stdout.trim());
    if (!hasLine(ignoreFile, ignorePatterns) && !hasLine(path.join(folder, '.gitignore'), ignorePatterns)) ignoreLines.push('/.snagboat/');
    const personalPatterns = ['/.devcontainer/snagboat/', '.devcontainer/snagboat/', '/.devcontainer/snagboat', '.devcontainer/snagboat'];
    if (!hasLine(ignoreFile, personalPatterns)) ignoreLines.push('/.devcontainer/snagboat/');
    const tracked = spawnSync('git', ['-C', folder, 'ls-files', '--', '.devcontainer/snagboat', '.snagboat'], { encoding: 'utf8' });
    if (tracked.stdout?.trim()) process.stdout.write(`note: git already tracks some of these, which an exclude doesn't hide:\n${tracked.stdout}`);
  } else {
    process.stdout.write(`note: ${folder} isn't a git repository, so nothing was set to be ignored\n`);
  }
}
const ignoreRel = ignoreFile ? (ignoreFile.startsWith(folder + path.sep) ? path.relative(folder, ignoreFile) : ignoreFile) : '';

// The transcripts folder must be a real folder in the project: a link would hand the container somewhere else on this machine.
for (const p of [path.join(folder, '.snagboat'), transcripts]) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    continue;
  }
  if (!st.isDirectory()) fail(`${p} is a link or a file, not a folder: replace it with a real folder first`);
}

const ignoreNote = ignoreLines.length ? `; added ${ignoreLines.join(' and ')} to ${ignoreRel}` : '';
if (dryRun) {
  process.stdout.write(`\n--dry-run: would write ${outRel}, create ${path.relative(folder, transcripts)}/${ignoreNote.replace('; added', ', add')}${flags.has('--no-allow') ? '' : ' and run snagboat containers allow'}.\n`);
} else {
  if (!unchanged) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text);
  }
  fs.mkdirSync(transcripts, { recursive: true });
  if (ignoreLines.length) appendLines(ignoreFile, ignoreLines);
  process.stdout.write(`\n${unchanged ? '' : `wrote ${outRel}; `}created ${path.relative(folder, transcripts)}/${ignoreNote}\n`);
}

// 4-6. Carry Claude Code's history into the transcripts folder, so `claude --resume` in the rebuilt container lists it.
// Copies only, never links, and never deletes. Rerunning is safe and brings over what was written since.

/** Claude Code names a project's transcript folder after its path: every character other than a letter or digit becomes "-". */
const keyOf = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const newKey = keyOf(folder);
const say = (line) => process.stdout.write(`${line}\n`);

/**
 * Copies src's tree into dst: folders and regular files only (links are skipped). A file already in dst is replaced
 * only by a newer copy that's no smaller (transcripts only grow), so a session continued on one side isn't lost.
 * With write false, only counts what it would copy.
 */
function copyTree(src, dst, write) {
  let n = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    let existing;
    try {
      existing = fs.lstatSync(d);
    } catch {
      existing = undefined;
    }
    if (ent.isDirectory()) {
      if (existing && !existing.isDirectory()) continue;
      n += copyTree(s, d, write);
    } else if (ent.isFile()) {
      const st = fs.statSync(s);
      if (existing && (!existing.isFile() || existing.mtimeMs >= st.mtimeMs || existing.size > st.size)) continue;
      if (write) {
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(s, d);
        fs.utimesSync(d, st.atime, st.mtime);
      }
      n++;
    }
  }
  return n;
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// 4. The container's own transcripts, from its Docker volume: the transcripts mount hides them in the container.
// The volume outlives a rebuild, so this works before or after one.
const oldPaths = new Set([`/workspaces/${path.basename(folder)}`]);
if (flags.has('--no-save')) {
  say('\n--no-save: not copying the container\'s transcripts from its Docker volume');
} else {
  // Every container made for this folder: the shared config's and the personal one's are different containers, each
  // with a Claude volume of its own (named after its id), and both may hold sessions.
  const ps = spawnSync('docker', ['ps', '-a', '--filter', `label=devcontainer.local_folder=${folder}`, '--format', '{{.ID}}'], { encoding: 'utf8' });
  const ids = ps.status === 0 ? ps.stdout.split('\n').filter(Boolean) : [];
  const infos = [];
  for (const id of ids) {
    const inspect = spawnSync('docker', ['inspect', id], { encoding: 'utf8' });
    try {
      if (inspect.status === 0) infos.push(JSON.parse(inspect.stdout)[0]);
    } catch {
      // A container that went away between ps and inspect.
    }
  }
  const within = (dir) => projectsTarget === dir.replace(/\/+$/, '') || projectsTarget.startsWith(`${dir.replace(/\/+$/, '')}/`);
  const done = new Set();
  if (ps.error || ps.status !== 0) {
    say('\nnote: docker isn\'t available here, so the container\'s earlier transcripts weren\'t saved. Rerun this with Docker running.');
  } else if (!infos.length) {
    say('\nno dev container for this folder yet: no earlier container transcripts to save');
  }
  for (const info of infos) {
    const mounts = Array.isArray(info.Mounts) ? info.Mounts : [];
    for (const m of mounts) if (m.Type === 'bind' && m.Destination !== folder && realOrSelf(m.Source) === folder) oldPaths.add(m.Destination);
    const volume = mounts.filter((m) => m.Type === 'volume' && m.Name && within(m.Destination)).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    const label = `container ${String(info.Id ?? '').slice(0, 12)}`;
    if (!volume) {
      say(`\n${label}: no Docker volume holds ${projectsTarget}, so no earlier transcripts to save`);
      continue;
    }
    if (done.has(volume.Name)) continue;
    done.add(volume.Name);
    const sub = path.posix.relative(volume.Destination, projectsTarget);
    const from = `${volume.Name}:/${sub}`;
    if (dryRun) {
      say(`\n--dry-run: would copy ${label}'s transcripts (Docker volume ${from}) into ${path.relative(folder, transcripts)}/`);
      continue;
    }
    // Run as the container's user, who owns the files, in the container's own image (nothing to pull).
    // -u: replace only with a newer copy; an image whose cp has no -u falls back to -n (never replace).
    const copy = 'src="/v/$1"; [ -d "$src" ] || exit 0; cp -R -P -p -u "$src/." /out/ 2>/dev/null || cp -R -P -p -n "$src/." /out/';
    const r = spawnSync(
      'docker',
      ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--user', info.Config?.User || user, '-v', `${volume.Name}:/v:ro`, '-v', `${transcripts}:/out`, info.Image, '-c', copy, 'sh', sub],
      { encoding: 'utf8' }
    );
    if (r.status === 0) say(`\nsaved ${label}'s transcripts (Docker volume ${from}) into ${path.relative(folder, transcripts)}/`);
    else say(`\nnote: couldn't copy ${label}'s transcripts from Docker volume ${from}: ${(r.stderr || r.error?.message || '').trim()}`);
  }
}

// 5. Transcripts saved under the project's old path in the container (/workspaces/<name>) go under its new path's name.
if (!dryRun) {
  for (const old of oldPaths) {
    const oldKey = keyOf(old);
    if (oldKey === newKey) continue;
    const src = path.join(transcripts, oldKey);
    const dst = path.join(transcripts, newKey);
    let st;
    try {
      st = fs.lstatSync(src);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
      say(`moved ${oldKey}/ to ${newKey}/ (the project's old path in the container to its new one)`);
    } else {
      const n = copyTree(src, dst, true);
      // The volume's copy is saved again on every run; once all of it is in the new folder, this one is a duplicate.
      if (copyTree(src, dst, false) === 0) {
        fs.rmSync(src, { recursive: true });
        if (n) say(`merged ${oldKey}/ into ${newKey}/ (${n} files)`);
      } else {
        say(`merged ${oldKey}/ into ${newKey}/ (${n} files); ${oldKey}/ is left as it was, as some of its files are older than ${newKey}/'s`);
      }
    }
  }
}

// 6. This machine's own sessions in the project, from before the container: copied, so the container never writes to them.
if (flags.has('--no-host-sessions')) {
  say('--no-host-sessions: not copying this machine\'s sessions in');
} else {
  const hostProjects = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(os.homedir(), '.claude', 'projects');
  const src = path.join(hostProjects, newKey);
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    st = undefined;
  }
  if (!st) {
    say(`no sessions on this machine for ${folder} (${src}) to copy in`);
  } else if (st.isSymbolicLink()) {
    say(
      `note: ${src} is a link, so it wasn't copied. A link into the project lets the container write the transcripts and memory\n` +
        `      Claude Code on this machine reads. Replace it with a real folder: unlink it, then cp -R -p its target to ${src}`
    );
  } else if (st.isDirectory()) {
    const dst = path.join(transcripts, newKey);
    const n = copyTree(src, dst, !dryRun);
    say(`${dryRun ? '--dry-run: would copy' : 'copied'} ${n} files of this machine's sessions (${src}) into ${path.relative(folder, dst)}/`);
  }
}

if (dryRun) {
  say('\n--dry-run: nothing written.');
  process.exit(0);
}

if (!flags.has('--no-allow')) {
  const cli = path.join(__dirname, '..', 'dist', 'snagboat.js');
  if (!fs.existsSync(cli)) fail(`${cli} isn't built: run npm run build in snagboat, then snagboat containers allow ${folder}`);
  const r = spawnSync(process.execPath, [cli, 'containers', 'allow', folder], { stdio: 'inherit' });
  if (r.status !== 0) fail('snagboat containers allow failed');
}

process.stdout.write(
  inPlace
    ? `\nNext: rebuild the container (Dev Containers: Rebuild Container). The window reopens at ${folder}.\n` +
        `Then, after a Claude session in it, run snagboat containers status here: the folder should list session files.\n`
    : `\nNext: in VS Code, run Dev Containers: Reopen in Container (or Rebuild Container) and pick "${jsonc.parse(text)?.name}".\n` +
        `It's a new container with its own Claude Code login: log in once. The window reopens at ${folder}.\n` +
        `Then, after a Claude session in it, run snagboat containers status here: the folder should list session files.\n` +
        `Rerun this script after the shared ${rel} changes, then rebuild.\n`
);
