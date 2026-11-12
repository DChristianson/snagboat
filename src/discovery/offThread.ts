import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { NormalizedEvent } from '@snagboat/schema';
import { builtInHeuristics } from '../heuristics/builtIns';
import { Rule } from '../heuristics/rule';
import { ruleHeuristic } from '../heuristics/ruleHeuristic';
import { Candidate, DiscoveryOptions, DiscoveryResult, DiscoveryRun, Score } from './discover';

/**
 * Discovery off the event loop. In the core, discovery (seconds of CPU on a long history) and
 * re-scoring a tweaked threshold run in a worker thread (discoveryWorker.ts), so hooks, event
 * posts and the UI keep their answers meanwhile. DiscoveryOptions holds functions, which don't
 * cross to a worker, so it goes as DiscoveryData: built-ins by id, rules as parsed (plain data),
 * settings and context limits as snapshots. The worker keeps its run for tweaks and scores; the
 * history's events stay on this side too, for the advisor's examples and to bring back a worker
 * stopped for sitting idle (meanwhile the history is held only here, not in both threads).
 */

/** DiscoveryOptions as plain data, for a worker. */
export interface DiscoveryData {
  /** Built-in heuristics running, by id, in their order; then the rules. */
  builtIns: string[];
  rules: Rule[];
  /** Each heuristic's settings by id; any other id has none. */
  settings: Record<string, Record<string, unknown>>;
  /** Context window by model. */
  contextLimits: Record<string, number>;
  tail?: number;
}

/** The options DiscoveryData stands for: the same built-ins and rules as heuristics, the snapshots as functions. */
export function discoveryOptionsOf(data: DiscoveryData): DiscoveryOptions {
  const wanted = new Set(data.builtIns);
  const builtIns = new Map(builtInHeuristics().filter((h) => wanted.has(h.id)).map((h) => [h.id, h]));
  return {
    existing: [...data.builtIns.flatMap((id) => builtIns.get(id) ?? []), ...data.rules.map(ruleHeuristic)],
    settingsFor: (id) => data.settings[id] ?? {},
    contextLimit: (model) => (model ? data.contextLimits[model] : undefined),
    ...(data.tail !== undefined ? { tail: data.tail } : {}),
  };
}

/** A finished discovery whose re-scoring may run elsewhere (a worker): DiscoveryRun with promises. */
export interface AsyncDiscoveryRun {
  result: DiscoveryResult;
  tweak(ruleId: string, threshold: number): Promise<Candidate | undefined>;
  score(rules: Rule[]): Promise<Map<string, Score>>;
  sessionEvents(sessionId: string): NormalizedEvent[];
  readonly events: NormalizedEvent[];
  /** Lets go of what the run keeps (its worker). */
  dispose(): void;
}

/** An in-process run, as VS Code's Suggestions tab keeps it. */
export function inProcess(run: DiscoveryRun): AsyncDiscoveryRun {
  return {
    result: run.result,
    tweak: async (ruleId, threshold) => run.tweak(ruleId, threshold),
    score: async (rules) => run.score(rules),
    sessionEvents: (sessionId) => run.sessionEvents(sessionId),
    events: run.events,
    dispose: () => undefined,
  };
}

/** The worker's script, beside this module: dist/discoveryWorker.js beside the bundled CLI, out/discovery/ in compiled tests. */
export const WORKER_SCRIPT = path.join(__dirname, 'discoveryWorker.js');

export function workerAvailable(script = WORKER_SCRIPT): boolean {
  return fs.existsSync(script);
}

/** Events go to the worker this many at a time, a turn of the event loop apart, so no one copy holds it up. */
const CHUNK = 2000;

export type WorkerRequest =
  | { type: 'events'; events: NormalizedEvent[] }
  | { type: 'run'; id: number; data: DiscoveryData }
  | { type: 'tweak'; id: number; ruleId: string; threshold: number }
  | { type: 'score'; id: number; rules: Rule[] };

type Asked = Extract<WorkerRequest, { id: number }>;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export type WorkerReply = { id: number; value: unknown } | { id: number; error: string };

/** The history's events in time order, and by session, as runDiscovery keeps them; worked out on first use. */
function history(events: NormalizedEvent[]): { sorted: () => NormalizedEvent[]; bySession: () => Map<string, NormalizedEvent[]> } {
  let sorted: NormalizedEvent[] | undefined;
  let bySession: Map<string, NormalizedEvent[]> | undefined;
  const sortedOnce = () => (sorted ??= [...events].sort((a, b) => a.ts.localeCompare(b.ts)));
  return {
    sorted: sortedOnce,
    bySession: () => {
      if (!bySession) {
        bySession = new Map();
        for (const e of sortedOnce()) {
          const list = bySession.get(e.sessionId);
          if (list) list.push(e);
          else bySession.set(e.sessionId, [e]);
        }
      }
      return bySession;
    },
  };
}

/** How long a run's worker may sit unasked before it's stopped: the core's default. */
export const DEFAULT_WORKER_IDLE_MS = 15 * 60_000;

