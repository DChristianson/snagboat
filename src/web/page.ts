import { ExploreSessionList, ExplorerState } from '../ui/explorerModel';
import { EventSet } from './eventSet';
import { parseJsonl } from './jsonl';
import { readDemoTraces } from './traces';
import { syntheticEvents, syntheticSessionIds } from './synthetic';

/**
 * The web demo's page (docs/design/visualization-explorer.md, "A web demo on
 * GitHub Pages"): mounts media/explore.js over a source backed by an EventSet
 * in memory, the example traces (or the generated sessions, when the page was
 * built without traces) until files are loaded, and keeps the tab's
 * small state in localStorage. This is the only DOM-touching file under
 * src/web; tsconfig.web.json checks it. Nothing here fetches, posts, or
 * stores anything but that state: the page's CSP forbids network requests,
 * and loaded events live in memory until the tab closes.
 */

/** The explorer's saved state, under one key. */
const STATE_KEY = 'snagboat.explore';

/** The source object media/explore.js expects (see its header). */
interface ExploreSource {
  listSessions(): void;
  loadSessions(ids: string[]): void;
  closeExplorer(): void;
  getState(): Record<string, unknown>;
  setState(partial: Record<string, unknown>): void;
  onSessions(cb: (list: ExploreSessionList) => void): void;
  onExplorer(cb: (state: ExplorerState | null) => void): void;
  openSessionId(): string | null;
}

interface ExploreTab {
  shown(): void;
  destroy(): void;
}

/** What the page's plain scripts (media/shared.js, media/explore.js) put on window. */
interface PageGlobals {
  snagboatShared: Record<string, unknown> & { tipFor(tooltip: HTMLElement): { showTip: (evt: MouseEvent, rows: unknown[]) => void; hideTip: () => void } };
  snagboatExplore: { mount(root: HTMLElement, source: ExploreSource, ctx: Record<string, unknown>): ExploreTab };
  /** Set by demo-traces.js (web/demo/traces.js, from npm run demo:traces) when the page was built with it. */
  snagboatDemoTraces?: { picked?: unknown; events?: unknown };
}

const TRACES_NOTE = 'Example traces: real sessions from building Snagboat and another project, with paths and command lines removed; the prompts and replies are as they were written. Load your own files below to explore yours.';
const GENERATED_NOTE = 'Generated sessions: four made-up ones, shaped like real Claude Code and Copilot sessions but not recorded from anyone. Load your own files below to explore yours.';


function readState(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeState(state: Record<string, unknown>): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked or full: the tab still works, it just won't remember.
  }
}

/** A source over one event set: lists and loads synchronously, since everything is in memory. */
function sourceOver(data: EventSet): ExploreSource {
  const listeners = { sessions: [] as Array<(list: ExploreSessionList) => void>, explorer: [] as Array<(state: ExplorerState | null) => void> };
  return {
    listSessions() {
      const list = data.listAll();
      for (const cb of listeners.sessions) cb(list);
    },
    loadSessions(ids) {
      const state = data.explorerState(ids);
      for (const cb of listeners.explorer) cb(state);
    },
    closeExplorer() {
      for (const cb of listeners.explorer) cb(null);
    },
    getState: readState,
    setState(partial) {
      writeState({ ...readState(), ...partial });
    },
    onSessions(cb) {
      listeners.sessions.push(cb);
    },
    onExplorer(cb) {
      listeners.explorer.push(cb);
    },
    openSessionId: () => null,
  };
}

