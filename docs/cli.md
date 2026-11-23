# Command line

`snagboat` reads the same event logs from a terminal or an agent, without VS Code running. Every command prints JSON with `--json`. While the Claude Code plugin is enabled, it's `snagboat` on the agent's PATH and `~/.snagboat/bin/snagboat` for you. From a clone, `npm run build` builds it as `dist/snagboat.js`, as below. It needs Node.js 24 or later.

```sh
node dist/snagboat.js sessions            # sessions in the workspace containing this folder
node dist/snagboat.js session <id> --json # one session's summary
node dist/snagboat.js sessions --all      # every workspace's sessions
node dist/snagboat.js stores              # where the logs are
node dist/snagboat.js config              # the settings that apply here, and where each comes from
node dist/snagboat.js findings            # this workspace's findings, from the running core
node dist/snagboat.js advisors            # each advisor's goal and measures, this week against last
node dist/snagboat.js experiments         # every experiment: its change, baseline and tracked measure now
node dist/snagboat.js experiments revert <id>   # put back what it changed (keep, accept: keep it going, accept its result)
node dist/snagboat.js open                # the advisor UI in your browser (a one-time link)
node dist/snagboat.js mcp                 # an MCP server for agents: read-only tools, and two to review a report (the Claude Code plugin runs it)
node dist/snagboat.js statusline          # one line for Claude Code's status line
node dist/snagboat.js export --out ../acme-export   # this project's records, sanitized, to a folder
node dist/snagboat.js migrate --dry-run   # what migrate would copy into ~/.snagboat/data
node dist/snagboat.js migrate             # copy every store into the per-user store
node dist/snagboat.js sessions --all --store vscode   # read VS Code's stores, not the per-user store
```

## The core service

`snagboat serve` runs the **core service** (preview): one local process per user that reads and writes the per-user store for other tools, on `127.0.0.1` only, found through `~/.snagboat/core.json`. `snagboat core start` starts it in the background, `core status` and `core stop` find it, and it stops by itself after 30 idle minutes (`--idle-minutes`).

**While it runs, the core records Claude Code and Copilot CLI sessions in every project on this machine**, not only ones open in VS Code. It reads `~/.claude/projects` and `~/.copilot/session-state`, files each project under the workspace that contains it (or its repository), and applies retention to them. A project's `"collect": false`, `"collect.unopened": false` in your `~/.snagboat/config.json`, or `--no-collect` limits it ([privacy](../PRIVACY.md#what-is-captured)). Claude Code hooks for a project with no VS Code window open go to the core too. Once a core has run, hooks that find no core are kept until it next starts.

VS Code starts the core and each window is its client. The core collects and writes, and a window shows its own workspace from it ([handoff](design/handoff-3c.md)).

## Dev containers

Claude Code sessions inside a dev container don't reach the core on your machine: the container keeps its own `~/.claude`. If the container bind-mounts its `~/.claude/projects` to `.snagboat/claude-projects/` in the project folder, the core here reads those transcripts too, for folders you allow:

```sh
snagboat containers allow [folder]   # read folder's .snagboat/claude-projects (default: the current folder, as its real path)
snagboat containers deny [folder]    # stop reading it
snagboat containers status           # each allowed folder: whether claude-projects is there, its project folders and session files, when it was last read
```

