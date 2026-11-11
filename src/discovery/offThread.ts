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
 * history's events stay on this side too, for the advisor's examples.
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

/**
 * Runs discovery over the events in a worker thread and keeps the worker for the run's tweaks and
 * scores until it's disposed. Rejects if the worker fails; a failed worker's later requests reject too.
 */
export async function discoverOffThread(events: NormalizedEvent[], data: DiscoveryData, script = WORKER_SCRIPT): Promise<AsyncDiscoveryRun> {
  const worker = new Worker(script);
  // The core's server keeps the process alive; a worker alone shouldn't.
  worker.unref();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  let failed: Error | undefined;
  const fail = (err: Error) => {
    failed ??= err;
    for (const p of pending.values()) p.reject(failed);
    pending.clear();
  };
  worker.on('message', (reply: WorkerReply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if ('error' in reply) p.reject(new Error(reply.error));
    else p.resolve(reply.value);
  });
  worker.on('error', (err) => fail(err));
  worker.on('exit', (code) => fail(new Error(`discovery worker stopped (exit code ${code})`)));
  const ask = <T>(request: WithoutId<Asked>): Promise<T> => {
    if (failed) return Promise.reject(failed);
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...request, id });
    });
  };

  try {
    for (let i = 0; i < events.length; i += CHUNK) {
      if (failed) throw failed;
      worker.postMessage({ type: 'events', events: events.slice(i, i + CHUNK) } satisfies WorkerRequest);
      await new Promise((r) => setImmediate(r));
    }
    const result = await ask<DiscoveryResult>({ type: 'run', data });
    const h = history(events);
    return {
      result,
      tweak: (ruleId, threshold) => ask<Candidate | undefined>({ type: 'tweak', ruleId, threshold }),
      score: (rules) => ask<Map<string, Score>>({ type: 'score', rules }),
      sessionEvents: (sessionId) => h.bySession().get(sessionId) ?? [],
      get events() {
        return h.sorted();
      },
      dispose: () => void worker.terminate(),
    };
  } catch (err) {
    void worker.terminate();
    throw err;
  }
}
