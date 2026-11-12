import { CATALOG, TAXONOMY, validateCatalog } from 'factory-clock';
import { EventSet, parseJsonl, syntheticEvents, syntheticSessionIds } from 'factory-clock/web';
import { startPage } from 'factory-clock/web/page';
import { replayFindings } from './findings';

/**
 * The web demo's bundle entry (esbuild, platform browser; see esbuild.js):
 * Factory Clock's page and its model (packages/viz/src/web), with Snagboat's
 * built-in heuristics (src/heuristics) for the sessions' findings. Loaded last
 * by packages/viz/hosts/web/index.html, after the package's vizkit.js, the
 * visualizers, and explore.js, which the page mounts. The model is also put on
 * window.snagboatWeb for the console; the page itself doesn't read it from there.
 */
(window as unknown as { snagboatWeb: unknown }).snagboatWeb = { EventSet, replayFindings, parseJsonl, syntheticEvents, syntheticSessionIds, CATALOG, TAXONOMY, validateCatalog };

startPage(replayFindings);
