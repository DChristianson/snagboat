# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue for a security problem.

Include what an attacker could do, the steps to reproduce, and the Snagboat version or commit. You can expect an acknowledgement within a week. Fixes go into the latest version on `main`; older versions aren't patched separately.

## What's in scope

Snagboat runs inside VS Code and talks only to processes on your own machine. The areas where a security problem would matter most:

- **Local HTTP receivers.** Each VS Code window runs a Claude Code hook receiver on an OS-assigned port, and one window runs a Copilot telemetry receiver on port 4318 (configurable). Both bind to `127.0.0.1` only.
- **The hook forwarder** `~/.snagboat/bin/snagboat-hook`, which Claude Code runs after every tool call, and the route files in `~/.snagboat/routes/`.
- **Changes Snagboat makes outside its own storage**, namely the hook entries it adds to each project's `.claude/settings.json`.
- **The detail view webview**, which renders event data (file paths, shell commands, reply excerpts) and can open files.
- **Stored data**: what Snagboat records and keeps is described in [PRIVACY.md](PRIVACY.md).

## Design and known limitations

- **Hook receivers require a token.** Each window generates a random token at startup and publishes it only in owner-readable (`0600`) route files. Requests without it are rejected, as are hooks for projects outside the window's workspace.
- **The Copilot receiver does not authenticate requests.** Copilot's exporter can only be given an endpoint URL, so there is no token to check. Any process that can connect to `127.0.0.1:4318`, including another user's process on a shared machine, can submit fake Copilot events, which would show up in that window's counts and findings. It can't read anything back. Per-window Copilot routing, which would allow a check, is on the [roadmap](docs/roadmap.md).
- **Processes running as you are trusted.** Anything running under your user account can already read Snagboat's storage, route files, and tokens, and Claude Code's own transcripts. Protecting against your own processes is out of scope.
- **The detail view** uses a strict Content Security Policy with a per-load nonce, writes event data as text (never as HTML), and opens a file only after the extension itself confirms it exists.
