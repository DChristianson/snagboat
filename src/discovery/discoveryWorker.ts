import { parentPort } from 'worker_threads';
import { NormalizedEvent } from '@snagboat/schema';
import { DiscoveryRun, runDiscovery } from './discover';
import { discoveryOptionsOf, WorkerReply, WorkerRequest } from './offThread';

/**
 * The discovery worker (offThread.ts): takes a history's events in chunks, runs discovery over them
 * when asked, and keeps the run to re-score tweaked thresholds and score rules. Bundled on its own
 * as dist/discoveryWorker.js beside the CLI (esbuild.js); compiled to out/discovery/ for tests.
 */

const port = parentPort;
if (port) {
  let events: NormalizedEvent[] = [];
  let run: DiscoveryRun | undefined;
  const answer = (id: number, value: () => unknown) => {
    let reply: WorkerReply;
    try {
      reply = { id, value: value() };
    } catch (err) {
      reply = { id, error: err instanceof Error ? err.message : String(err) };
    }
    port.postMessage(reply);
  };
  const current = (): DiscoveryRun => {
    if (!run) throw new Error('no discovery has run');
    return run;
  };
  port.on('message', (m: WorkerRequest) => {
    switch (m.type) {
      case 'events':
        for (const e of m.events) events.push(e);
        return;
      case 'run':
        return answer(m.id, () => {
          run = runDiscovery(events, discoveryOptionsOf(m.data));
          events = [];
          return run.result;
        });
      case 'tweak':
        return answer(m.id, () => current().tweak(m.ruleId, m.threshold));
      case 'score':
        return answer(m.id, () => current().score(m.rules));
    }
  });
}
