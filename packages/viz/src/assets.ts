/**
 * The page files a host loads from the package root, beside the visualizers
 * under viz/ (registry.js first, then one file per visualizer): the
 * visualization kit, the explorer, the theme's tokens, and the styles.
 */
export const ASSET_FILES: readonly string[] = ['theme.css', 'vizkit.js', 'viz.css', 'explore.js'];