`allow` and `deny` change `containers.allow` in `~/.snagboat/config.json` and print what they changed. The allow list lives only there, never in the project ([settings](settings.md#dev-containers-containersallow)). A running core picks up the change on its next ingest tick (every 30 seconds) and reads the folder while it runs (not with `--no-collect`). `status --json` prints the same as JSON. `allow --dry-run` shows what `allow` would change and writes nothing.

### Setting up the dev container

The container has to keep its transcripts where the core looks. `allow` checks the folder's `devcontainer.json` and lists what it lacks, with a diff, but changes nothing in the project; `status` says the same per folder. Add `--edit` to make the changes:

```sh
snagboat containers allow [folder] --edit              # a personal config, git-ignored in this clone only
snagboat containers allow [folder] --edit --in-place   # edit the shared devcontainer.json instead
```

A dev container needs:

- the project mounted at the **same path as on the host** (`workspaceMount`, `workspaceFolder`), so the paths in its transcripts name the same folder on both sides. This moves the project in the container: it opens at the host path, not `/workspaces/<name>`;
- its `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`; the home is `remoteUser`'s, else `containerUser`'s, else `/root`) **bind-mounted to `<folder>/.snagboat/claude-projects`**, which `--edit` creates, since Docker won't start with a missing mount source;
- the project folder marked as a git `safe.directory` on start (`postStartCommand`), since its path changed;
- in a project with beads (a `.beads` folder), the **beads exporter** started on start. `bd` runs only in the container, so `--edit` writes `.snagboat/bin/beads-export.sh` and adds `sh .snagboat/bin/beads-export.sh start` to the end of `postStartCommand` (guarded, so it does nothing in a clone without the script). In the background, at low priority, it writes `bd export` to `.snagboat/beads/issues.jsonl` every 60 seconds, each changed bead's `bd history --events` to `.snagboat/beads/history/<id>.json`, and `.snagboat/beads/status.json`, for the core here to read with no `bd` on this machine. It only reads `bd`, and writes nothing outside `.snagboat/beads/`. A newer Snagboat's script replaces the one there on the next `--edit`. A `postStartCommand` that already starts a `beads-export.sh` of its own (snagboat's `.devcontainer`) gets neither ([.devcontainer/README.md](../.devcontainer/README.md#beads-for-snagboat-on-the-host)).

`devcontainer.json` is usually committed, and committed changes apply to everyone who opens the container ([data sources](data-sources.md#does-a-collaborator-have-to-use-snagboat)). So by default `--edit` writes a **personal config**, `.devcontainer/snagboat/devcontainer.json`: the shared one plus these changes, with its Dockerfile, build context and local features pointing at the shared ones, named "<name> (Snagboat)" to pick in **Dev Containers: Reopen in Container**. Git ignores it and `.snagboat/` in your clone only (`.git/info/exclude`). Dev Containers can't merge a per-user file into a committed one, so it's a copy: run `allow --edit` again after the shared config changes and it's regenerated, unless you've edited it by hand (then it stops; `--force` replaces it). `--in-place` edits the shared `devcontainer.json` and adds `.snagboat/` to `.gitignore`, for a repository only you use. Comments in the file are kept. A `dockerComposeFile` config is left alone: `allow` prints the two volumes to add to the compose file. A `workspaceMount` that isn't the same-path one stops `--edit` unless you add `--force`.

In VS Code, a window on this machine whose folder has a dev container that isn't set up offers the same, once per folder (the personal config only). **Snagboat: Set Up Dev Container** asks again.

The new mount hides the transcripts the container kept so far. `scripts/devcontainerSetup.js` in a snagboat checkout runs `allow --edit` and then carries them over: each of the folder's containers' earlier transcripts, out of their Docker volumes, and this machine's own sessions in the project ([.devcontainer/README.md](../.devcontainer/README.md#snagboat-and-this-container)).

## Export

`snagboat export` writes one project's records from the store to a folder, through Snagboat's privacy rules, for Factory Clock or anything else to load ([design](design/export.md)). It only reads the store (`~/.snagboat/data`): it runs no git and no bd, reads no transcript, writes nothing back, and needs no core running.

```sh
snagboat export --out ~/exports/acme                       # the repository containing this folder, everything the store holds
snagboat export --project ~/src/acme --out ~/exports/acme --name acme --since 2026-11-01
snagboat export --out ~/exports/acme --text none           # structure only: counts, kinds, times, relative paths, links
snagboat export --out ~/exports/acme --allow flagged-3,flagged-7 --allow-rule internal-url
snagboat export --out ~/exports/acme --fail-on-flags --json   # for scripts: the manifest, or nothing written
snagboat export --out ~/exports/acme --match /workspaces/acme # and sessions a dev container recorded at another path
snagboat export --out ~/exports/acme --zip                 # and ~/exports/acme.zip, the folder in one file to send
```

| Option | What it does |
| --- | --- |
| `--out <dir>` | The export folder (required). A rerun replaces it whole. It must be outside the project and its worktrees, or under the project's `.snagboat/` folder (see below), and can't be a folder that holds anything but an earlier export. |
| `--project <dir>` | The project. Default: the repository containing the current folder (the nearest folder with a `.git`). |
| `--name <name>` | The project's name in `manifest.json`. Default: the project folder's name. |
| `--since <date>`, `--until <date>` | Only records from this time on, or before it: `YYYY-MM-DD` (UTC; `--until`'s day is included) or an ISO time. Each record by its own time: an event's, a commit's commit time, a checkout's or transition's, a link's latest evidence; branches, plan items and findings when their life overlaps the range. |
| `--text redacted\|none` | `redacted` (the default) keeps prompts, replies, commit messages and plan text, through the rules. `none` keeps structure only. |
| `--allow <ids>` | Puts flagged values back, by the ids in the review file (`flagged-3,flagged-7`). Repeatable. |
| `--allow-rule <rule>` | Puts back every value a flag rule caught (`internal-url`, `name`, `mention`, `high-entropy`, `unresolved-path`, `unknown-sha`, `foreign-trace`), or keeps the rule 2 values that are sometimes the point (`email`, `ip`, `mac`, `phone`, `card`). Never secrets, keys or denied words. Repeatable. |
| `--fail-on-flags` | Writes nothing if anything is flagged (exit 1). |
| `--match <path>` | Another path whose workspaces' records belong to the project, such as a dev container's `/workspaces/<name>`. Its paths become `[match-1]`. Repeatable. |
| `--zip` | Also writes `<out>.zip`: the export folder's files under one folder named like it, the same bytes for the same store. Never the review folder. A rerun without `--zip` removes an earlier zip, which would be another export's. |
| `--json` | Prints `manifest.json` instead of the summary. |

**What it selects.** The workspaces in the store whose folder is the project or inside it (its `.claude/worktrees/*` agents, say), any inside a `--match` path, and the repository's **other worktrees**. Without running git, a worktree is found from the store and the disk: a workspace whose `git.jsonl` has the project's root commit (the commit with no parents) and whose `.git` file points into the same repository. A separate clone of the same repository has its own `.git` folder and isn't included. Each workspace's working tree is where its checkouts happened, and its paths become `[worktree-1]`, `[worktree-2]` in path order. Records the worktrees share (commits, branches) are written once.

**What it writes.**

```text
<out>/
  README.md                   what each file is, how they join, what each redaction marker means
  manifest.json               versions, project name, range, counts, redactions by rule, flags, privacy,
                              and which schema each file follows
  schema/                     the JSON Schemas the records follow (each $id just its file name)
  events/YYYY-MM-DD.jsonl     the sessions' events (schema v4, sanitized), by UTC day
  sessions.jsonl              one per session: where it ran, its branches, commits and plan items
  findings.jsonl              finding episodes, with how you responded
  git/commits.jsonl  git/branches.jsonl  git/checkouts.jsonl
  plan/items.jsonl   plan/transitions.jsonl
  links.jsonl                 the current links between sessions, commits, branches and plan items
<out>.review/flags.jsonl      beside the export, never inside: each flagged value, with context
<out>.zip                     with --zip: <out>/ in one file, never the review folder
```

`README.md` and `schema/` are the same in every export (nothing in them names the project), so an export explains itself without this repository. The final check reads them like every other file.

The summary says what it wrote, how many values each rule replaced, how many were flagged and where the review file is. A flagged value is `[flagged-N]` in the export; the review file has the value and 80 characters each side, so read it before sharing, and rerun with `--allow` to put back what's fine. Copying the export folder never copies the review file.

**Privacy and keys.** Every repository is private unless you say otherwise with `"export.public": true` in its entry in `~/.snagboat/config.json` (a `.snagboat.json` can't: [settings](settings.md#outside-vs-code-snagboatconfigjson-and-snagboatjson)). A private repository's commit SHAs are re-keyed, and people pseudonymized, with the repository's key, `~/.snagboat/export-keys/<hash of its first commit>.key`, made on the first export; give it to a teammate (never by committing it) and your exports join up. A public one keeps its SHAs and pseudonymizes with this machine's key, `~/.snagboat/export.key`. `export.deny` lists words to replace with `[denied-N]`. The store doesn't record remote URLs, so there are none to remove; name the project with `--name`. A container's stock user name (`vscode`, `node`, `root`) isn't replaced as a word, since it names nobody and would mangle `.vscode/`.

**The final check.** Everything is written to a temporary folder beside `--out` first, and every file is searched for the values the rules removed: the project's and worktrees' paths, the home folder, the user and host names, every pseudonymized person's names and emails, denied words, and (private) the real SHAs, plus every PII and secret pattern. One hit and nothing is written: it prints the rule, the file and how many, never the value, and exits 1. Only then does the export replace `--out`, by rename.

**Where `--out` may be.** Never inside the project or one of its worktrees, where it could get committed, except under the project's `.snagboat/` folder: the export then writes a `.gitignore` beside it (`*` in a folder of its own under `.snagboat/`, such as `.snagboat/exports/`; just the export's own names directly under `.snagboat/`), as the beads exporter does, since it can't ask git what's ignored. Never inside `~/.snagboat/data`.

In VS Code, **Snagboat: Export Project...** does the same for the window's folder: it asks for a folder to export into (an empty one or an earlier export is used as it is; another gets `<project>-snagboat-export` inside it), always writes the zip beside it, and opens the review file when anything was flagged.

## Migrating to the per-user store

`migrate` copies the stores earlier versions kept in VS Code's storage, one per window, into the per-user store (each VS Code window also copies its own when it starts). It copies, and never moves or deletes. Running it again copies only what's new. To check a migration, save `sessions --all --json --store vscode` to a file before migrating, then run `migrate --verify <file>`. Every session in it must be in the per-user store with the same prompt, tool-call and token counts.

## Which stores it reads

By default a command reads only the store of the workspace that contains the current folder. `--all` is the explicit way to read across workspaces. Once the per-user store (`~/.snagboat/data`) has events, commands read it; until then, or with `--store vscode`, they read the stores written by VS Code and its forks (Insiders, VSCodium, Cursor, Windsurf), including their servers in a dev container or over Remote-SSH (`~/.vscode-server` and the like; run the CLI on that side). `SNAGBOAT_STORE` names one store to read instead.

The server doesn't record which workspace a store belongs to, so Snagboat writes it in the store (`snagboat-workspace.json`) when a window opens it. A server store from before that has no record until its folder is opened again. Until then only `--all` reads it, and `migrate` skips it.

Publishing it as an npm package comes later ([architecture RFC](design/architecture-rfc.md)).
