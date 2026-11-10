import { CATALOG, TAXONOMY, validateCatalog } from '../ui/visualizers';
import { EventSet } from './eventSet';
import { parseJsonl } from './jsonl';
import { startPage } from './page';
import { syntheticEvents, syntheticSessionIds } from './synthetic';

/**
 * The web demo's bundle entry (esbuild, platform browser; see esbuild.js):
 * the session model from src/core, src/ui, and src/heuristics, the modules
 * under src/web, and the page. Loaded last by web/index.html, after
 * media/vizkit.js, the visualizers, and media/explore.js, which it mounts.
 * The model is also put on window.snagboatWeb for the console and the smoke
 * check; the page itself doesn't read it from there.
 */
(window as unknown as { snagboatWeb: unknown }).snagboatWeb = { EventSet, parseJsonl, syntheticEvents, syntheticSessionIds, CATALOG, TAXONOMY, validateCatalog };

startPage();
