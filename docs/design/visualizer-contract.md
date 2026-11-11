# The visualizer contract

Status: describes the code as of 2026-11-11, for step 5 of the [Factory Clock plan](factory-clock-plan.md#steps). This file moves with the package in step 4. Where the code and this page disagree, the code wins; say so in an issue.

This page is for someone writing a new visualizer. The design behind it is in [visualization-explorer.md](visualization-explorer.md#the-visualizer-contract).

## What a visualizer is

One plain browser script in `media/viz/`. No modules, no build step, no dependencies. It registers itself with the registry and draws one or more sessions into a DOM element it is given. It sees only that element, a `ctx` object of helpers, and the sessions. It doesn't know which page it runs in: the Explore tab in VS Code, the web demo, or later the advisor UI.

The page loads, in order: `vizkit.js` (sets `window.snagboatVizKit`), `viz/registry.js` (sets `window.snagboatViz`), every visualizer, then `explore.js`. So a visualizer can rely on the registry existing when it runs, and on nothing else being ready yet.

## Registering

```js
window.snagboatViz.register({ id, title, tags, mount(host, ctx) })
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Required. Must match the `id` of an entry in the catalog. Lowercase with hyphens, like `context-fill`. |
| `mount` | function | Required. `register` throws without `id` and `mount`. |
| `title` | string | Optional, for reading the file. The catalog's title is what's shown. |
| `tags` | object | Optional, for reading the file. The catalog's tags are what the explorer uses. |

Registering the same id twice replaces the first. The registry also has `get(id)`, which returns the definition or `undefined`, and `ids()`, which returns the registered ids in registration order. A visualizer doesn't need either.

Wrap the file in an IIFE. Every visualizer shares the page's global scope, so a top-level `const` would collide with another file's.

## mount and the instance

```js
mount(host, ctx) -> { update(sessions, selection, options), resize(), destroy(), setActive?(active) }
```

`mount` builds the DOM once under `host`, an empty `div`, and returns an instance. Keep state in the closure.

| Method | When the host calls it | What to do |
| --- | --- | --- |
| `update(sessions, selection, options)` | Right after `mount`; whenever the loaded sessions change, including live updates; after any visualizer calls `ctx.select` | Redraw. It runs often, so it must be safe to repeat. Never call `ctx.select` from inside it. |
| `resize()` | After the window resizes (debounced 150 ms) and when the tab is shown | Redraw at the new width. Most views pass their draw function. |
| `destroy()` | When the slide leaves the mounted window, the filters hide it, or the sessions change | Stop timers and clocks, call `ctx.hideTip()`, empty `host`. |
| `setActive(active)` | Optional. The carousel calls it with `true` for the current slide and `false` for its mounted neighbors and while the tab is hidden | Start or stop animation. A host may never call it (the Sessions tab doesn't), so a view must draw correctly without it. |

The arguments to `update`:

- `sessions`: `SessionView[]`, never empty from the explorer. See [The data](#the-data).
- `selection`: `{ sessionId?, turnId?, range?: [fromMs, toMs], focusId? }` or `null`. Shared across every slide. Use the fields you can show; ignore the rest. `focusId` is a turn tree node id; only the tree sets it.
- `options`: `{}` from the explorer. The Sessions tab passes `{ expanded }` to the two views it mounts.

How the explorer mounts you:

- **Level decides instances.** If the catalog entry's `level` tags include `project`, you get one instance with every loaded session. If not, you get one instance per session, each stacked under that session's name and given a one-element list.
- **Only three slides are live.** The current slide and its two visible neighbors are mounted. Others are destroyed, and mounted again from scratch when you scroll back. Nothing in an instance survives that, such as which mode button was pressed.
- **Several instances at once.** Stacked sessions and neighbors mean several instances of one visualizer can be on the page. Ids inside SVG (gradients, clip paths, patterns) need a per-instance prefix; see the `charts` counter in `factoryClock.js`.
- **Width can be zero.** The tab may be hidden at mount. Fall back to a width, as `host.clientWidth || 800`, and redraw on `resize()`.

## ctx

`ctx` is every helper in `window.snagboatVizKit` (`media/vizkit.js`), plus four fields from the host. Read the comments in `vizkit.js` for details; this is the list.

**From the host**

| Field | Type |
| --- | --- |
| `select(selection)` | Announce a selection: `{ sessionId?, turnId?, range?, focusId? }`, or `null` to clear. The host saves it and calls `update` on every mounted instance. |
| `tooltip` | The page's tooltip element. Use `showTip` and `hideTip` rather than touching it. |
| `showTip(evt, rows)` | Shows the tooltip near the pointer. `rows` is an array of strings (one line each) or `[label, value]` pairs. |
| `hideTip()` | Hides it. |

**DOM and SVG**

- `el(tag, props, children)`: an HTML element. `props.text` sets `textContent`, `props.class` the class, `on*` keys add listeners, anything else is an attribute. Falsy children are skipped.
- `svg(tag, attrs)`: an SVG element with these attributes.
- `svgText(attrs, text)`: an SVG `text` element.
- `vizPanel(host, controls)`: lays out controls, chart, legend and note under `host`. Returns `{ chart, legend, note, empty(message) }`.
- `modeButtons(label, options, initial, onChange)`: a row of buttons that picks one of `[[id, text]]`.
- `legendKey(cls, text)`: a swatch and label for a legend.
- `interact(ctx, node, { label, tip, pick })`: the tooltip on hover, and with `pick`, a click and Enter that call it, `tabindex` and `role="button"`. Pass `ctx` itself as the first argument.
- `fitHeight(host)`, `fitter(host)`: the height left in the carousel's slide, so a view fills it without scrolling. `null` or the fallback outside the carousel.

**Formatting**

`fmt(n)` (locale digits), `compact(n)` (1.2K, 3.4M), `clip(text, max)`, `fit(text, widthPx)` (about 7 px per character), `formatTime(ts)`, `duration(fromTs, toTs)`, `secondsText(s)`, `speedText(x)`, `short(id)` (first 8 characters), `agentName(agent)`, `modelShort(model)`, `sessionName(summary, max = 60)`.

**Sessions and measures**

- `ms(ts)`: `Date.parse`. Timestamps in the data are ISO strings.
- `callTokens(call)`: input + cache read + cache creation + output.
- `turnStats(view)`: one entry per turn, `{ turnId, index, text, from, to, tokens, calls, tools, failures, subagents }`, with `from` and `to` in ms and `subagents` a `Set`.
- `METRICS` and `metricValues(view, key)`: the six measures the distribution views share, each value `{ value, turnId, model?, agentId? }`.
- `findNode(tree, id)`, `pathTo(tree, id)`: lookups in `view.tree`.
- `termsOf(text)`, `foldPlural(term, all)`: word counting with a stopword list, for views that read text.

**Scales and shapes**

`niceMax(v)`, `niceAxis(max, n = 4)` → `{ top, ticks }`, `quantile(sorted, q)`, `density(values, lo, hi, n)`, `heatScale(max, steps)`, `arcPath(cx, cy, r0, r1, a0, a1)`, `sessionClass(i)` (the class for the i-th session's color: `line-0` to `line-5`, then the same with `ring`).

**Replay clock** (for views that play sessions back)

- `createReplay({ onFrame })` returns a clock. Call `clock.setSessions(sessions)` in `update`, draw in `onFrame(clock)` from `clock.time` (ms) and `clock.shown` (how many of `clock.events` have happened), pass `setActive` through to `clock.setActive`, and call `clock.destroy()` in `destroy`. The clock owns the frames; keep no timers of your own.
- `replayBar(clock, { label })` returns `{ element, sync }`: play, scrub, speed, loop, and a `LIVE` or `REPLAY ×N` badge. Call `sync()` from `onFrame`.
- `replayEvents(sessions)`: the merged, ordered event list on its own. `countUpTo(events, t)`.
- `REPLAY_SPEEDS`, `REPLAY_CHOICES`, `getReplayPrefs()`, `setReplayPrefs(partial)`, `onReplayPrefs(cb)`: page-wide speed and loop, shared by every clock. A view doesn't usually touch these.

The clock respects `prefers-reduced-motion`: it opens on the final state and doesn't autoplay. See [Shared replay](visualization-explorer.md#shared-replay) and `media/viz/factoryClock.js` for a full use.

**Force layout**

`forceLayout(nodes, links, { width, height, previous? })` returns `Map(id → { x, y })`. Deterministic: starting positions come from `hashId(id)`. Pass the last result as `previous` so an update moves nodes gently. `drift(id, t, amplitude)` → `{ dx, dy }` is decoration only. Every pair of nodes is compared, so fold to a few dozen nodes first. See [Shared force layout](visualization-explorer.md#shared-force-layout).

## The data

Each session is a `SessionView`, built from `NormalizedEvent`s by `buildSessionView` in the schema package ([`packages/schema/src/sessionModel.ts`](../../packages/schema/src/sessionModel.ts)). The event format itself is in [schema.md](../schema.md). The fields most views use:

| Field | Type |
| --- | --- |
| `summary` | `SessionSummary` ([`sessions.ts`](../../packages/schema/src/sessions.ts)): `sessionId`, `agent`, `firstTs`, `lastTs`, `models`, `prompts`, `modelCalls`, `toolCalls`, `tokens`, `subagents`, `days`, `name?` |
| `prompts` | `{ turnId, ts, index, text? }[]`. Several prompts can share a turn and its index. |
| `calls` | `{ ts, turnId?, agentId?, model?, input, cacheRead, cacheCreation, output, reply? }[]`, one per model call. No `agentId` means the main agent. |
| `tools` | `{ ts, turnId?, agentId?, name?, category, colorGroup, status }[]`. `colorGroup` is 1 to 5, or 0 for the rest; `status` is `success`, `failure` or `unknown`. No targets or arguments. |
| `compactions` | `{ ts, trigger, preTokens?, postTokens? }[]` |
| `subagents` | `{ agentId, firstTs, lastTs, calls }[]` |
| `findings` | `{ heuristicId, severity, summary, fromTs?, toTs?, turnIds, startedTs?, active }[]` |
| `marks` | Per model: `{ largestSeen?, largestSeenAt?, limit?, limitAt?, limitSource? }` |
| `tree` | The turn tree: `TreeNode` with `id`, `label`, `kind`, `tokens`, `children` |
| `categoryGroups` | Legend labels for `colorGroup` 1 to 5 |
| `headline?` | The advisor's one-line headline, model output, when there is one |

Text fields (`prompts[].text`, `calls[].reply`, `summary.name`, `headline`) are present only when text capture was on. Draw without them. Write all text with `textContent` (or `el`'s `text`, or `svgText`), never `innerHTML`.

The explorer loads at most 8 sessions (`EXPLORE_SESSION_CAP`), and each carries every call and prompt, so a long session is large.

## Styling

- **Colors come from `--sv-*` tokens** in [`media/theme.css`](../../media/theme.css). It gives each a light and a dark value from `prefers-color-scheme`, and a host can remap them. The main ones: `--sv-surface`, `--sv-ink`, `--sv-ink-muted`, `--sv-rule`, `--sv-accent`, `--sv-warn`, `--sv-info`, `--sv-error`, `--sv-ok`, `--sv-hover`, `--sv-selection`, `--sv-series-1` to `-3`, `--sv-cat-1` to `-5`, `--sv-turn-0` and `-1`. Never use a host's variables, such as `--vscode-*`, or a host's theme classes; a unit test fails if you do.
- **Shared classes** do most of the work: `viz-chart` on the SVG, `grid`, `axis-label`, `row-label`, `hit` (a transparent hover target), `line-0` to `line-5` (from `sessionClass`), `muted`, `small`, `controls`, `legend`, `key`, `swatch`.
- **Your own rules** go in the package's stylesheet (`media/viz.css`), scoped under a class on your root element. A new color goes into `theme.css` as a token with a light and a dark value, and into `media/vscodeTheme.css`, the webview's mapping; the theme test checks both. Never a literal in a rule that applies in both themes.
- **No inline styles in markup.** Both pages' Content-Security-Policy allow styles only from the page's own files, so `style` attributes and `<style>` elements are dropped. Setting a property from script (`node.style.height = ...`, `node.style.setProperty('--x', ...)`) works. SVG presentation attributes (`fill-opacity`, `stroke-width`) work too.
- **Hero views** (`language` other than `standard`) draw their own ground and palette in both themes, with their colors in variables scoped to the view. Everything else uses the theme.
- **Fonts** are system stacks: `--sv-font`, `--sv-mono`. No font files load.

## Constraints

- **No network.** The web page's policy is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'`. No `fetch`, no XHR, no remote images or fonts. The webview's is stricter (scripts by nonce only).
- **No globals** beyond `window.snagboatViz` to register. Everything else comes through `ctx`. Don't read `window.snagboatVizKit` directly, and don't touch the page outside `host` (the tooltip is reached through `showTip`).
- **The host owns saved state.** Keep a view's state in the instance. The explorer saves only the shared selection and the replay settings.
- **Any size.** Work at any slide width and down to a 320 px slide height. Use `viewBox` and the host's width.
- **Performance.** Aggregate or cap marks; put each limit in a named constant at the top of the file and say it in the view's note. Animate only through the replay clock, and only while active. Try the view on the longest session you have, not only the demo data.
- **Accessible.** Give the SVG `role="img"` and an `aria-label`. Make clickable marks keyboard-reachable (`interact` does this). Every view takes part in the shared selection: clicking a mark should select its turn or session.

## Adding the catalog entry

The page draws the slides from the catalog, not the registry. Add an entry to `CATALOG` in [`src/ui/visualizers.ts`](../../src/ui/visualizers.ts):

```ts
{
  id: 'calls-per-session',
  title: 'Calls per session',
  description: 'One bar per loaded session, as tall as its model calls.',
  tags: { category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
},
```

- Every one of the five facets in `TAXONOMY` must have at least one value, and every value must be in that facet's vocabulary. `validateCatalog` reports anything else.
- Facets: `category` (what question it answers), `purpose` (`informative`, `expressive`), `level` (`session`, `project`), `dimension`, `language`. The meaning of each value is in `TAXONOMY`, and the reasoning in [Taxonomy](visualization-explorer.md#taxonomy).
- `level` also decides how you are mounted (see above).
- Order in the array is carousel order. Standard views come before the hero views.
- A new `language` value is added only with the view that brings that look, so the puck never offers a chip that matches nothing.

Then load the script. The web demo picks up every file in `media/viz/` (`scripts/webDemo.js`). The VS Code webview lists each script by name in `src/ui/detailPanel.ts`; add yours before `sessions.js`.

If the catalog and the registry disagree, the puck says so ("Catalog mismatch") and the slide shows "No renderer is registered".

## Tests to add or update

- `src/test/unit/explorer.unit.test.ts`: "the catalog conforms to the taxonomy" runs `validateCatalog` and lists every catalog id in order. Add your id to that list. If you add a hero view, update the hero list in the next test too.
- `src/test/unit/themeBoundary.unit.test.ts`: scans every file in `media/viz/` for `--vscode-*` names and for `--sv-*` tokens `theme.css` doesn't define. Nothing to add; it must pass.
- If your view adds logic worth testing on its own, load the file in Node the way `heroShared.unit.test.ts` loads `vizkit.js` (a `vm` sandbox with a bare `window`), over the synthetic sessions from `src/web/synthetic.ts`. Never use real traces in unit tests.

Run `npm run test:unit`.

## A worked example

`media/viz/callsPerSession.js`, with the catalog entry above. It draws one bar per session, uses the theme through shared classes, has a tooltip, and selects a session on click.

```js
// Calls per session: one bar per loaded session, as tall as its model calls.
// Clicking a bar selects that session. Sees only its host and ctx.
(function () {
  window.snagboatViz.register({
    id: 'calls-per-session',
    title: 'Calls per session',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, niceAxis, sessionName, sessionClass, vizPanel, interact } = ctx;
      const panel = vizPanel(host, []);
      let views = [];
      let selection = null;

      function draw() {
        if (!views.length) return panel.empty('');
        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 44, r: 12, t: 10, b: 24 };
        const ph = 200;
        const axis = niceAxis(Math.max(1, ...views.map((v) => v.calls.length)));
        const y = (n) => m.t + ph - (n / axis.top) * ph;
        const bw = (width - m.l - m.r) / views.length;
        const root = svg('svg', { class: 'viz-chart', viewBox: `0 0 ${width} ${m.t + ph + m.b}`, role: 'img', 'aria-label': `Model calls in ${views.length} sessions` });
        for (const t of axis.ticks) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
          root.append(svgText({ class: 'axis-label', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t)));
        }
        views.forEach((v, i) => {
          const s = v.summary;
          const n = v.calls.length;
          const dim = selection && selection.sessionId && selection.sessionId !== s.sessionId;
          const x = m.l + i * bw;
          const bar = svg('rect', { class: sessionClass(i), x: x + 4, y: y(n), width: Math.max(1, bw - 8), height: Math.max(1, y(0) - y(n)), 'fill-opacity': dim ? 0.35 : 1 });
          interact(ctx, bar, {
            label: `${sessionName(s)}: ${fmt(n)} model calls`,
            tip: () => [sessionName(s), ['Model calls', fmt(n)], ['Prompts', fmt(s.prompts)]],
            pick: () => ctx.select({ sessionId: s.sessionId }),
          });
          root.append(bar, svgText({ class: 'axis-label', x: x + bw / 2, y: m.t + ph + 16, 'text-anchor': 'middle' }, fit(sessionName(s, 40), bw)));
        });
        panel.chart.replaceChildren(root);
        panel.note.textContent = 'Click a bar to select its session.';
      }

      return {
        update(sessions, sel) {
          views = sessions;
          selection = sel || null;
          draw();
        },
        resize: draw,
        destroy() {
          ctx.hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
```

For a short real one, read `media/viz/bubble.js` or `histogram.js`. For a view with replay, `factoryClock.js`.

## Gaps before outside authors

Things an outside author can't do today without changing Snagboat, or that the contract leaves loose:

- **The catalog is TypeScript in the extension.** Title, description and tags live in `src/ui/visualizers.ts`, so a new visualizer means editing and compiling Snagboat. Step 4 of the plan moves it to `catalog.json` in the package.
- **Tags are written twice.** `register` takes `title` and `tags` that nothing reads, and nothing checks they match the catalog. The explorer design's example also passes `description` to `register`, which is ignored.
- **The webview lists scripts by hand.** `src/ui/detailPanel.ts` names every file in `media/viz/`; the web demo finds them on its own. This goes away when VS Code drops the Explore tab (step 4).
- **The catalog test lists every id.** Adding a view means editing `explorer.unit.test.ts`. No unit test checks that each catalog entry has a registered script, or the reverse; only the puck's runtime note does.
- **No per-view stylesheet.** The CSP rules out inline styles, so a view's CSS goes in the shared stylesheet. The shared classes (`viz-chart`, `line-N`, `hit`, ...) aren't documented outside the CSS.
- **`ctx` is the whole kit, unversioned.** About fifty helpers, some for one view (`termsOf`, `drift`). Any rename breaks outside views, and there's no list of which helpers are stable.
- **`SessionView` isn't in schema.md.** It's documented only by comments in `sessionModel.ts`, whose header still says it's built in the extension for the webview.
- **Hosts differ.** The explorer passes `{}` as options and calls `setActive`; the Sessions tab passes `{ expanded }`, never calls `setActive`, and its `select` reads only `turnId` and `focusId`.
- **No view state survives a remount.** A slide two away is destroyed, and its controls reset. There's no way to save a view's own settings.
- **The globals carry the old name.** `snagboatViz` and `snagboatVizKit` will likely be renamed for Factory Clock, which outside views would have to follow.
