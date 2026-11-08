// The visualizer registry (see docs/design/visualization-explorer.md). Each
// file under media/viz/ registers one visualizer by the id of its entry in the
// catalog (src/ui/visualizers.ts); the title and tags given here are a
// convenience for reading the file, the catalog wins. Loaded before the
// visualizers, after shared.js. No VS Code here.
//
//   window.snagboatViz.register({ id, title, tags, mount(host, ctx) })
//   window.snagboatViz.get(id) -> the definition, or undefined
//   window.snagboatViz.ids()   -> registered ids, in registration order
//
// mount(host, ctx) builds its DOM once under host and returns
//   { update(sessions, selection, options), resize(), destroy(), setActive?(active) }
//   sessions:  SessionView[] (what buildSessionView produces), never empty from the explorer
//   selection: { sessionId?, turnId?, range?: [fromMs, toMs], focusId? } or null; a visualizer
//              ignores the fields it doesn't use, and may add focusId (the tree does)
//   options:   what the host passes: { expanded } from the Sessions tab, nothing from the explorer
//   setActive: optional; the carousel calls it with true for the current slide and false for its
//              mounted neighbors and while the tab is hidden, so a view that animates (through
//              ctx.createReplay) runs only when it can be seen
//   ctx:       the helpers from shared.js plus tooltip (the element), showTip(evt, rows) and
//              hideTip() over it, and select(selection) to announce a selection
(function () {
  const defs = new Map();
  window.snagboatViz = {
    register(def) {
      if (!def || typeof def.id !== 'string' || typeof def.mount !== 'function') throw new Error('snagboatViz.register: an id and a mount function are required');
      defs.set(def.id, def);
    },
    get(id) {
      return defs.get(id);
    },
    ids() {
      return [...defs.keys()];
    },
  };
})();