export function startPage(): void {
  const globals = window as unknown as PageGlobals;
  const byId = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`snagboat web: #${id} is missing from the page`);
    return node as T;
  };
  const root = byId('explore-root');
  const tooltip = byId('tooltip');
  const filesInput = byId<HTMLInputElement>('files');
  const drop = byId('drop');
  const dataNote = byId('data-note');
  const examplesBtn = byId<HTMLButtonElement>('examples');
  const tracesBtn = byId<HTMLButtonElement>('traces');
  const traces = readDemoTraces(globals.snagboatDemoTraces);
  const examplesNote = byId('examples-note');

  // detail.css switches its dark colors on body.vscode-dark, as the webview does; follow the browser's scheme.
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => document.body.classList.toggle('vscode-dark', dark.matches);
  applyTheme();
  dark.addEventListener('change', applyTheme);

  const shared = globals.snagboatShared;
  const ctx = { ...shared, tooltip, ...shared.tipFor(tooltip) };
  let tab: ExploreTab | null = null;

  /**
   * (Re)mounts the explorer over a set. The picked ids only mean something
   * for the data they were picked from, so ones the new set doesn't have are
   * dropped, and with none left the default pick stands in.
   */
  function mountExplorer(data: EventSet, defaultPick: string[]): void {
    tab?.destroy();
    const stored = readState().picked;
    const kept = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && !!data.index.get(id)) : [];
    writeState({ ...readState(), picked: kept.length ? kept : defaultPick });
    tab = globals.snagboatExplore.mount(root, sourceOver(data), ctx);
    tab.shown();
  }

  /** Shows one of the built-in sets; the other's button stays offered. */
  function useBuiltIn(which: 'traces' | 'generated'): void {
    dataNote.textContent = '';
    const useTraces = which === 'traces' && !!traces;
    tracesBtn.hidden = !traces || useTraces;
    examplesBtn.hidden = !useTraces;
    examplesNote.hidden = false;
    examplesNote.textContent = useTraces ? TRACES_NOTE : GENERATED_NOTE;
    if (useTraces && traces) mountExplorer(new EventSet(traces.events), traces.picked.slice(0, 2));
    else mountExplorer(new EventSet(syntheticEvents()), syntheticSessionIds().slice(0, 2));
  }

  async function loadFiles(files: ArrayLike<File>): Promise<void> {
    const list = Array.from(files);
    if (!list.length) return;
    dataNote.textContent = `Reading ${list.length} file${list.length === 1 ? '' : 's'}…`;
    const seen = new Set<string>();
    const events = [];
    let skipped = 0;
    let duplicates = 0;
    for (const file of list) {
      const parsed = parseJsonl(await file.text(), seen);
      events.push(...parsed.events);
      skipped += parsed.skipped;
      duplicates += parsed.duplicates;
    }
    const data = new EventSet(events);
    const sessions = data.index.list();
    const n = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
    const notes = [`Loaded ${n(events.length, 'event')} from ${n(list.length, 'file')}: ${n(sessions.length, 'session')} on ${n(data.index.days().length, 'day')}.`];
    if (skipped) notes.push(`${n(skipped, 'line')} skipped (not JSON, or not an event).`);
    if (duplicates) notes.push(`${n(duplicates, 'duplicate event')} ignored.`);
    if (!sessions.length) notes.push('No agent sessions in these files; is this Snagboat’s events folder?');
    dataNote.textContent = notes.join(' ');
    examplesBtn.hidden = false;
    tracesBtn.hidden = !traces;
    examplesNote.hidden = true;
    mountExplorer(data, data.listAll().sessions.slice(0, 2).map((s) => s.sessionId));
  }

  filesInput.addEventListener('change', () => {
    void loadFiles(filesInput.files ?? []).finally(() => {
      filesInput.value = ''; // so picking the same files again reloads them
    });
  });
  examplesBtn.addEventListener('click', () => useBuiltIn('generated'));
  tracesBtn.addEventListener('click', () => useBuiltIn('traces'));

  // The drop zone; a drop anywhere else must not make the browser open the file.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
  drop.addEventListener('dragover', () => drop.classList.add('over'));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    drop.classList.remove('over');
    void loadFiles(e.dataTransfer?.files ?? []);
  });

  useBuiltIn('traces');
}
