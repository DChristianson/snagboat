import { SessionSummary } from '../core/sessions';
import { SessionView } from './sessionModel';
import { CATALOG, TAXONOMY, Taxonomy, VisualizerEntry } from './visualizers';

/** The session list the Sessions and Explore tabs' pickers draw (the `sessions` message). */
export interface SessionListPayload {
  day: string;
  /** Days with sessions, newest first, for the day picker. */
  days: string[];
  sessions: SessionSummary[];
  /** The advisor's headline per session, where there is one (model output). */
  headlines: Record<string, string>;
}

/**
 * Everything the Explore tab renders, sent whole on the `explorer` message
 * the way `sessions` and `session` are: the taxonomy and catalog for the
 * carousel and puck, the picked sessions' views, and the picked ids that have
 * no view (unknown, or no longer retained).
 */
export interface ExplorerState {
  taxonomy: Taxonomy;
  catalog: VisualizerEntry[];
  /** In the order picked. */
  sessions: SessionView[];
  notLoaded: string[];
}

/** Builds the state for the picked ids, keeping their order and naming the ones without a view. */
export function buildExplorerState(picked: string[], viewFor: (sessionId: string) => SessionView | undefined): ExplorerState {
  const sessions: SessionView[] = [];
  const notLoaded: string[] = [];
  for (const id of picked) {
    const view = viewFor(id);
    if (view) sessions.push(view);
    else notLoaded.push(id);
  }
  return { taxonomy: TAXONOMY, catalog: CATALOG, sessions, notLoaded };
}
