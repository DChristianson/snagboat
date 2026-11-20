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
- the project folder marked as a git `safe.directory` on start (`postStartCommand`), since its path changed.

`devcontainer.json` is usually committed, and committed changes apply to everyone who opens the container ([data sources](data-sources.md#does-a-collaborator-have-to-use-snagboat)). So by default `--edit` writes a **personal config**, `.devcontainer/snagboat/devcontainer.json`: the shared one plus these changes, with its Dockerfile, build context and local features pointing at the shared ones, named "<name> (Snagboat)" to pick in **Dev Containers: Reopen in Container**. Git ignores it and `.snagboat/` in your clone only (`.git/info/exclude`). Dev Containers can't merge a per-user file into a committed one, so it's a copy: run `allow --edit` again after the shared config changes and it's regenerated, unless you've edited it by hand (then it stops; `--force` replaces it). `--in-place` edits the shared `devcontainer.json` and adds `.snagboat/` to `.gitignore`, for a repository only you use. Comments in the file are kept. A `dockerComposeFile` config is left alone: `allow` prints the two volumes to add to the compose file. A `workspaceMount` that isn't the same-path one stops `--edit` unless you add `--force`.

In VS Code, a window on this machine whose folder has a dev container that isn't set up offers the same, once per folder (the personal config only). **Snagboat: Set Up Dev Container** asks again.

The new mount hides the transcripts the container kept so far. `scripts/devcontainerSetup.js` in a snagboat checkout runs `allow --edit` and then carries them over: each of the folder's containers' earlier transcripts, out of their Docker volumes, and this machine's own sessions in the project ([.devcontainer/README.md](../.devcontainer/README.md#snagboat-and-this-container)).

## Migrating to the per-user store

`migrate` copies the stores earlier versions kept in VS Code's storage, one per window, into the per-user store (each VS Code window also copies its own when it starts). It copies, and never moves or deletes. Running it again copies only what's new. To check a migration, save `sessions --all --json --store vscode` to a file before migrating, then run `migrate --verify <file>`. Every session in it must be in the per-user store with the same prompt, tool-call and token counts.

## Which stores it reads

By default a command reads only the store of the workspace that contains the current folder. `--all` is the explicit way to read across workspaces. Once the per-user store (`~/.snagboat/data`) has events, commands read it; until then, or with `--store vscode`, they read the stores written by VS Code and its forks (Insiders, VSCodium, Cursor, Windsurf), including their servers in a dev container or over Remote-SSH (`~/.vscode-server` and the like; run the CLI on that side). `SNAGBOAT_STORE` names one store to read instead.

The server doesn't record which workspace a store belongs to, so Snagboat writes it in the store (`snagboat-workspace.json`) when a window opens it. A server store from before that has no record until its folder is opened again. Until then only `--all` reads it, and `migrate` skips it.

Publishing it as an npm package comes later ([architecture RFC](design/architecture-rfc.md)).
