# Advisor models

The built-in advisors need no model: their measures and Snagboat's findings are computed from the event log. A model is optional. When you add one, it explains what happened and proposes changes. This page is about that model.

## What you can ask

**Explain** asks a model you choose what happened in a session, a turn, or a finding, and shows its answer beside the session, labelled as model output. Use the **Explain session** button in the Sessions tab, **Explain turn** on a selected prompt, **Explain** on a finding, or **Snagboat: Explain Session...**.

**Ask the advisor**, in the Suggestions tab, gives discovery's candidates plain names, summaries, and suggested actions, proposes up to three rules of its own, and groups your shell commands into categories ("Network" for `curl` and `wget`). Each is checked like a rule you'd write, scored by replaying your history, and marked as the advisor's. Nothing is saved until you accept. After **Snagboat: Write Review**, **Ask the Advisor** adds a model's judgment to the review.

## Local, hosted, and what is sent

- **Local by default.** `snagboat.advisor.providers` starts with one provider: Ollama at `http://localhost:11434/v1`. Any OpenAI-compatible server on this machine works (LM Studio, llama.cpp). With no model set, Snagboat lists the server's models the first time you use it.
- **Hosted only if you add one.** A provider at any other address must use https and needs your API key, set with **Snagboat: Set Advisor API Key...** and kept in VS Code's secret storage. Every request to it is recorded in a local audit log.
- **Several advisors, if you like.** `snagboat.advisors` lists advisors with the abilities each offers (summarize a session or the week, propose heuristics, propose nudges) and what each may receive per ability. `snagboat.advisor.defaults` picks the one used, and **Ask another advisor** offers the rest. See [settings](settings.md#installed-advisors).
- **The model sees a digest, not your log.** The digest is a summary built for one request:
  - shell commands become their category and command name (`tests-builds: npm`);
  - paths are made relative to the workspace, or hashed;
  - prompts and session names go to local providers only, unless you allow more per provider (`send`);
  - reply excerpts go nowhere unless you allow them.

  The model gets no tools, so it can only answer.
- **Small local models** may cut a whole session's digest to fit their context window. Explain warns when that happens. For Ollama, a larger window (`OLLAMA_CONTEXT_LENGTH=16384 ollama serve`) fixes it, and explaining one turn or finding sends far less.
- **You see it first.** Before a provider's first request, and again whenever its address or sending rules change, Snagboat opens the exact payload and asks. **Snagboat: Preview Advisor Digest...** shows a session's digest as any provider would get it.

The advisor UI in your browser asks only models on this machine. Hosted advisors stay in VS Code ([usage](usage.md#the-advisor-ui-preview)). Exactly what each ability sends is in [PRIVACY.md](../PRIVACY.md#the-advisor).
