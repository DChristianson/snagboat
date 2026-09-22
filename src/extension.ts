import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EventBus } from './core/eventBus';
import { EventLog } from './core/eventLog';
import { Aggregate, AggregateSnapshot } from './core/aggregate';
import { EventStore, ReadonlyEventStore } from './core/eventStore';
import { CheckpointStore } from './core/checkpointStore';
import { HealthRegistry } from './core/health';
import { makeAdapterContext } from './core/adapterContext';
import { AgentAdapter, NormalizedEventKind } from './core/types';
import { renderStatusBar } from './ui/statusBar';
import { buildBreakdownLines } from './ui/format';
import { EditTrackerAdapter } from './adapters/edit-tracker';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { CopilotAdapter } from './adapters/copilot';
import { FindingsRegistry } from './heuristics/findingsRegistry';
import { HeuristicsEngine } from './heuristics/engine';
import { builtInHeuristics, heuristicSettings } from './heuristics/index';
import { Finding } from './heuristics/types';

const POLL_INTERVAL_MS = 30_000;

// Generous placeholder sizing, comfortably covering every planned heuristic's
// short window (minutes) without yet reading heuristic settings -- revisited
// once those settings exist and can drive this properly.
const EVENT_STORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENT_STORE_MAX_EVENTS = 5000;

export interface SnagboatTestApi {
  getAggregateSnapshot(): AggregateSnapshot;
  getEventStore(): ReadonlyEventStore;
  getFindings(): Finding[];
}

export async function activate(context: vscode.ExtensionContext): Promise<SnagboatTestApi> {
  const storageUri = context.storageUri ?? context.globalStorageUri;
  await vscode.workspace.fs.createDirectory(storageUri);
  const storageDir = storageUri.fsPath;

  const eventLog = new EventLog(storageDir);
  await eventLog.init();
  const checkpoints = new CheckpointStore(storageDir);
  await checkpoints.init();

  const aggregate = new Aggregate();
  await aggregate.rehydrateFrom(eventLog);

  const eventStore = new EventStore({ windowMs: EVENT_STORE_WINDOW_MS, maxEvents: EVENT_STORE_MAX_EVENTS });
  await eventStore.rehydrateFrom(eventLog);

  const health = new HealthRegistry();

  const findings = new FindingsRegistry();
  const engine = new HeuristicsEngine(builtInHeuristics(), eventStore, heuristicSettings);
  const runHeuristics = (kind?: NormalizedEventKind) => {
    const now = new Date().toISOString();
    const results = kind ? engine.tickFor(kind, now) : engine.tick(now);
    for (const [id, list] of results) findings.report(id, list);
  };

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snagboat.showBreakdown';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const outputChannel = vscode.window.createOutputChannel('Snagboat');
  context.subscriptions.push(outputChannel);

  const refresh = () => renderStatusBar(statusBarItem, aggregate.snapshot(), health.list(), findings.list(), findings.worst());
  refresh();
  health.onChange(refresh);
  findings.onChange(refresh);

  const bus = new EventBus();
  bus.onEvent((event) => {
    eventLog.append(event);
    aggregate.apply(event);
    eventStore.ingest(event);
    runHeuristics(event.kind);
    refresh();
  });

  // Catch a stalled/over-budget condition immediately on activation (e.g. the
  // workspace was already idle before this window opened), rather than
  // waiting for the first timer tick.
  runHeuristics();
  const pollTimer = setInterval(() => {
    runHeuristics();
    refresh();
  }, POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat.showBreakdown', () => {
      outputChannel.clear();
      outputChannel.appendLine(buildBreakdownLines(aggregate.snapshot(), health.list(), findings.list()).join('\n'));
      outputChannel.show();
    })
  );

  const adapters: AgentAdapter[] = [new EditTrackerAdapter(), new ClaudeCodeAdapter(), new CopilotAdapter()];
  for (const adapter of adapters) {
    const adapterCtx = makeAdapterContext(adapter.agentId, bus, checkpoints, health);
    await adapter.init(adapterCtx);
    await adapter.start();
  }
  context.subscriptions.push({
    dispose: () => {
      for (const adapter of adapters) {
        adapter.stop();
      }
    },
  });

  // Dev-only: manually emit a synthetic event to prove the bus -> log -> aggregate ->
  // status bar pipeline works end to end before any real adapter exists. Not exposed
  // as a command palette entry (absent from package.json contributes.commands).
  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat._emitTestEvent', () => {
      bus.publish({
        eventId: crypto.randomUUID(),
        sessionId: 'dev-test-session',
        agent: 'claude-code',
        ts: new Date().toISOString(),
        kind: 'turn_stop',
        status: 'unknown',
        model: 'claude-sonnet-5',
        tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 0 },
        raw: { adapter: 'dev-test', ref: 'manual' },
      });
    })
  );

  return {
    getAggregateSnapshot: () => aggregate.snapshot(),
    getEventStore: () => eventStore,
    getFindings: () => findings.list(),
  };
}

export function deactivate() {}