export interface OffThreadOptions {
  /** The worker's script; default WORKER_SCRIPT. */
  script?: string;
  /**
   * Stop the worker after this long with nothing asked of it (0 or absent: keep it until disposed).
   * The next tweak or score starts a new one over the same events and data, which gives the same
   * answers (discovery is deterministic), so only the first answer after a stop is slower.
   */
  idleMs?: number;
  /** Told when an idle worker is stopped and when one is brought back. */
  log?: (line: string) => void;
}

/** A run whose worker may be stopped while idle and brought back on the next request. */
export interface OffThreadRun extends AsyncDiscoveryRun {
  /** Whether its worker is up now. */
  readonly workerRunning: boolean;
  /** How many times a stopped worker was brought back. */
  readonly restarts: number;
}

/** One worker thread and the requests it hasn't answered. */
class DiscoveryWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private failed?: Error;

  constructor(script: string) {
    this.worker = new Worker(script);
    // The core's server keeps the process alive; a worker alone shouldn't.
    this.worker.unref();
    this.worker.on('message', (reply: WorkerReply) => {
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if ('error' in reply) p.reject(new Error(reply.error));
      else p.resolve(reply.value);
    });
    this.worker.on('error', (err) => this.fail(err));
    this.worker.on('exit', (code) => this.fail(new Error(`discovery worker stopped (exit code ${code})`)));
  }

  private fail(err: Error): void {
    this.failed ??= err;
    for (const p of this.pending.values()) p.reject(this.failed);
    this.pending.clear();
  }

  /** Sends the events, a turn of the event loop apart, and runs discovery over them. */
  async run(events: NormalizedEvent[], data: DiscoveryData): Promise<DiscoveryResult> {
    for (let i = 0; i < events.length; i += CHUNK) {
      if (this.failed) throw this.failed;
      this.worker.postMessage({ type: 'events', events: events.slice(i, i + CHUNK) } satisfies WorkerRequest);
      await new Promise((r) => setImmediate(r));
    }
    return this.ask<DiscoveryResult>({ type: 'run', data });
  }

  ask<T>(request: WithoutId<Asked>): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  stop(): void {
    void this.worker.terminate();
  }
}

/**
 * Runs discovery over the events in a worker thread and keeps the worker for the run's tweaks and
 * scores until it's disposed, or until it has sat `idleMs` with nothing asked of it; the next tweak
 * or score then brings a worker back over the same events and data. Rejects if the worker fails; a
 * failed worker's later requests reject too.
 */
export async function discoverOffThread(events: NormalizedEvent[], data: DiscoveryData, options: string | OffThreadOptions = {}): Promise<OffThreadRun> {
  const { script = WORKER_SCRIPT, idleMs = 0, log = () => undefined } = typeof options === 'string' ? { script: options } : options;
  const first = new DiscoveryWorker(script);
  let result: DiscoveryResult;
  try {
    result = await first.run(events, data);
  } catch (err) {
    first.stop();
    throw err;
  }

  /** The live worker; undefined once stopped for idling, or disposed. */
  let worker: DiscoveryWorker | undefined = first;
  /** A worker being brought back, shared by the requests waiting for it. */
  let starting: Promise<DiscoveryWorker> | undefined;
  /** Requests asked and not yet answered: the worker is never stopped under one. */
  let busy = 0;
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  let restarts = 0;
  const letGo = () => new Error('discovery worker stopped (the run was let go)');

  /** (Re)starts the idle countdown when nothing is in flight; clears it otherwise. */
  const countdown = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !(idleMs > 0) || busy > 0 || !worker) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || busy > 0 || !worker) return;
      worker.stop();
      worker = undefined;
      log(`the discovery worker sat idle for ${Math.round(idleMs / 1000)}s; stopped it`);
    }, idleMs);
    // Nor should its timer keep the process alive.
    timer.unref();
  };

  const live = (): Promise<DiscoveryWorker> => {
    if (worker) return Promise.resolve(worker);
    starting ??= (async () => {
      log('bringing the discovery worker back');
      const w = new DiscoveryWorker(script);
      try {
        // The same events and data make the same run, so its answers match the result already shown.
        await w.run(events, data);
      } catch (err) {
        w.stop();
        throw err;
      }
      if (disposed) {
        w.stop();
        throw letGo();
      }
      restarts += 1;
      worker = w;
      return w;
    })().finally(() => (starting = undefined));
    return starting;
  };

  const request = async <T>(asked: WithoutId<Asked>): Promise<T> => {
    if (disposed) throw letGo();
    busy += 1;
    countdown();
    try {
      return await (await live()).ask<T>(asked);
    } finally {
      busy -= 1;
      countdown();
    }
  };

  countdown();
  const h = history(events);
  return {
    result,
    tweak: (ruleId, threshold) => request<Candidate | undefined>({ type: 'tweak', ruleId, threshold }),
    score: (rules) => request<Map<string, Score>>({ type: 'score', rules }),
    sessionEvents: (sessionId) => h.bySession().get(sessionId) ?? [],
    get events() {
      return h.sorted();
    },
    get workerRunning() {
      return worker !== undefined;
    },
    get restarts() {
      return restarts;
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      worker?.stop();
      worker = undefined;
    },
  };
}
