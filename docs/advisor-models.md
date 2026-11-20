# Advisor models

The built-in advisors need no model: their measures and Snagboat's findings are computed from the event log. A model is optional. When you add one, it explains what happened and proposes changes. This page is about that model.

## What you can ask

**Explain** asks a model you choose what happened in a session, a turn, or a finding, and shows its answer beside the session, labelled as model output. Use the **Explain session** button in the Sessions tab, **Explain turn** on a selected prompt, **Explain** on a finding, or **Snagboat: Explain Session...**.

**Performance reports**: a goal advisor whose `persona.md` names a `model` has that model write its report each period: a short summary, a verdict on each running experiment, and at most three proposed rule changes for you to accept, discard or revise ([usage](usage.md#performance-reports)). Each proposal is checked against what the advisor may change and what you discarded, and nothing changes until you accept.

**Setting up an advisor**: on the advisor UI's **+** page, a model talks your goal through with you and proposes an advisor for it.

## Local, hosted, and what is sent

- **Local by default.** `snagboat.advisor.providers` starts with one provider: Ollama at `http://localhost:11434/v1`, with `llama3.1:latest` (`ollama pull llama3.1`) and a 32,768-token context window, asked through Ollama's own chat endpoint since its OpenAI-compatible one can't set the window. Any OpenAI-compatible server on this machine works (LM Studio, llama.cpp). With no model set, Snagboat lists the server's models the first time you use it.
- **Hosted only if you add one.** A provider at any other address must use https and needs your API key, set with **Snagboat: Set Advisor API Key...** and kept in VS Code's secret storage. Every request to it is recorded in a local audit log.
- **Several advisors, if you like.** `snagboat.advisors` lists advisors with the abilities each offers (summarize a session, report on a goal, set up an advisor) and what each may receive per ability. `snagboat.advisor.defaults` picks the one Explain uses, and **Snagboat: Explain Session with Advisor...** asks another. See [settings](settings.md#installed-advisors).
- **The model sees a digest, not your log.** The digest is a summary built for one request:
  - shell commands become their category and command name (`tests-builds: npm`);
  - paths are made relative to the workspace, or hashed;
  - prompts and session names go to local providers only, unless you allow more per provider (`send`);
  - reply excerpts go nowhere unless you allow them.

  The model gets no tools, so it can only answer.
- **Small local models** may cut a whole session's digest to fit their context window. Explain warns when that happens. For Ollama, a larger window (`OLLAMA_CONTEXT_LENGTH=16384 ollama serve`) fixes it, and explaining one turn or finding sends far less.
- **You see it first.** Before a provider's first request, and again whenever its address or sending rules change, Snagboat opens the exact payload and asks. **Snagboat: Preview Advisor Digest...** shows a session's digest as any provider would get it.

The core, which writes reports and serves the advisor UI, asks only models on this machine. Hosted advisors stay in VS Code, for Explain ([usage](usage.md#the-advisor-ui-preview)). Exactly what each ability sends is in [PRIVACY.md](../PRIVACY.md#the-advisor).
