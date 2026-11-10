// Helpers only the detail view's scripts (detail.js, suggestions.js) use, on
// top of the visualization kit (vizkit.js, loaded first), which holds
// everything the visualizers and the explorer share with the page. Nothing
// here knows about VS Code. Sets window.snagboatShared: the kit's helpers plus
// these.
(function () {
  function formatDay(day) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  window.snagboatShared = { ...window.snagboatVizKit, formatDay };
})();
