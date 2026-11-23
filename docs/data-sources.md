# Where Snagboat's data comes from

> **Work in progress.** Snagboat is a work in progress, and so is how it collects data. Each agent reports in its own way, and those ways keep changing (Copilot's Agent mode stopped sending OpenTelemetry when VS Code moved it to the Copilot CLI, for example), so this page describes what Snagboat does today, gaps included. [architecture.md](architecture.md) has the implementation details, and [PRIVACY.md](../PRIVACY.md#what-is-captured) lists every field stored.

## Two ways in

Snagboat gets data in two ways, and uses both where it can:

- **Pulled from files.** The agent writes a log of each session anyway, and Snagboat reads it. For Claude Code that's its transcripts (`~/.claude/projects/<project>/*.jsonl`); for Copilot's Agent mode, the Copilot CLI's session logs (`~/.copilot/session-state/<session>/events.jsonl`). This gives the most detail, and works for sessions that ended before Snagboat was running.
- **Pushed as they happen.** The agent calls Snagboat while it works: Claude Code runs Snagboat's **hooks**, and Copilot's editor features send **OpenTelemetry** to a receiver Snagboat runs. These are instant but carry less, and there's nothing to read for anything that happened while Snagboat wasn't listening.

Three components do the collecting:

| Component | What it does |
| --- | --- |
| **The hook script** (`~/.snagboat/bin/snagboat-hook`) | Run by Claude Code on each tool call, turn end and permission prompt. Forwards the event to the core, else leaves it in a spool for the core's next start. Installed by VS Code, or by the Claude Code plugin. |
| **A VS Code window** | A client of the core: it passes on only what the core can't see, its edits and Copilot's OpenTelemetry, and shows its own workspace from the core. |
| **The core** (`snagboat serve`) | Started by VS Code or the Claude Code plugin: reads every Claude Code project's transcripts and every Copilot CLI session on this machine, plus the dev container folders you allow, and receives the hooks. |

## Each place you chat

| Where you chat | Captured by | Pulled from files | Pushed |
| --- | --- | --- | --- |
| **Claude Code in VS Code** (the Claude Code extension, in a local window) | The core, which the window starts | Transcripts | Hooks |
| **Claude Code in a terminal** | The core; nothing while it isn't running, until it starts and reads the transcripts | Transcripts | Hooks, from the project's hook entry or from the Claude Code plugin |
| **Claude Code in a dev container** | The core on the host, for folders you allow (`snagboat containers allow`) | Transcripts, once the container keeps them in the project (`.snagboat/claude-projects/`, see [cli.md](cli.md#dev-containers)) | Nothing: the hook entry runs inside the container, where there's no Snagboat, and does nothing |
| **Copilot Agent mode in VS Code** | The core, which the window starts | Copilot CLI session logs | Nothing: Agent mode sends no OpenTelemetry |
| **Copilot inline and next-edit suggestions** | The window that owns the OpenTelemetry port, which passes them to the core | Nothing | OpenTelemetry, once you turn on Copilot's export ([usage.md](usage.md#copilot-setup)) |
| **Copilot in a dev container** | Not collected | Its session logs stay in the container | Its OpenTelemetry goes to an address inside the container, where nothing listens |

A dev container window shows the Snagboat panel because VS Code runs Snagboat on the host side of the window; collection still happens on the host.

## What each source gives

| Source | Detail | Running sessions | Earlier history | Which workspace |
| --- | --- | --- | --- | --- |
| **Claude Code transcripts** | The most: every model call with its tokens and model, tool calls with their target (file or command), prompts, reply excerpts, compactions, subagents, todo lists. Text is capped and redacted when stored | Seconds behind: files are watched, with a rescan every 60 seconds | Yes: a transcript is read from the start the first time it's seen, for as long as Claude Code keeps it (30 days by default) | From the working folder recorded in the transcript: the nearest workspace Snagboat knows, else its git repository |
| **Claude Code hooks** | Tool calls (name, target, success or failure), turn ends, permission prompts. No tokens and no text | Instant | No | From the project folder Claude Code passes to the hook |
| **Claude Code in a dev container** | As transcripts | Seconds behind | Only what's in `.snagboat/claude-projects/`. `snagboat containers allow --edit` sets up the mount. History from before the mount, and from the host, is copied in by `scripts/devcontainerSetup.js` | As transcripts, if the project is mounted at the same path as on the host; otherwise every session is filed under the allowed folder |
| **Copilot CLI session logs** | Model calls with tokens and the model's prompt budget, tool calls with their target, prompts, reply text, session names | New sessions found within 60 seconds, then followed as they're written | Yes, while the logs exist | From the folder the session started in |
| **Copilot OpenTelemetry** | Model calls and their tokens for editor features. Reply text only if Copilot's own content capture is on | Instant | No | Not reported by Copilot: everything goes to the workspace of the window that owns the port, whatever window it came from |
| **File saves** (VS Code) | Which file was saved, not its contents | Instant | No | The window's workspace |
| **Git repository** (read-only) | Into the workspace's `git.jsonl`: commits (parents, author and committer, co-authors, message, files changed with line counts, the pull request number in the subject, reverts), branches (created, head, merged and how, deleted), and HEAD checkouts in its working tree. No network: nothing is asked of GitHub | Every 5 minutes while a session in the repository is active, hourly otherwise | Commits and checkouts back to `retention.rawDays`, while the reflog has them; branches deleted before the first run aren't seen | The workspace whose folder is in the repository. Each worktree's workspace gets the shared commits and branches, and its own checkouts |

Transcripts and hooks overlap on purpose: a tool call seen by both is counted once, and when hooks are missing the transcript still supplies tool calls, tokens and text. Copilot's Agent mode also runs Claude Code's hooks, so those are dropped in favour of its session log.

## Does a collaborator have to use Snagboat?

Not for Claude Code's hooks. **Yes for dev containers, once the setup is committed.** What Snagboat writes into a project:

- **The hook entry in `.claude/settings.json`.** Snagboat adds it to every project you open in VS Code. If the file is committed, collaborators get the entry too. It runs `"$HOME/.snagboat/bin/snagboat-hook" … || true`, which does nothing where Snagboat isn't installed, and never fails or slows Claude Code. Collaborators who use the Claude Code plugin get their sessions recorded through it. To keep it out, ignore `.claude/settings.json`, or turn off `snagboat.claudeCode.configureHooks` for the folder (a project's `.snagboat.json` can turn it off for everyone).
- **Dev container changes.** By default `snagboat containers allow --edit` (and the VS Code prompt, and `scripts/devcontainerSetup.js`) writes them to a personal config (`.devcontainer/snagboat/devcontainer.json`) that git ignores in your clone only, so collaborators get nothing. With `--in-place` it edits the shared `devcontainer.json`, which a team normally commits. Committed, the changes apply to everyone who opens the container, whether or not they use Snagboat:
  - their container needs `.snagboat/claude-projects/` in their checkout, or Docker won't start it. `--in-place` adds all of `.snagboat/` to `.gitignore`, so a fresh clone doesn't have the folder. (This repository commits the folder with a `.gitignore` inside it, which avoids only this part);
  - their Claude Code transcripts are kept in their project folder, ignored by git, rather than in the container's volume;
  - their container mounts the project at their host's path, not `/workspaces/<name>`.

  Use `--in-place` only for a repository only you use, or one whose team agrees to the changes. The personal config is a copy, since Dev Containers can't merge a per-user file into a committed one, so run `allow --edit` again when the shared config changes.
- **`.snagboat.json`**, if a team adds one, holds shared thresholds and rules. It can only make things more private for collaborators, never less ([settings.md](settings.md)).

Nothing else changes a project.

The hook entry follows the same pattern as the dev container changes, but costs others nothing because it does nothing without Snagboat. The dev container changes act whether anyone uses Snagboat or not. The Copilot OpenTelemetry settings, the allow list for dev containers and everything Snagboat stores are per user.

## Known gaps

- Copilot in a dev container isn't collected.
- In a dev container, Claude Code's hooks don't reach the host, so permission prompts aren't recorded there (transcripts cover the rest).
- Sessions run while no core was running reach Snagboat only from transcripts, so their permission prompts are missing.
- Copilot's OpenTelemetry doesn't say which workspace it came from.
- Collecting from a dev container means changing its shared configuration (above). Watching the container through Docker instead, reading the volume where many dev containers already keep `~/.claude`, would need no change to the project. So would collecting Claude Code's own OpenTelemetry, though that needs the container to reach the host. Both are being considered (bead `snagboat-05p`).
