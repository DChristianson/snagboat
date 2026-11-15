#!/usr/bin/env node
/*
 * Sets up a project's dev container so Snagboat on this machine sees the Claude Code sessions run
 * inside it (a stopgap for snagboat-05p, until `snagboat containers allow` offers this itself):
 *
 *   1. devcontainer.json: mounts the project at the same path as on the host, bind-mounts the
 *      container's ~/.claude/projects to <folder>/.snagboat/claude-projects, and marks the project
 *      folder as a git safe.directory on start. Edited with jsonc-parser, so comments survive.
 *   2. Creates .snagboat/claude-projects (Docker won't start with a missing bind source) and adds
 *      .snagboat/ to .gitignore.
 *   3. Carries Claude Code's history into .snagboat/claude-projects, so `claude --resume` in the
 *      rebuilt container still lists it (the new mount hides what was there):
 *        - the container's own transcripts, copied out of its Docker volume (which outlives a rebuild,
 *          so this works before or after one), in a throwaway container from its image, with no network;
 *        - those saved under the project's old path (/workspaces/<name>) moved to its new path's name;
 *        - this machine's own sessions in the project (~/.claude/projects/<key>), copied in.
 *      Copies only: never links, never deletes, and a file is replaced only by a newer copy, so
 *      rerunning it brings over what was written since. The memory folder beside the transcripts
 *      comes too, so the container sees this machine's memory for the project.
 *   4. Runs `snagboat containers allow <folder>` with this repo's built CLI.
 *
 * Run it on the host (not in a container), from anywhere:
 *   node scripts/devcontainerSetup.js <folder> [--dry-run] [--no-allow] [--no-save] [--no-host-sessions] [--force]
 *
 * --dry-run prints the changes and writes nothing. --force replaces a workspaceMount that isn't
 * the same-path one (otherwise it stops). --no-save skips the container's transcripts, and
 * --no-host-sessions this machine's. Rebuild the container afterwards.
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
const known = new Set(['--dry-run', '--no-allow', '--no-save', '--no-host-sessions', '--force']);
for (const f of flags) if (!known.has(f)) fail(`unknown option ${f}`);
if (positional.length !== 1) fail('usage: node scripts/devcontainerSetup.js <folder> [--dry-run] [--no-allow] [--no-save] [--no-host-sessions] [--force]');
const dryRun = flags.has('--dry-run');

function fail(msg) {
  process.stderr.write(`devcontainerSetup: ${msg}\n`);
  process.exit(1);
}

const folder = fs.realpathSync(path.resolve(positional[0]));
const candidates = [path.join(folder, '.devcontainer', 'devcontainer.json'), path.join(folder, '.devcontainer.json')];
const configPath = candidates.find((p) => fs.existsSync(p));
if (!configPath) fail(`no devcontainer.json in ${folder} (looked for ${candidates.map((p) => path.relative(folder, p)).join(', ')})`);

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

// Show what changed.
const rel = path.relative(folder, configPath);
if (changes.length) {
  process.stdout.write(`${rel}:\n${changes.map((c) => `  + ${c}`).join('\n')}\n\n`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devcontainer-setup-'));
  const after = path.join(tmp, 'devcontainer.json');
  fs.writeFileSync(after, text);
  const diff = spawnSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, configPath, after], { encoding: 'utf8' });
  process.stdout.write(diff.stdout || '(diff not available)\n');
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  process.stdout.write(`${rel}: already set up\n`);
}

const transcripts = path.join(folder, '.snagboat', 'claude-projects');
const gitignore = path.join(folder, '.gitignore');
const ignoreText = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
const ignored = ignoreText.split(/\r?\n/).some((l) => ['.snagboat', '.snagboat/', '/.snagboat', '/.snagboat/'].includes(l.trim()));

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

if (dryRun) {
  process.stdout.write(`\n--dry-run: would also create ${path.relative(folder, transcripts)}/${ignored ? '' : ', add .snagboat/ to .gitignore'}${flags.has('--no-allow') ? '' : ' and run snagboat containers allow'}.\n`);
} else {
  if (changes.length) fs.writeFileSync(configPath, text);
  fs.mkdirSync(transcripts, { recursive: true });
  if (!ignored) fs.writeFileSync(gitignore, `${ignoreText}${ignoreText && !ignoreText.endsWith('\n') ? '\n' : ''}.snagboat/\n`);
  process.stdout.write(`\ncreated ${path.relative(folder, transcripts)}/${ignored ? '' : '; added .snagboat/ to .gitignore'}\n`);
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
  const ps = spawnSync('docker', ['ps', '-a', '--filter', `label=devcontainer.local_folder=${folder}`, '--format', '{{.ID}}'], { encoding: 'utf8' });
  const ids = ps.status === 0 ? ps.stdout.split('\n').filter(Boolean) : [];
  const inspect = ids.length ? spawnSync('docker', ['inspect', ids[0]], { encoding: 'utf8' }) : undefined;
  let info;
  try {
    info = inspect?.status === 0 ? JSON.parse(inspect.stdout)[0] : undefined;
  } catch {
    info = undefined;
  }
  if (ps.error || ps.status !== 0) {
    say('\nnote: docker isn\'t available here, so the container\'s earlier transcripts weren\'t saved. Rerun this with Docker running.');
  } else if (!info) {
    say('\nno dev container for this folder yet: no earlier container transcripts to save');
  } else {
    const mounts = Array.isArray(info.Mounts) ? info.Mounts : [];
    for (const m of mounts) if (m.Type === 'bind' && m.Destination !== folder && realOrSelf(m.Source) === folder) oldPaths.add(m.Destination);
    const within = (dir) => projectsTarget === dir.replace(/\/+$/, '') || projectsTarget.startsWith(`${dir.replace(/\/+$/, '')}/`);
    const volume = mounts.filter((m) => m.Type === 'volume' && m.Name && within(m.Destination)).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!volume) {
      say(`\nno Docker volume holds ${projectsTarget} in the container: no earlier container transcripts to save`);
    } else {
      const sub = path.posix.relative(volume.Destination, projectsTarget);
      const from = `${volume.Name}:/${sub}`;
      if (dryRun) {
        say(`\n--dry-run: would copy the container's transcripts (Docker volume ${from}) into ${path.relative(folder, transcripts)}/`);
      } else {
        // Run as the container's user, who owns the files, in the container's own image (nothing to pull).
        // -u: replace only with a newer copy; an image whose cp has no -u falls back to -n (never replace).
        const copy = 'src="/v/$1"; [ -d "$src" ] || exit 0; cp -R -P -p -u "$src/." /out/ 2>/dev/null || cp -R -P -p -n "$src/." /out/';
        const r = spawnSync(
          'docker',
          ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--user', info.Config?.User || user, '-v', `${volume.Name}:/v:ro`, '-v', `${transcripts}:/out`, info.Image, '-c', copy, 'sh', sub],
          { encoding: 'utf8' }
        );
        if (r.status === 0) say(`\nsaved the container's transcripts (Docker volume ${from}) into ${path.relative(folder, transcripts)}/`);
        else say(`\nnote: couldn't copy the container's transcripts from Docker volume ${from}: ${(r.stderr || r.error?.message || '').trim()}`);
      }
    }
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
  `\nNext: rebuild the container (Dev Containers: Rebuild Container). The window reopens at ${folder}.\n` +
    `Then, after a Claude session in it, run snagboat containers status here: the folder should list session files.\n`
);
