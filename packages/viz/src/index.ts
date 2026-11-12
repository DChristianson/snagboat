// factory-clock (Factory Clock, docs/design/factory-clock-plan.md): the
// visualizer catalog and the explorer's model. The page's plain scripts and
// styles (viz/, vizkit.js, explore.js, viz.css, theme.css) sit at the
// package root; hosts load them from there (ASSET_FILES and viz/*.js).
// Browser-safe: nothing here imports Node builtins, vscode, or Snagboat.
export * from './catalog';
export * from './explorerModel';
export * from './assets';
