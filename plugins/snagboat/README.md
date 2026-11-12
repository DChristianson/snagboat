# Snagboat for Claude Code

This plugin brings Snagboat into Claude Code without VS Code: it records your sessions through Claude Code's hooks, keeps Snagboat's core running while you work, and gives you and the agent read-only access to what Snagboat sees.

## What it adds

| Part | What it does |
| --- | --- |
| Hooks | Send tool calls, failed tool calls, turn ends, and permission prompts to Snagboat, as VS Code's per-project hooks do. If a project (or your user settings) already has VS Code's Snagboat hook, the plugin's hook steps aside, so nothing is recorded twice. Hooks never block Claude Code, and the permission hooks run in the background, so they can't answer a prompt. |
| MCP tools | `snagboat_findings`, `snagboat_sessions`, `snagboat_session` and `snagboat_advisors`, for the workspace you're working in. All read only: the agent can read findings, sessions, outcomes and advisors' measures, never change them. |
| Slash commands | `/snagboat:findings`, `/snagboat:advisors [days]`, `/snagboat:sessions [days]`, `/snagboat:session <id>`, `/snagboat:open` (the advisor UI in your browser), and `/snagboat:statusline` (see below). |
| Status line | `snagboat statusline` prints the findings showing and today's tokens, cache rate and milestones. A plugin can't set Claude Code's status line, so `/snagboat:statusline` shows you the change to `~/.claude/settings.json` and asks before making it. |

At the start of each session the plugin keeps `~/.snagboat/bin/snagboat` pointing at its own copy of the Snagboat CLI, so the status line, and you in a terminal, can run it from a path that doesn't change when the plugin updates. If `~/.snagboat/bin/snagboat-hook` (the forwarder VS Code installs) is missing, it puts one there, so a project whose committed `.claude/settings.json` has VS Code's hook entry records sessions on this machine too; the plugin's own hooks step aside only when that forwarder is there. The `snagboat` command is also on the Bash tool's PATH while the plugin is enabled.

## Requirements

- **Node.js 24 or later**, as `node` on your PATH or in `SNAGBOAT_NODE`. Claude Code doesn't ship Node, and the MCP tools, slash commands and status line run the Snagboat CLI with it. Without it they say what's missing. The hooks need only `sh` and `curl`.
- macOS or Linux. Windows is not supported. It may work through Git Bash, with Git Bash's `sh` on your PATH, but it is untested.

## Install

Each [release](https://github.com/DChristianson/snagboat/releases) after 0.0.2 attaches `snagboat-claude-plugin-<version>.zip`. Download it and start Claude Code with it:

```sh
claude --plugin-dir snagboat-claude-plugin-<version>.zip
```

A marketplace listing comes later.

## Try it from this repository

```sh
npm ci
npm run build:plugin            # copies dist/snagboat.js into the plugin and writes hooks/forward.sh
claude --plugin-dir plugins/snagboat
```

Then run `/snagboat:findings` in a project. `claude plugin validate plugins/snagboat` checks the plugin's files, and `npm run package:plugin` builds the release's zip.

## Privacy

Everything stays on your machine, as in the rest of Snagboat (see [PRIVACY.md](../../PRIVACY.md#the-claude-code-plugin)). The hooks record a tool's name, its target (a file path or a command line) and whether it succeeded, never its output; the permission hooks record only the tool's name. The MCP tools read from Snagboat's core on 127.0.0.1 and return text to the agent: findings, session summaries (including a session's name when one was recorded), outcomes and measures, never prompts or replies.
