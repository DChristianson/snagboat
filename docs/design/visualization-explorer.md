# Design: visualization explorer

Status: **accepted** (2026-11-03; decisions confirmed the same day). The visualization part of [phase 7](trusted-advisor.md#phases) of the advisor design, and the "visualizing sessions" half of the [prototype task](../roadmap.md#planned-tasks) in the roadmap. Steps 1–5 are built (2026-11-03); where the build differed from the text, the [implementation notes](#implementation-notes) at the end say how. Step 6 has built [every view this document names, and thirteen more](#built-so-far) from the proposal's tables; the rest of the proposal remains a catalog to draw from.

## Summary

The Sessions tab shows one session two ways: a turn tree (icicle) above a context timeline. Those were the first two of many possible views, and the roadmap planned to try alternatives as throwaway pages over exported history. This design puts the comparison inside Snagboat instead: an **Explore** tab in the detail view holds a horizontal carousel of *visualizers*. Every visualizer takes the same input, one or more sessions, and draws them its own way, and every one declares **tags** that place it in a small taxonomy (what kind of question it answers, whether it informs or expresses, what level it works at, and which dimensions it highlights). A floating **puck** in a corner of the page names the visualizer you're looking at, lists its tags, and lets you narrow the carousel to visualizers with the tags you pick.

The two existing views move into the carousel as its first two visualizers, so the explorer starts with real content and the Sessions tab stops owning them. The tab is labeled experimental: it's a place to try views and compare them on real data, and whatever earns its keep later moves into the Sessions tab or replaces it.

## Problems this addresses

1. **Comparing views needs the same data in front of you.** Throwaway pages over a fixture each reinvent loading, colors, and tooltips, and never see a live session. Inside the detail view a new visualizer is one file, and gets the sessions, the theme, and the helpers for free.
2. **Only one session at a time.** Every question across sessions ("which of this week's sessions was the costly one", "does context fill up the same way each time") has no view today. The explorer's contract is a *list* of sessions from the start.
3. **No vocabulary for what a view is for.** Without one, the set of views grows by whim. Tags make the choice explicit (temporal versus quantitative, informative versus expressive, one session versus a project), show gaps in the set, and give the puck something to filter on.

## Goals

- One contract for visualizers: a list of sessions in, a rendering out, plus declared tags.
- The turn tree and the context timeline ported to that contract, with the Sessions tab drawing them through the same code.
- A carousel to move between visualizers, and a puck to see and filter by tags.
- Two or three new visualizers that take several sessions, to prove the contract and the taxonomy on more than the two views that shaped them.
- The same rules as the rest of the page: plain DOM and SVG, no framework, no dependencies, `textContent` only, nonce CSP, both themes.

## Non-goals

- Replacing the Sessions tab. The explorer is experimental; promotion is a later decision.
- New data. Visualizers draw what `SessionView` already carries. A view that needs a new field proposes it in its own change.
- The preferences prototype (the other half of the roadmap task). It stays separate.
- Screenshots for vision models and the presentation review's checks over the explorer (phase 7, later).
- A hosted service of any kind. The web demo is a static page that reads files you choose and sends nothing.

## The visualizer contract

A visualizer is a plain script in `media/viz/` that registers itself:

```js
window.snagboatViz.register({
  id: 'turn-tree',
  title: 'Turn tree',
  description: 'Where the tokens went: by prompt, then agent, then tool category.',
  tags: { category: ['quantitative', 'actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor', 'hierarchy'] },
  mount(host, ctx) {
    // Build the DOM once under host. ctx has the shared helpers (el, svg, compact, fmt, tooltip, ...),
    // and ctx.select(selection) to announce a selection.
    return {
      update(sessions, selection) {}, // Redraw for these SessionViews and the shared selection.
      resize() {},                     // The slide's width changed.
      destroy() {},
    };
  },
});
```

- **Input** is `SessionView[]`, exactly what `buildSessionView` produces per session today, so every visualizer sees prompts, calls, compactions, subagents, marks, findings, and the tree.
- **Selection** is shared across the carousel: `{ sessionId?, turnId?, range?: [fromMs, toMs] }`. Moving from the turn tree to the timeline keeps the turn you clicked; a visualizer may ignore it. This is what makes the carousel an explorer rather than a slideshow.
- **Catalog and tags live in TypeScript**, in `src/ui/visualizers.ts`: the taxonomy (facets and their vocabularies) and one catalog entry per visualizer (id, title, description, tags). The extension sends them to the page with the sessions. The registry in the page matches each catalog entry to a registered renderer by id and lists any mismatch in the puck, so a visualizer with no catalog entry, or an entry with an unknown tag, is caught in unit tests, not on screen. The JS side keeps `title` and `tags` only as a convenience for reading the file; the catalog wins.
- **Drawing rules** come from the rest of the page: the theme variables in `detail.css`, the five category colors and two turn shades from the turn tree, and the series colors of the daily chart. A visualizer that needs a new color adds it to the validated set in `detail.css`, not inline.

### Taxonomy

Four facets. Values within a facet are not mutually exclusive: a visualizer gives one or more per facet, and every facet must be given, so filters never silently miss a visualizer.

**Category**: the kind of question the visualization answers.

| Value | Question |
| --- | --- |
| `temporal` | When did something happen, and for how long? |
| `actor` (actor / topology) | Who interacted with whom? |
| `conversational` | What was communicated, and in what sequence? |
| `dependency` (dependency / causality) | What depended on what? |
| `quantitative` | How much, how often, how expensive? |
| `state` (state / process) | What state was the system in, and how did it change? |
| `semantic` (semantic / conceptual) | What was the content about, and how did ideas relate? |

**Purpose**: what the visualization is designed for.

| Value | Designed primarily to |
| --- | --- |
| `informative` | communicate precise information, support inspection, or enable diagnosis |
| `expressive` | communicate patterns, scale, complexity, activity, or structure through an engaging visual |

**Level**: what the visualization works over. Only these two for now; other levels (a turn, a day, all workspaces) can come later.

| Value | Meaning |
| --- | --- |
| `session` | One continuous conversation or workflow |
| `project` | Multiple sessions within a project (a workspace) |

`level` also tells the carousel how to hand a visualizer the sessions picked. A `session`-only visualizer gets them one at a time: the slide stacks one drawing per session, each under a header with the session's name, so three sessions picked are three context timelines down the slide. A `project` visualizer gets the whole list, and with a single session picked it draws that one without complaint. A visualizer tagged both decides for itself (the turn tree draws a forest).

**Dimension**: the dimensions the visualization highlights. Not a strict or scientific list; it changes as views are added, and that's the facet where new values are expected first.

`time`, `actor` (human, agent, tool), `hierarchy`, `dependency`, `communication`, `quantity` (cost), `content` (what was said; added with prompt terms)

The first visualizers, tagged:

| Visualizer | category | purpose | level | dimension |
| --- | --- | --- | --- | --- |
| Turn tree (ported) | quantitative, actor | informative | session, project | quantity, actor, hierarchy |
| Context timeline (ported) | temporal, quantitative, state | informative | session | time, quantity |
| Session strips (new) | temporal, state | expressive, informative | project | time |
| Cost per prompt (new; deferred from the [conversation view](conversation-view.md)) | quantitative, conversational | informative | session, project | quantity, actor |
| Context fill (new) | state, quantitative | expressive, informative | project | time, quantity |

None of the first five is `semantic` or `dependency`, and none highlights `communication`. The views that fill those gaps come from the [visualization proposal](agent_conversation_visualization_design_proposal.docx), which lists candidates per category (see [More visualizers](#more-visualizers-from-the-proposal)); the first `semantic` view needs prompt text, so it depends on text capture being on. The proposal's categories are this taxonomy's `category` facet, and its informative, expressive, and hybrid purposes map onto `purpose`, with hybrid meaning both values.

## The Explore tab

A fourth tab after Suggestions, labeled **Explore (experimental)**. Its parts, top to bottom:

- **Session picker.** Every retained session in one scrolling list, newest start first, with the Sessions tab's rows and a checkbox each, and no day filter, so sessions from different days can be compared; **Load** sends the picked ids to the extension. Up to 8 sessions, since every `SessionView` carries all of a session's calls and prompts. The session open in the Sessions tab is pre-checked the first time, so "explore this session" is one click.
- **Carousel.** One slide per visualizer in the catalog's order, each the full width of the page, in a horizontally scrolling strip with scroll snapping. Previous and Next buttons, the arrow keys when the strip has focus, and a row of dots that name each slide. The strip takes the height left in the window (at least 320px) so the controls under it stay in view; a drawing taller than that scrolls inside its slide, under the slide's header. Only the current slide and its two neighbors are mounted and updated, so a slow visualizer doesn't slow the page while it's offscreen. The current slide is whichever an `IntersectionObserver` reports as mostly visible.
- **Slide.** The visualizer's title and description as a header, then its host element. For a `session`-only visualizer the carousel mounts one instance per picked session, stacked, each under the session's name; a `project` visualizer gets one instance with every session. No slide ever says it can't draw.
- **Puck.** A floating rounded rectangle fixed to a corner of the window (bottom-right until moved), above the tooltip layer. It shows the current visualizer's title, description, and tags as chips grouped by facet (category, purpose, level, dimension), with the chips of every facet value in the catalog shown dimmed so the whole vocabulary is visible. Clicking a chip toggles it as a filter: within a facet, picked values are ORed; across facets, ANDed. Slides that don't match leave the carousel, the dots and count follow, and if the current slide leaves, the carousel moves to the nearest that stays. A **Clear** link resets filters, and a collapse button shrinks the puck to a small circle with its title so it doesn't cover a chart; it starts that way. Dragging its head (the whole circle when collapsed) drops it in the corner of the quadrant it's let go in, and the arrow keys do the same from its toggle. The carousel's controls stand on the side away from it and draw above it.

**State:** the picked session ids, the current visualizer, the filters, whether the puck is collapsed and which corner it's in, and the shared selection persist in the webview's state, as the other tabs' state does, so the tab reopens where you left it.

**Updates:** the picked sessions are loaded when you press Load, and the extension keeps them current from live events exactly as it does the Sessions tab's open session (each session gets its own replay for past findings, so loading 8 sessions costs 8 replays, once). The page redraws the current slide on each push, debounced as the rest of the page is.

### Extension side

- `SessionController` grows from one open session to a small set: `open(sessionId)` stays for the Sessions tab, and `explore(sessionIds)` loads the rest the same way (read from the days' files once, then `ingest` keeps them current). The Sessions tab's open session is always a member, so the two tabs share one copy.
- `ExplorerState` (`src/ui/explorerModel.ts`, vscode-free): `{ taxonomy, catalog, sessions: SessionView[], notLoaded: string[] }`, built from the controller and sent whole on the `explorer` message, the way `sessions` and `session` are today.
- Messages: `tab: 'explore'`, `explore: { sessionIds }`, and `closeExplorer`. `isDetailMessage` gains the three cases; `DetailTab` gains `'explore'`; `navigate` learns the tab.
- Unit tests: the catalog conforms to the taxonomy (every facet given, every value in the vocabulary, ids unique); `ExplorerState` carries the sessions in the order picked and names the ones no longer retained; the controller keeps the Sessions tab's session when the explore set changes.

## Porting the turn tree and the context timeline

Both become visualizer modules, `media/viz/turnTree.js` and `media/viz/contextTimeline.js`, and `sessions.js` draws them through the same `mount`/`update` interface with its own selection state (`focusId`, `selectedTurn`, `zoom`, `expanded`) mapped onto the shared selection. The Sessions tab's behaviors move with them: click to zoom, the breadcrumb (driven by the selection the tree emits), prompt rules selecting a turn, drag to zoom when expanded. `expanded` becomes an option the Sessions tab passes and the explorer doesn't.

The multi-session turn tree is the one real change: with several sessions, the root is a `sessions` node whose children are the sessions' trees, widths by tokens, labeled with the session's name or short id, so the same zoom-by-click compares sessions at the top level and drills into one below. `buildSessionView` is unchanged; the forest is assembled in the visualizer.

The context timeline stays at the `session` level in this phase, so with several sessions picked the carousel stacks one timeline per session, each on its own time axis. A shared axis across sessions is the **context fill** visualizer's job in the list above (by call sequence, where sessions line up; the clock-time version is the session strips).

The alternative, copying the two renderers into the explorer and leaving `sessions.js` alone, was considered and set aside: the explorer is where the views will change next, and two copies would drift the week after. The cost is that the Sessions tab is touched, and its look is checked by hand (there are no unit tests over `media/`).

## New visualizers

Three, chosen because `SessionView` already has everything they need and together they exercise the `project` level, the `expressive` purpose, and the `state` category:

- **Session strips.** One row per session, x is clock time over the union of their spans, each turn a block (two alternating shades, as the tree), compactions as ticks, findings as the badges the timeline uses. Hover gives the turn's prompt text and tokens; click selects the turn. Answers "what happened when, across sessions", and shows idle gaps, which the tree can't.
- **Cost per prompt.** One column per turn, tokens stacked by agent (main, subagents) or by tool category, sessions side by side as small multiples with a shared y axis. Answers "which prompts were expensive", the view deferred by the conversation view; its mockup generator is still in `docs/design/images/generate_mockups.py`.
- **Context fill.** Context size per main-agent call, x is the call's index, one line per session, compactions marked, each model's largest-seen and limit as the timeline draws them. Sessions line up by progress rather than clock, so their shapes compare.

Each follows the [dataviz](#references) rules the existing charts follow: one axis, categorical hues in fixed order, a legend for two or more series, a hover layer, and the theme's colors.

## A web demo on GitHub Pages

The visualizers should also run on a static page attached to the repository, so they can be shown without installing the extension, over synthetic sessions by default, and over a person's own Snagboat data loaded from their disk into the browser without anything leaving it. The page is files only: HTML, CSS, and scripts served by GitHub Pages, with no server of Snagboat's behind it.

The same scripts then run in two places, the detail view's webview inside VS Code and an ordinary browser tab. The two differ only in where sessions come from and where a little state is kept.

**What's shared.** Three layers, two of which already have no VS Code in them:

| Layer | Where | In the webview | On the page |
| --- | --- | --- | --- |
| Visualizers (`media/viz/*.js`) and the carousel and puck (`media/explore.js`) | Plain scripts; they see only `ctx` (the helpers, the tooltip, `select`) and the source object below | As today, via script tags | Copied as-is into the site |
| The session model: `buildSessionView`, `SessionIndex`, `contextSize`, the catalog and taxonomy, `FindingReplay` with the built-in heuristics and their default settings | TypeScript under `src/core`, `src/ui`, `src/heuristics`, none of it importing `vscode` or `fs` | In the extension process | Bundled by esbuild (`platform: 'browser'`, a second entry `src/web/main.ts`) into one script the page loads |
| The source: where sessions come from and where state is kept | `media/explore.js` talks to a small source object: `listSessions()`, `loadSessions(ids)`, `getState()`, `setState()` | `postMessage` to the extension, `vscode.getState` | An in-browser index built from loaded files, `localStorage` for the small state |

The parts that touch disk (`EventLog`, `ContextLimits`, `RuleStore`, the adapters' tailers) stay out of the bundle. The page replaces them with a reader of `File` objects, builds context marks in memory from the events it loaded (largest seen always; a limit only where an auto-compaction or context error was seen), and uses the heuristics' defaults rather than anyone's settings.

**Loading your own data.** A file input and a drop zone take the daily files Snagboat writes, `events/YYYY-MM-DD.jsonl` under the workspace's storage folder (a **Snagboat: Reveal Event Log Folder** command makes that folder easy to find; an export command would be the same thing with a nicer name). The page parses them with `FileReader`, builds the session index and views, and holds everything in memory only: nothing is fetched, posted, or stored, and reloading the page starts empty. A later option is loading raw Claude Code transcripts the same way, since the adapter's normalizer is also VS Code-free; it isn't needed to start.

**The promise, and how it's kept.** The page's `<meta http-equiv="Content-Security-Policy">` sets `default-src 'self'` and `connect-src 'none'`, so a script can't make a network request even by mistake; there is no analytics, no service worker, and no third-party script. [PRIVACY.md](../../PRIVACY.md) gets a paragraph saying the demo page reads files you choose, in your browser, and sends nothing. GitHub still sees the page request itself, as for any site, but none of the loaded data. Prompt text in loaded files is in page memory for as long as the tab is open, like in the webview.

**Synthetic data.** With nothing loaded the page shows a few generated sessions, produced by a small generator in `src/web/` that the wireframe's generator becomes, labeled as examples. The redacted transcript fixture in `src/test/fixtures` is a candidate for a realistic one once transcript loading exists.

**Build and deploy.** A `pages.yml` workflow (`actions/configure-pages`, `upload-pages-artifact`, `deploy-pages`) runs `npm run build:web`, which bundles the entry and copies `media/viz/`, `media/explore.js`, the stylesheet, and `web/index.html` into `out/web/`. Nothing generated is committed. The stylesheet is `detail.css` itself: it reads VS Code's `--vscode-*` variables, so the page defines those variables for light and dark (from `prefers-color-scheme`) and the same CSS draws the same charts.

**What it costs.** Nothing to run: there is no server. The cost is in upkeep, since the same scripts now have to work in two places, the webview and a browser tab, and a change made with one in mind can break the other. The bundle build type-checks the model code, and the webview is checked by hand as before; a page that breaks shows up when the workflow's build fails or when someone opens it, not in a unit test. Keeping the visualizers ignorant of where they run (no `acquireVsCodeApi`, no `postMessage`, nothing but `ctx` and the source object) is the rule that keeps this cheap, and it's the same rule the catalog already imposes.

## Steps

1. **Model and catalog — done.** `src/ui/visualizers.ts` (taxonomy and catalog), `src/ui/explorerModel.ts`, the controller's session set, the messages, and their unit tests. Nothing visible yet.
2. **Explore tab — done.** `media/explore.js` (tab, picker, carousel, puck, registry, behind the source object) and the two ported visualizers under `media/viz/`, with `sessions.js` drawing through them. Checked by hand in both themes: the Sessions tab looks and behaves as before, and the explorer shows the same two views for the same session.
3. **New visualizers — done.** Session strips, cost per prompt, and context fill, one at a time, each a file under `media/viz/` and a catalog entry.
4. **Web demo — done.** The browser bundle, the page with its file loader and synthetic sessions, the Pages workflow, the Reveal Event Log Folder command, and the PRIVACY.md paragraph. It can start as soon as step 2 is in, in parallel with step 3.
5. **Docs — done.** A section in [usage.md](../usage.md), the detail webview paragraph in [architecture.md](../architecture.md), a link to the demo from the README, and the roadmap entry marked done; this document gains implementation notes where the build differed.

6. **More visualizers, from the proposal.** After step 5, more views are added starting with the ones listed per category in the [visualization proposal](agent_conversation_visualization_design_proposal.docx) (see below). Each is its own change: a file under `media/viz/`, a catalog entry, and a note here. None is built before step 5.

Steps 1 and 2 are one pull request (the tab is empty without the catalog); the rest follow as the views land.

## More visualizers, from the proposal

The [visualization proposal](agent_conversation_visualization_design_proposal.docx) (in `docs/design/`, 2026-11-03) is the catalog of views to consider, organized by the seven categories of the `category` facet, each view marked informative, expressive, or hybrid. Step 6 works from it. Its closing recommendation names the most useful initial set, which is the order to start in, after the five in this design:

| From the proposal | category | purpose | What Snagboat has for it |
| --- | --- | --- | --- |
| Gantt or trace waterfall | temporal | informative | Turns, calls, subagent spans, tool calls with timestamps; waiting time is visible once [phase 8](trusted-advisor.md#phases) labels quiet gaps |
| Sequence diagram | conversational | informative | Prompts, replies, tool calls and results, subagent starts and ends, per turn |
| Actor interaction graph (force-directed, Sankey, or adjacency matrix) | actor | hybrid | Human, main agent, subagents, tools, models; edges typed as delegation, tool call, or message, as the proposal insists |
| Event or dependency graph | dependency, conversational | hybrid | Event order and turn membership today; dependency edges need links from tool calls to the model call that requested them, which not every source gives, so inferred edges are drawn as inferred |
| Treemap of tokens or cost | quantitative | hybrid | The turn tree's data, by another layout |
| Heatmap of aggregate patterns | quantitative, temporal | hybrid | Sessions by hour, tool by category, findings by heuristic and day, at the `project` level |

Four views named in earlier drafts of this design belong in step 6 too. Two are in the proposal's tables already: a **treemap of tokens by tool category across sessions** is its treemap, and an **agent-and-subagent graph** of who delegated to whom is its hierarchical tree or force-directed graph with delegation edges. Two are not, and are added here: a **tool-call ribbon** showing which tool category followed which within turns (dependency, conversational / hybrid / session / dependency, communication), nearest to the proposal's alluvial diagram but over transitions rather than stages, and the **week-in-one-picture** from the advisor's [abilities](trusted-advisor.md#abilities) (temporal, quantitative / expressive / project / time, quantity), nearest to its calendar heatmap but one picture of a week's sessions by day and hour, with tokens and findings, rather than a longer-period grid. Findings by heuristic and day, also from an earlier draft, is the heatmap row above.

### Built so far

These four were taken ahead of the order above, because each fills a gap in the taxonomy: no view was `semantic` or `dependency`, `actor` and `conversational` were only secondary tags, and nothing highlighted `communication`.

| Visualizer | category | purpose | level | dimension |
| --- | --- | --- | --- | --- |
| Sequence diagram | conversational, actor | informative | session | communication, actor, time |
| Event graph | dependency, conversational | expressive, informative | session | dependency, communication |
| Actor graph | actor | expressive, informative | session, project | actor, communication, quantity |
| Prompt terms | semantic | expressive | session, project | content |

They needed `SessionView` to carry each tool call (name, category, status; never its target or arguments) and each model call's reply excerpt.

#### Later additions

From the recommended order and the views named in earlier drafts, then the views in the proposal's tables that `SessionView` can already feed, each its own pull request:

| Visualizer | category | purpose | level | dimension |
| --- | --- | --- | --- | --- |
| Gantt and waterfall | temporal | informative | session | time, actor, hierarchy |
| Treemap | quantitative | expressive, informative | session, project | quantity, hierarchy |
| Heatmap | quantitative, temporal | expressive, informative | project | quantity, time |
| Tool-call ribbon | dependency, conversational | expressive, informative | session | dependency, communication |
| Week in one picture | temporal, quantitative | expressive | project | time, quantity |
| Histogram | quantitative | informative | session, project | quantity |
| Box and violin | quantitative | informative | project | quantity |
| Ridgeline | quantitative | expressive, informative | project | quantity |
| Scatter plot | quantitative | informative | session, project | quantity, time |
| Bubble chart | quantitative | expressive, informative | project | quantity, time |
| Sunburst | quantitative | expressive | session, project | quantity, hierarchy, actor |
| Calendar heatmap | temporal, quantitative | expressive, informative | project | time, quantity |
| Radar | quantitative | expressive | session, project | quantity, actor |
| Parallel coordinates | quantitative | informative | session, project | quantity, time |
| Streamgraph | temporal, quantitative | expressive | session | time, quantity, actor |
| Sankey | actor, quantitative | expressive, informative | session, project | quantity, actor |
| Adjacency matrix | actor | informative | session, project | actor, communication, quantity |
| Swimlane | conversational, actor | informative, expressive | session | communication, actor |
<!-- rows -->

**Gantt and waterfall** draws both forms named in the proposal behind one toggle. Events have no durations, so a bar is the span from a turn's or agent's first event to its last, and calls are ticks. Waiting isn't told apart from working until [phase 8](trusted-advisor.md#phases) labels quiet gaps, and the view's note says so. The waterfall's selected turn gets its own chart rather than zooming the first, so the session's shape stays in view while reading one turn.

**Week in one picture** counts the loaded sessions, not the whole week, because the explorer's contract is the picked sessions; the cap of eight applies, and the note says so. The rings give outer days more area than inner ones, so color rather than size carries the value, and a table carries the numbers. With the agent-and-subagent graph covered by the actor graph, every view this document names is now built.

The distribution and comparison views share helpers in `media/shared.js`, which reach a visualizer through `ctx`: per-turn numbers (`turnStats`), the measurements (`METRICS`, `metricValues`), `quantile` and `density`, `heatScale`, `modeButtons`, and the slide's layout (`vizPanel`).

### What comes next

The rest of the proposal's tables stay a catalog to consider, none planned yet. Those left mostly need something `SessionView` doesn't have: the dependency views need links between events and what they produced, the state views need states someone has defined, and the semantic views need derived data. Three of its guidelines are already in this design and should hold for every view added: preserve event identity (the shared selection), separate observed from inferred (the turn tree's ≈ and hatching), and make expressive views lead to the underlying events rather than end in a picture. Its cross-cutting encodings (node size, edge thickness, typed edges, glow for an active agent) are the vocabulary for the graph views when they come. Semantic views depend on derived representations, embeddings or model labels, which Snagboat doesn't produce; they wait on the advisor, and on a decision about what derived data to keep. Prompt terms doesn't change that: it counts words in the page at draw time and keeps nothing, and it says it's word counts rather than a model's reading.

## Decisions

Confirmed in review on 2026-11-03.

| Question | Decision |
| --- | --- |
| Where the explorer lives | A fourth tab, Explore (experimental), not inside the Sessions tab, so the Sessions tab keeps working while the explorer changes |
| Where tags are declared | In a TypeScript catalog, validated in unit tests; renderers in plain JS match by id |
| Facets | Four, values not mutually exclusive: category (the question answered), purpose (informative or expressive), level (session or project), dimension (what's highlighted; an open-ended list); every facet given by every visualizer (2026-11-03, replacing a first draft's subject, layout, time, scope, and grain) |
| Filter logic | OR within a facet, AND across facets |
| Porting the existing views | Moved into visualizer modules the Sessions tab also draws through, not copied |
| Many sessions in the turn tree | A root node with one child per session |
| Many sessions in the context timeline | Stacked, one per session, by the carousel's rule for `session`-level visualizers; a shared axis is context fill (by call sequence) or session strips (by clock) |
| A visualizer and the wrong number of sessions | Never refuses: `session`-level stacks one drawing per session, `project`-level draws one session as a list of one |
| How sessions reach the explorer | A picker on the tab (every session, newest start first, checkboxes, Load; no day filter), up to 8 sessions, kept live like the open session |
| Puck placement | Any corner, by drag or arrow keys; collapsible to a small circle; a rounded rectangle when expanded |
| A web demo | Yes, on GitHub Pages: the same visualizer scripts, the session model bundled for the browser, synthetic sessions by default, your own daily files loaded in the browser and never sent anywhere (CSP `connect-src 'none'`) |

## Open questions

- **Whether the Sessions tab should become the explorer** once the carousel has the same two views plus better ones, or stay as the stable arrangement with the explorer as its lab. Decide after the three new visualizers are in and have been used for a week or two.
- **Whether the selection should carry across tabs**, so a turn selected in the Sessions tab is selected in the explorer and back. Cheap if both read one saved selection; left out until the explorer's own selection is working.
- **How `dimension` is kept honest.** It's meant to change, so the unit test only checks that each value is in the current list; adding a value is a one-line change plus the visualizers it applies to. Whether the puck should show dimensions nobody has tagged yet (as it does for the other facets) or only the ones in use is a judgment to make once there are more than five visualizers.
- **The session cap.** Eight is a guess; the first use on real history (a day with twenty short sessions) says whether the cap or the picker is the problem.

## References

- [Visualizing agent conversations and execution](agent_conversation_visualization_design_proposal.docx), the proposal whose categories and purposes are this taxonomy, and whose tables are the source of views for step 6.
- [Conversation-aware view](conversation-view.md), whose two views are ported, and whose cost-per-prompt view is built here.
- [Trusted advisor, phase 7](trusted-advisor.md#phases), which this is part of.
- The charts' rules of form and color are the ones the existing charts follow (one axis, fixed categorical order, validated palettes, a legend for two or more series, a table or labels where contrast is low); `detail.css` records the validated colors.

## Implementation notes

Step 2 (the Explore tab and the two ported visualizers) differs from the text above in these details:

- **`update` takes options.** The contract is `update(sessions, selection, options)`: `options` is what the host passes per render (`{ expanded }` from the Sessions tab, nothing from the explorer), since it changes over time; `ctx` carries only the helpers, the tooltip pair, and `select`. The full contract is in the header of `media/viz/registry.js`.
- **Instances expose a little more than the three methods.** The turn tree has `focus(nodeId)`, which the Sessions tab's breadcrumb calls; the context timeline has `zoomAll()` and `zoomTo(range | null)`, which "Show whole session" and a finding's Show call. A visualizer's selection may carry `focusId` (the tree's), which the tree adopts on `update` when present and otherwise keeps its own.
- **The timeline's "Showing …" note moved into the visualizer**, under its chart, so the explorer shows it too; the Sessions tab's panel head (Expand, Show whole session) stays chrome.
- **Where the shared code lives.** The helpers both the page and the visualizers use are `media/shared.js` (`window.snagboatShared`); the registry is `media/viz/registry.js`; the webview's source object is `media/exploreSource.js`, the only explorer file that touches VS Code. The source contract gained `closeExplorer()`, `onSessions(cb)`, `onExplorer(cb)`, and `openSessionId()` beyond the four methods named above; it is documented in the header of `media/explore.js`.
- **The picker has an Unload button** (the `closeExplorer` message), and repeats the session cap (8) since `ExplorerState` doesn't carry it.
- **The tab is labeled "Explore" with an "experimental" badge** rather than the literal "Explore (experimental)".
- **The puck sits above the tooltip layer** as designed (`z-index` 20 over the tooltip's 10), so a tooltip raised under it is covered; collapsing or moving the puck is the remedy for now.

### Step 3

The three new visualizers (`media/viz/sessionStrips.js`, `costPerPrompt.js`, `contextFill.js`) follow the text above with these details:

- **Session strips draws calls no turn claims** as a dashed block (the tree's Unlinked), with its own tooltip and no click, so a session whose prompts weren't captured still shows where its calls fell. A turn's block runs from its first prompt to its last model call, subagent calls included.
- **Cost per prompt's stacking toggle is two buttons** (`aria-pressed`) above the chart, and the mode lives in the instance, not in saved state, so it resets when the slide is remounted. By agent, the series are main agent and subagents in the daily chart's first two series colors; by tool category, the tree's five category colors plus the neutral "Other and replies only", with ≈ in the tooltip and the note since the tree's category split is an approximation. The Unlinked column selects its session without a turn. Column labels thin when columns are narrow, keeping the first of each session's group.
- **Context fill's x is the index among the main agent's calls**, not among all of a session's calls, since only those are drawn. Its line colors are a fixed order over the validated hues (`--series-1`, then `--cat-1`..`--cat-5`) and repeat with a dashed stroke past six, so the explorer's cap of eight sessions stays distinguishable with the legend. The marks of a model several sessions share are drawn once (largest seen and lowest limit). Hovering uses a nearest-point layer over the plot rather than one hit target per call, so its points are not keyboard-reachable; a turn selected elsewhere is ringed on its calls.
- **New CSS classes, existing variables only.** `detail.css` gains `.viz-chart` (the grid, axis, hover, and mark conventions of the context chart for the explorer's charts), the strips, cost, and fill chart classes, `.line-0`..`.line-5` for the fill lines, and legend swatches for turns, compactions, finding badges, lines, and dashed lines. No new colors.

### Step 4

The web demo (the browser bundle, the page, the Pages workflow, the Reveal command, and the PRIVACY.md paragraph) differs from the text above in these details:

- **What was split for the browser.** esbuild refuses to resolve a node builtin for the browser, and a re-export keeps the module in the graph, so the pure parts moved out rather than the fs parts: `eventDay` to `src/core/eventDay.ts` (re-exported by `eventLog.ts`), the marks and their rules (`ModelContextMarks`, `contextSize`, `mergeMarks`, and `marksFromEvent`, which `ContextLimits.observe` now uses) to `src/core/contextMarks.ts` (re-exported by `contextLimits.ts`), and `sessionNameId`, the one crypto user in `sessions.ts`, to `src/core/sessionNames.ts`, with its two adapter importers following it. `SessionListPayload` moved to `explorerModel.ts` (re-exported by the controller) so the page can share it. The modules in the bundle's graph import from the new files; everything else still imports from the old ones.
- **The bundle.** `src/web/main.ts` is the esbuild entry; `src/web/page.ts` holds the DOM code and both are excluded from the root tsconfig and checked by `tsconfig.web.json` (DOM lib, no node types). The pure parts under `src/web` (`synthetic.ts`, `jsonl.ts`, `marks.ts`, `eventSet.ts`) stay under the root tsconfig and `src/test/unit/web.unit.test.ts`. `EventSet` is the page's stand-in for the log, index, limits, and controller: `explore` is reproduced without the live-findings merge, so no finding on the page is ever "active", and the heuristics run with their defaults (`() => ({})`, since each applies its own).
- **The build.** `npm run build` builds both entries, so CI fails if a node import creeps into the model; `npm run build:web` type-checks the page, bundles it, and runs `scripts/webDemo.js`, which copies `media/shared.js`, `media/explore.js`, `media/viz/*.js`, `media/detail.css`, and `web/` into `out/web/` and writes one script tag per visualizer file into `index.html` (the registry first), so a new visualizer needs no edit to the page.
- **The CSP** is `default-src 'none'` with `script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`, tighter than the `default-src 'self'` written above; the page has no inline script or style.
- **The page pre-picks two sessions** (`openSessionId()` is null on the page, so nothing would be drawn on a first visit otherwise) and, when the data changes (files loaded, or back to the examples), remounts the explorer, keeping the picked ids the new data has and falling back to the default pick. The state lives in `localStorage` under one key.
- **The examples** are four sessions dated 2026-11-02, with the long session's sixth turn editing one file twelve times to trip tool-churn and backtracking on replay; the Copilot session reports its budget rather than compacting.
- **The Reveal command** also reports "no events logged" when the folder exists but holds no daily file, since activation creates the folder.

