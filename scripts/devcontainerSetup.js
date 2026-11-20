#!/usr/bin/env node
/*
 * Sets up a project's dev container so Snagboat on this machine sees the Claude Code sessions run
 * inside it, and carries the sessions it has so far into the new mount:
 *
 *   1. Runs `snagboat containers allow <folder> --edit` with this repo's built CLI (snagboat-05p): allows the folder,
 *      writes the personal dev container config (.devcontainer/snagboat/devcontainer.json; --in-place edits the shared
 *      devcontainer.json instead), creates .snagboat/claude-projects and has git ignore what it should. See
 *      src/core/devcontainerSetup.ts and docs/cli.md#dev-containers.
 *   2. Carries Claude Code's history into .snagboat/claude-projects, so `claude --resume` in the
 *      rebuilt container still lists it (the new mount hides what was there):
 *        - each of the folder's containers' own transcripts (the shared config's and the personal
 *          one's are different containers), copied out of its Docker volume (which outlives a rebuild,
 *          so this works before or after one), in a throwaway container from its image, with no network;
 *        - those saved under the project's old path (/workspaces/<name>) moved to its new path's name;
 *        - this machine's own sessions in the project (~/.claude/projects/<key>), copied in.
 *      Copies only: never links, never deletes, and a file is replaced only by a newer copy, so
 *      rerunning it brings over what was written since. The memory folder beside the transcripts
 *      comes too, so the container sees this machine's memory for the project.
 *
 * Run it on the host (not in a container), from anywhere, after npm run build:
 *   node scripts/devcontainerSetup.js <folder> [--dry-run] [--in-place] [--no-save] [--no-host-sessions] [--force]
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
const known = new Set(['--dry-run', '--in-place', '--no-save', '--no-host-sessions', '--force']);
for (const f of flags) if (!known.has(f)) fail(`unknown option ${f}${f === '--no-allow' ? ' (the dev container is set up by snagboat containers allow --edit now, which allows the folder too)' : ''}`);
if (positional.length !== 1) fail('usage: node scripts/devcontainerSetup.js <folder> [--dry-run] [--in-place] [--no-save] [--no-host-sessions] [--force]');
const dryRun = flags.has('--dry-run');
const inPlace = flags.has('--in-place');

function fail(msg) {
  process.stderr.write(`devcontainerSetup: ${msg}\n`);
  process.exit(1);
}

const folder = fs.realpathSync(path.resolve(positional[0]));
const candidates = [path.join(folder, '.devcontainer', 'devcontainer.json'), path.join(folder, '.devcontainer.json')];
const configPath = candidates.find((p) => fs.existsSync(p));
if (!configPath) fail(`no devcontainer.json in ${folder} (looked for ${candidates.map((p) => path.relative(folder, p)).join(', ')})`);
const config = jsonc.parse(fs.readFileSync(configPath, 'utf8'), [], { allowTrailingComma: true }) ?? {};

// 1. The config, the transcripts folder, git's ignores and the allow list: the CLI does all of it.
const cli = path.join(__dirname, '..', 'dist', 'snagboat.js');
if (!fs.existsSync(cli)) fail(`${cli} isn't built: run npm run build in snagboat first`);
const cliArgs = ['containers', 'allow', folder, ...(dryRun ? ['--dry-run'] : ['--edit']), ...(inPlace && !dryRun ? ['--in-place'] : []), ...(flags.has('--force') && !dryRun ? ['--force'] : [])];
const allow = spawnSync(process.execPath, [cli, ...cliArgs], { stdio: 'inherit' });
if (allow.status !== 0) fail(`snagboat ${cliArgs.join(' ')} failed`);

// Where Claude Code keeps transcripts in the container: $CLAUDE_CONFIG_DIR/projects, else the container user's ~/.claude/projects
// (as src/core/devcontainerSetup.ts works it out).
const user = config.remoteUser || config.containerUser || 'root';
const claudeDir = config.containerEnv?.CLAUDE_CONFIG_DIR || config.remoteEnv?.CLAUDE_CONFIG_DIR || (user === 'root' ? '/root/.claude' : `/home/${user}/.claude`);
const projectsTarget = `${claudeDir.replace(/\/+$/, '')}/projects`;
const transcripts = path.join(folder, '.snagboat', 'claude-projects');
if (!dryRun && !fs.existsSync(transcripts)) fail(`${transcripts} isn't there after snagboat containers allow --edit`);

process.stdout.write('\nCarrying earlier Claude Code sessions into the new mount:\n');

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

process.stdout.write(
  `\nIt's ${inPlace ? 'the same container, rebuilt' : 'a new container with its own Claude Code login: log in once'}. The window reopens at ${folder}.\n` +
    `After a Claude session in it, run snagboat containers status here: the folder should list session files.\n`
);
