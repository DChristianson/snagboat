# Factory Clock

Factory Clock is a set of visualizations for coding-agent sessions. It reads the event logs that [Snagboat](../../README.md) records from Claude Code and GitHub Copilot, and draws each session 32 ways: timelines, trees, graphs, distributions, and five "hero" views with a look of their own. A carousel, the explorer, moves through them, and a small panel called the puck filters them by tags.

It lives in the Snagboat repository as the npm workspace `factory-clock`. The plan to make it a package of its own is in [factory-clock-plan.md](../../docs/design/factory-clock-plan.md).

Try it: <https://dchristianson.github.io/snagboat/> runs it over example sessions, or over your own event log files.

## The views

The carousel shows them in this order. Standard views use the page's theme. Hero views draw their own ground and palette, and go last.

**Hero views**

| View | What it shows |
| --- | --- |
| Living Network | You, the agents, subagents, and tool categories on one dark field, lit by the work moving between them as the sessions replay. |
| Session Fingerprint | Each run as a signature of turns, subagent branches, retry loops, and quiet gaps; up to three overprinted to compare. |
| Conversation Landscape | What each actor talked about: a dot per actor, its most distinctive words around it, closeness for how much they interacted. |
| Terminal Board | A split-flap board with a region per actor, showing what each last said or did as the sessions replay. |
| Factory Clock | A dial for every loaded session: angle is time, rings are depth from you to the tools, arcs are activity, and a hand sweeps through. |

The hero views replay sessions on a shared clock with play, scrub, speed and loop controls.

**Standard views:** Turn tree, Context timeline, Session strips, Cost per prompt, Context fill, Sequence diagram, Event graph, Actor graph, Prompt terms, Gantt and waterfall, Treemap, Heatmap, Tool-call ribbon, Week in one picture, Histogram, Box and violin, Ridgeline, Scatter plot, Bubble chart, Sunburst, Calendar heatmap, Radar, Parallel coordinates, Streamgraph, Sankey, Adjacency matrix, Swimlane.

The catalog in [`src/catalog.ts`](src/catalog.ts) has each view's description and tags. Tags come from five facets: category (what question it answers), purpose (informative or expressive), level (one session, or several), dimension (time, actor, quantity, ...), and design language. The design behind each view is in [visualization-explorer.md](../../docs/design/visualization-explorer.md).

## Run the web page locally

From the repository root:

```bash
npm ci
npm run build:web
```

This builds the packages, bundles the page, and assembles it in `out/web/`. Open `out/web/index.html` in a browser, or serve that folder with any static file server. The page starts with generated example sessions. To see your own, choose or drop Snagboat's daily event files (`events/YYYY-MM-DD.jsonl`) on the page.

The build is [`scripts/webDemo.js`](scripts/webDemo.js). It copies the package's scripts and stylesheets into `out/web/` and writes a script tag for every file in `viz/`, so a new visualizer needs no edit to the page. On every push to `main`, the Pages workflow (`.github/workflows/pages.yml` at the repository root) runs the same build and deploys `out/web/`.

## Where it runs

Factory Clock is web only. Its one host is the web page, built as above. It replays example sessions or files you load; nothing is live.

The page's script tags set three globals, in this order:

| Global | Set by | What it is |
| --- | --- | --- |
| `window.factoryClockKit` | `vizkit.js` | The helpers each visualizer gets as `ctx` |
| `window.factoryClock` | `viz/registry.js` | The registry the visualizers call `register` on |
| `window.factoryClockExplore` | `explore.js` | The explorer, mounted by the page with a source object that lists and loads sessions |

The visualizers don't know which page they run in. The explorer hands them the sessions.

For now the page's bundle entry is Snagboat's (`src/web/main.ts` at the repository root). It starts the page and passes in the findings of Snagboat's heuristics, replayed over the loaded events. A findings export from Snagboat will replace it (step 9 of [the plan](../../docs/design/factory-clock-plan.md#steps)).

## Input

Every view draws `SessionView` objects from `@snagboat/schema`. `buildSessionView` in [`packages/schema/src/sessionModel.ts`](../schema/src/sessionModel.ts) builds one per session from `NormalizedEvent`s, the event format in [schema.md](../../docs/schema.md). Snagboat stores those events as daily JSONL files.

So any tool that writes `NormalizedEvent` JSONL can feed Factory Clock. The page reads no other format. The fields the views use are listed in [the visualizer contract](../../docs/design/visualizer-contract.md#the-data).

Text fields (prompts, reply excerpts, session names) are present only when Snagboat's text capture was on. Every view draws without them.

## Rules the package keeps

- **No runtime dependencies.** Each visualizer is one plain browser script: no modules, no framework, no charting library, no build step. They draw with SVG and the DOM. Fonts are system stacks; no font files load.
- **Its own theme.** Colors come from `--fc-*` tokens in [`theme.css`](theme.css), with a light and a dark value from `prefers-color-scheme`. A host can remap them. No package file may read a host's variables, such as `--vscode-*` (`themeBoundary.unit.test.ts` checks). Hero views keep their own palettes, scoped to the view in [`viz.css`](viz.css).
- **Only its own imports.** The TypeScript here imports only itself and `@snagboat/schema` (`vizBoundary.unit.test.ts` checks).
- **Text through `textContent`.** Prompt and reply text is never written as HTML.

## Privacy of the web page

The page sends nothing anywhere. Its Content-Security-Policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'`, so a script on the page can't make a network request. It has no analytics, no service worker, and no third-party scripts.

Files you load are read in the browser with `FileReader` and kept in the page's memory until you close the tab. The page stores only the explorer's view state (picked session ids, the current view, its filters) in the browser's local storage. GitHub serves the page and sees the request for it, but none of the data. See [PRIVACY.md](../../PRIVACY.md#the-web-demo).

## Layout

| Path | What's there |
| --- | --- |
| `viz/` | One script per visualizer, and `registry.js`, which they register with |
| `vizkit.js` | The helpers the visualizers get as `ctx`: DOM, formatting, tooltip, replay clock, force layout |
| `explore.js` | The explorer: session picker, carousel, and puck |
| `theme.css`, `viz.css` | The color tokens, and the visualizers' and explorer's styles |
| `src/catalog.ts` | The catalog and the tag taxonomy |
| `src/explorerModel.ts` | The explorer's state, as the web page builds it |
| `src/web/` | The web page's code: example sessions, the JSONL reader, an in-memory session source |
| `hosts/web/` | The web page's `index.html` and stylesheet |
| `scripts/webDemo.js` | Assembles the web page in `out/web/` |

## Writing a visualizer

See [CONTRIBUTING.md](CONTRIBUTING.md) for the steps, and [the visualizer contract](../../docs/design/visualizer-contract.md) for the full interface: `register`, `mount`, the instance methods, `ctx`, the data, and styling.

## License

MIT, as the rest of [Snagboat](../../LICENSE).
