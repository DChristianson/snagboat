# Contributing a visualizer

This guide is for adding a view to Factory Clock. The full interface is in [the visualizer contract](../../docs/design/visualizer-contract.md); this page is the steps. For the rest of the repository (setup, tests, privacy rules), see Snagboat's [CONTRIBUTING.md](../../CONTRIBUTING.md).

A visualizer is one plain browser script that draws `SessionView`s into a DOM element. It sees only that element, a `ctx` object of helpers, and the sessions. It doesn't know which host it runs in.

## Setup

Requires Node.js 24 or later. From the repository root:

```bash
npm ci
npm run build:web          # the web page, in out/web/
npm run test:unit          # every unit test, no VS Code needed
```

## Steps

### 1. Write the script

Add one file to `viz/`, named after the view in camelCase (`callsPerSession.js`). Wrap it in an IIFE, since every visualizer shares the page's global scope:

```js
(function () {
  window.snagboatViz.register({
    id: 'calls-per-session',
    title: 'Calls per session',
    mount(host, ctx) {
      // Build the DOM once under host. Keep state in this closure.
      return {
        update(sessions, selection, options) { /* redraw */ },
        resize() { /* redraw at the new width */ },
        destroy() { ctx.hideTip(); host.replaceChildren(); },
      };
    },
  });
})();
```

`register` throws without an `id` and a `mount` function. The `id` must match a catalog entry (step 2). `update` runs often: after mount, when the sessions change, and after any view announces a selection. Make it safe to repeat, and never call `ctx.select` from inside it. If the view animates, add `setActive(active)` and drive it through `ctx.createReplay`.

