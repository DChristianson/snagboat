# Snagboat

Observability for AI developers: see what your coding agents cost, what they return, and how that tracks against the goals you set for your project.

In the 1800s, [snagboats](https://en.wikipedia.org/wiki/Snagboat) worked rivers like the Mississippi, pulling out the sunken trees ("snags") that no pilot could see from the deck. This one does the same three jobs for agent sessions:

- **It warns of hidden danger.** An agent looping on a failing test, churning through tool calls, stalled on a prompt, or quietly filling its context gets flagged while it's happening.
- **It helps you steer in the moment.** The warning arrives where you work, in your CLI or editor, with what to try.
- **It clears the channel.** AI advisors measure what came back (commits kept, tests green, milestones closed) against what you spent (attention, clock time, tokens), and tune the rules from your feedback so next week runs faster.

How much of this you want depends on the project, and that is what the personalization is for. In **shallow draft**, you work alongside a single agent and want to hear early when it drifts. In **deep water**, many agents run in parallel with permissions off (YOLO), and you want to hear only about the one that needs you, and what the fleet returned. Goals, advisors, rules and thresholds are yours to set for each.

It's built around my own workflow, so it targets **Claude Code and GitHub Copilot**, from the Claude Code CLI, VS Code, or a browser. Cursor, Codex and others aren't watched yet. Data stays in plain files on your machine; only what you choose to release ever leaves it.

![The advisor UI in a browser: cards for Purser, Navigator, Bosun and Lookout, each with its goal and how its measures moved this week against last. Navigator shows the agent's plan and a live finding, "npm test failed 3 times in this turn", with Useful, Acknowledge and Mute buttons.](docs/images/advisor-ui.png)

## Advisors

An advisor is an AI model that owns one goal. You decide which goals matter, and so who your advisors are and how many. Snagboat starts you with four:

| Advisor | Goal | Example measurements |
| --- | --- | --- |
| Navigator | Waste less clock time | Milestones per session, active minutes per milestone, minutes from a failing test to green |
| Lookout | Keep you focused | Notifications per hour, warnings dismissed or marked useful |
| Bosun | Limit unsafe tool use | Risky commands, permission approvals per session |
| Purser | Spend fewer tokens | Tokens per milestone, tokens per commit kept, cache hit rate |

Each one reports this week against last, explains a session or warning when asked, and proposes rule changes. Proposals are tested against your own history and listed as **Suggestions** to accept or dismiss. When a warning clears, Snagboat records how you met it (marked useful, acknowledged, muted, or let pass), and advisors learn from that.

- Measurements and warnings are computed without a model, so they're repeatable. The model interprets them.
- A model is optional. It runs locally (Ollama, LM Studio) by default, which keeps everything private. A hosted model is more capable; it gets a redacted summary that you approve first, and no tools ([advisor models](docs/advisor-models.md)).
- An advisor is a Markdown file: goal and measurements on top, voice below. Edit one or add your own ([usage](docs/usage.md#advisors-and-their-goals)).
- Cost is counted in tokens, not dollars. A milestone is a commit made after the session's tests pass. Commits kept and milestones need the per-user store, a preview setting that pools every project's data.

## Warnings

A warning is called a **finding**. Findings come from **heuristics**: rules that each watch for one kind of trouble, such as a command that keeps failing, a prompt that sets off hundreds of tool calls, or a context that is nearly full. Most judge one **turn**: a prompt and everything the agent does in answer to it.

Say three Claude Code sessions are working on separate tasks while you review a pull request. In one of them, `npm test` fails a third time, and Snagboat raises a finding: "npm test failed 3 times in this turn". The other two stay quiet, so you know which one needs you. You open the session, see what the turn has cost, and re-prompt with what it was missing.

Heuristics need tuning. A threshold that suits one supervised agent is noise for a fleet running unattended. Your advisors suggest tunings based on how the findings have gone for you, and if the findings still aren't helping, you change the advisors' goals. The built-in heuristics, their defaults and what to try for each are in [heuristics](docs/heuristics.md).

## Install

> **Before you install**
>
> - The VS Code extension adds five hook entries to `.claude/settings.json` in each project you open in VS Code, so Claude Code can report what it did. **Snagboat: Remove Claude Code Hooks from Project...** takes them out.
> - It stores your prompts and the agents' replies for 30 days, with common secret formats redacted, and full shell commands (which can contain secrets) for 90. Turn off `snagboat.captureContent` to store no text.
> - While its background service runs, it records Claude Code and Copilot sessions in every project on the machine, not only those open in VS Code ([PRIVACY.md](PRIVACY.md#what-is-captured)).

**Claude Code** (preview; Node.js 24+). Download the plugin zip from the [latest release](https://github.com/DChristianson/snagboat/releases/latest). It records sessions and adds `/snagboat:` commands, read-only tools for the agent, and a status line ([plugin](plugins/snagboat/README.md)):

```bash
claude --plugin-dir snagboat-claude-plugin-0.0.3.zip
```

**VS Code** (1.145+). Download the `.vsix` from the same release, install, and reload your windows:

```bash
code --install-extension snagboat-0.0.3.vsix
```

Neither agent needs setup, except counting Copilot's inline-suggestion tokens ([Copilot setup](docs/usage.md#copilot-setup)). Building from source: [CONTRIBUTING.md](CONTRIBUTING.md).

## Where it shows up

| Place | What's there |
| --- | --- |
| Status line (Claude Code), status bar (VS Code) | Today's tokens and the findings showing |
| Agent tools and `/snagboat:` commands (Claude Code) | Findings, sessions and advisors' measurements, for you or the agent to read |
| Command line | `snagboat sessions`, `findings`, `advisors` and more, with `--json` for scripts and agents ([CLI](docs/cli.md)) |
| Advisor UI (browser; `/snagboat:open`) | Advisors' measurements and Suggestions |
| Weekly review | A Markdown report of usage, findings and advisors' progress |
| Detail view (VS Code) | Findings, a daily token chart, and each session's turn tree and context timeline |

Underneath is one event log. Claude Code and Copilot activity is normalized into a single event shape ([schema](docs/schema.md)), so every warning and view works for both. It's saved as daily JSONL (one JSON record per line), readable with `jq`, DuckDB or a notebook.

## Status

Early but working: version `0.0.3`, [MIT license](LICENSE). macOS and Linux. Windows isn't supported.

More docs: [usage](docs/usage.md) · [settings](docs/settings.md) · [heuristics](docs/heuristics.md) · [CLI](docs/cli.md) · [architecture](docs/architecture.md) · [privacy](PRIVACY.md) · [security](SECURITY.md) · [roadmap](docs/roadmap.md) · [changelog](CHANGELOG.md)
