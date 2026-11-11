# README newcomer check

A repeatable check that the README answers what a newcomer asks. It gives Claude Haiku the README and nothing else, asks the questions below, and fails if the page doesn't answer one or Haiku is unsure.

It started from a review: Haiku, given only the README, explained what Snagboat is correctly, but couldn't say what to do when a finding fires, met terms the page never defines, and missed facts the page leaves out (license, platforms, which agents). These questions are that review, made repeatable.

## How to run it

By hand, from the repo root:

```sh
npm run check:readme
npm run check:readme -- --out docs/design/readme-check/<name>.json   # also save the answers
```

It needs the Claude Code CLI (`claude`) on `PATH` and logged in, and it costs a few cents of tokens per run, so it's not in CI. Run it after changing the README.

The script ([scripts/readmeCheck.js](../../scripts/readmeCheck.js)) runs `claude -p --model haiku` with no tools (`--tools ""`), no MCP servers, no settings files or slash commands, its own system prompt, and an empty temporary folder as the working directory, so Haiku can't read anything but the README text in the prompt. It asks for JSON (`--json-schema`): per question an answer and a confidence (`high`, `medium`, `low`), with the literal marker `NOT IN PAGE` when the README doesn't say.

It prints one row per question (number, confidence, whether it's in the page, pass or fail) and the failing answers. A question fails on `NOT IN PAGE` or `low` confidence; any failure exits non-zero. Haiku's answers vary a little between runs, so read a single failure before acting on it.

The questions are read from the numbered list below, so edit them here.

## Questions

1. What is a "finding"?
2. What is a "heuristic" in this project? Name two in your own words.
3. What is the "advisor"? Is it required? Does it send my code to the cloud?
4. What is a "turn"?
5. What does "normalized event log" mean here, and why would I care?
6. Does it work with Cursor, Codex, or Windows?
7. What does the snagboat name mean, and why was it chosen?
8. Does installing it change any files in my repo? Which?
9. What does the Explore tab do, and can I try anything without installing?
10. What is discovery / the Suggestions tab?
11. What does `cache-thrash` mean, and what should I do when it fires?
12. Is it free / what's the license? Is it stable?
13. What's the one-sentence pitch of this project?
14. Would a new user know what to do when a warning appears?

## Results

Saved runs are in [readme-check/](readme-check/), one JSON file per run with every answer.