The contract has [a complete worked example](../../docs/design/visualizer-contract.md#a-worked-example). Short real ones to copy: [`viz/bubble.js`](viz/bubble.js) and [`viz/histogram.js`](viz/histogram.js). With replay: [`viz/factoryClock.js`](viz/factoryClock.js).

### 2. Add the catalog entry

The explorer draws its slides from the catalog, not from what registered. Add an entry to `CATALOG` in [`src/catalog.ts`](src/catalog.ts):

```ts
{
  id: 'calls-per-session',
  title: 'Calls per session',
  description: 'One bar per loaded session, as tall as its model calls.',
  tags: { category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
},
```

- Give every one of the five facets at least one value, each from that facet's list in `TAXONOMY` in the same file.
- `level` decides how the view is mounted. With `project`, it gets one instance with every loaded session. Without it, it gets one instance per session.
- Array order is carousel order. Put a standard view before the hero views.
- Use `language: ['standard']` unless you are adding a hero view with a look of its own. A new language value comes only with the view that uses it.

### 3. Load it in each host

- **The web page and the advisor UI** pick up every file in `viz/` on their own.
- **The VS Code detail view** lists each script by name in `src/ui/detailPanel.ts`. Add `'viz/<yourFile>.js'` after the other visualizers, before `'sessions.js'`.

If the catalog and the registry disagree, the puck shows "Catalog mismatch" and the slide says "No renderer is registered".

### 4. Style it

- **Use the theme's tokens.** Colors come from the `--sv-*` variables in [`theme.css`](theme.css) (`--sv-ink`, `--sv-ink-muted`, `--sv-rule`, `--sv-accent`, `--sv-series-1` to `-3`, `--sv-cat-1` to `-5`, ...). Don't add raw colors. If you need a new color, add it to `theme.css` as a token with a light and a dark value, and map it in `media/vscodeTheme.css`; the theme test checks both.
- **Never read a host's variables**, such as `--vscode-*`, or key on a host's theme classes. The theme test fails if you do.
- **Reuse the shared classes** in [`viz.css`](viz.css): `viz-chart` on the SVG, `grid`, `axis-label`, `hit`, `line-0` to `line-5` (from `ctx.sessionClass(i)`), `muted`, `small`, `legend`, `swatch`.
- **Put your own rules in `viz.css`**, scoped under a class on your root element.
- **No inline styles in markup.** The hosts' Content-Security-Policy drops `style` attributes and `<style>` elements. Setting `node.style.*` from script works, as do SVG presentation attributes such as `fill-opacity`.
- **Hero views only** may bring their own palette, as variables scoped to the view's root class in `viz.css`. They must read well in both light and dark pages.

### 5. Make it accessible

- Write all text with `textContent`: `ctx.el(tag, { text })`, `ctx.svgText(attrs, text)`, or `node.textContent`. Never `innerHTML`. Prompts and replies are user data.
- Give the SVG `role="img"` and an `aria-label` that says what it shows.
- Make clickable marks reachable by keyboard. `ctx.interact(ctx, node, { label, tip, pick })` adds the tooltip, a click and Enter handler, `tabindex` and `role="button"`.
- Take part in the shared selection: clicking a mark should call `ctx.select({ sessionId })` or `ctx.select({ sessionId, turnId })`, and `update` should show the selection it is given.
- If the view animates, use `ctx.createReplay`. Its clock respects `prefers-reduced-motion`: it opens on the final state and doesn't autoplay. CSS animations need a `@media (prefers-reduced-motion: reduce)` rule that stops them.

### 6. Test it

- **The catalog test.** In `src/test/unit/explorer.unit.test.ts`, "the catalog conforms to the taxonomy" runs `validateCatalog` and lists every catalog id in order. Add your id in the same place you put it in `CATALOG`. If you add a hero view, also add it and its language to the hero list in the next test.
- **The theme test.** `src/test/unit/themeBoundary.unit.test.ts` scans every file in `viz/` and `viz.css`. Nothing to add; it must pass.
- **Your own logic.** If the view computes something worth testing alone, load the script in Node the way `src/test/unit/heroShared.unit.test.ts` loads `vizkit.js`: a `vm` sandbox with a bare `window`. Use the synthetic sessions from `src/web/synthetic.ts` (`@snagboat/viz/web`). Never use real traces in unit tests.
- **The page.** Run `npm run build:web` and open `out/web/index.html`. Move to your view in the carousel and check that it draws, the tooltip and click work, the browser console has no errors, and it works in both light and dark color schemes and at a narrow window. To check it headlessly, load the page with Playwright or another headless browser, wait for the explorer, and assert that `window.snagboatViz.ids()` includes your id and no page errors were logged.

Run `npm run test:unit` before you open a pull request.

## Constraints

- **No network.** No `fetch`, XHR, remote images or fonts. The web page's policy has `connect-src 'none'`.
- **No globals** beyond `window.snagboatViz` to register. Everything else comes through `ctx`.
- **Stay inside `host`.** Reach the tooltip through `ctx.showTip` and `ctx.hideTip`.
- **Any size.** Work at any slide width and down to a 320 px slide height. The width can be zero at mount, so fall back (`host.clientWidth || 800`) and redraw on `resize()`.
- **Several instances.** Neighboring slides and stacked sessions can put several instances on the page. Prefix ids inside SVG (gradients, clip paths) per instance.
- **Bounded work.** Aggregate or cap marks, put each limit in a named constant at the top of the file, and say it in the view's note. Try the view on a long session, not only the examples.
- **Draw without text.** Prompt text, replies and session names are present only when text capture was on.

## Checklist

- [ ] One file in `viz/`, in an IIFE, calling `window.snagboatViz.register` with an `id` and `mount`
- [ ] `mount` returns `update`, `resize` and `destroy`; `destroy` hides the tooltip, stops timers and empties `host`
- [ ] A `CATALOG` entry in `src/catalog.ts` with a description and a value for all five facets
- [ ] The id added to the catalog test in `src/test/unit/explorer.unit.test.ts`
- [ ] The script added to the list in `src/ui/detailPanel.ts`
- [ ] Colors from `--sv-*` tokens only; any new token in `theme.css` (light and dark) and `media/vscodeTheme.css`
- [ ] Rules in `viz.css` under the view's own class; no inline `style` in markup
- [ ] Text through `textContent`; SVG has `role="img"` and an `aria-label`; clickable marks reachable by keyboard
- [ ] Animation only through `ctx.createReplay`, or stopped under `prefers-reduced-motion`
- [ ] `npm run test:unit` passes, and the view draws in `out/web/index.html` with no console errors
