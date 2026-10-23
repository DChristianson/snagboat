import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EventBus } from './core/eventBus';
import { EventLog } from './core/eventLog';
import { Aggregate, AggregateSnapshot, TodayAggregate } from './core/aggregate';
import { EventStore, ReadonlyEventStore } from './core/eventStore';
import { CheckpointStore } from './core/checkpointStore';
import { DailyHistory } from './core/dailyHistory';
import { ContextLimits, ModelContextMarks } from './core/contextLimits';
import { AggregateStore, EventSink, RetentionPolicy, applyRetention } from './core/retention';
import { HealthRegistry } from './core/health';
import { makeAdapterContext } from './core/adapterContext';
import { AgentAdapter, NormalizedEventKind } from './core/types';
import { renderStatusBar } from './ui/statusBar';
import { buildBreakdownLines } from './ui/format';
import { buildDetailState, TIMELINE_LIMIT } from './ui/detailModel';
import { DetailPanel } from './ui/detailPanel';
import { EditTrackerAdapter } from './adapters/edit-tracker';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { CopilotAdapter } from './adapters/copilot';
import { FindingsRegistry } from './heuristics/findingsRegistry';
import { HeuristicsEngine } from './heuristics/engine';
import { builtInHeuristics, heuristicSettings } from './heuristics/index';
import { Finding } from './heuristics/types';

const POLL_INTERVAL_MS = 30_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const MUTED_HEURISTICS_KEY = 'snagboat.mutedHeuristics';

// Generous placeholder sizing, comfortably covering every planned heuristic's
// short window (minutes) without yet reading heuristic settings -- revisited
// once those settings exist and can drive this properly.
const EVENT_STORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENT_STORE_MAX_EVENTS = 5000;

function retentionPolicy(): RetentionPolicy {
  const config = vscode.workspace.getConfiguration('snagboat.retention');
  return {
    rawDays: config.get<number>('rawDays', 90),
    aggregateDays: config.get<number>('aggregateDays', -1),
  };
}

function captureContentEnabled(): boolean {
  return vscode.workspace.getConfiguration('snagboat').get<boolean>('captureContent', false);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SnagboatTestApi {
  getAggregateSnapshot(): AggregateSnapshot;
  getTodaySnapshot(): AggregateSnapshot;
  getEventStore(): ReadonlyEventStore;
  getContextLimits(): Record<string, ModelContextMarks>;
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

  const aggregateStore = new AggregateStore(storageDir);
  await aggregateStore.init();

  // Prune before rehydrating, so nothing past retention is ever loaded.
  try {
    await applyRetention(eventLog, aggregateStore, retentionPolicy(), todayKey());
  } catch (err) {
    console.error('snagboat: retention failed on activation', err);
  }

  const aggregate = new Aggregate();
  await aggregate.rehydrateFrom(eventLog, aggregateStore);
  const todayAggregate = new TodayAggregate();
  await todayAggregate.rehydrateFrom(eventLog);
  const dailyHistory = new DailyHistory();
  await dailyHistory.rehydrateFrom(eventLog, aggregateStore);

  const eventStore = new EventStore({ windowMs: EVENT_STORE_WINDOW_MS, maxEvents: EVENT_STORE_MAX_EVENTS });
  await eventStore.rehydrateFrom(eventLog);

  // Shared by every workspace, so it lives in global storage, not this workspace's.
  const contextLimits = new ContextLimits(context.globalStorageUri.fsPath);
  await contextLimits.load();
  // Seed from recent history already in memory (new events update it as they arrive).
  for (const event of eventStore.query()) contextLimits.observe(event);
  context.subscriptions.push({ dispose: () => void contextLimits.dispose() });

  const health = new HealthRegistry();

  const findings = new FindingsRegistry(context.workspaceState.get<string[]>(MUTED_HEURISTICS_KEY, []));
  const engine = new HeuristicsEngine(builtInHeuristics(), eventStore, heuristicSettings);
  const runHeuristics = (kind?: NormalizedEventKind) => {
    const now = new Date().toISOString();
    const results = kind ? engine.tickFor(kind, now) : engine.tick(now);
    for (const [id, list] of results) findings.report(id, list);
  };

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snagboat.openDetail';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const outputChannel = vscode.window.createOutputChannel('Snagboat');
  context.subscriptions.push(outputChannel);

  const detailPanel = new DetailPanel(context.extensionUri, {
    buildState: (isOpenable) =>
      buildDetailState({
        now: new Date().toISOString(),
        capture: { enabled: captureContentEnabled(), retentionDays: retentionPolicy().rawDays },
        today: todayAggregate.snapshot(),
        recentEvents: eventStore.lastN(TIMELINE_LIMIT + 1),
        findings: findings.views(),
        muted: findings.mutedHeuristics(),
        daily: dailyHistory.tokensByDay(),
        isOpenable,
      }),
    acknowledge: (heuristicId) => findings.acknowledge(heuristicId),
    setMuted: (heuristicId, muted) => {
      findings.setMuted(heuristicId, muted);
      void context.workspaceState.update(MUTED_HEURISTICS_KEY, findings.mutedHeuristics());
    },
  });
  context.subscriptions.push(detailPanel);

  const refresh = () => {
    renderStatusBar(statusBarItem, aggregate.snapshot(), health.list(), todayAggregate.snapshot(), findings.visible(), findings.worst());
    detailPanel.scheduleUpdate();
  };
  refresh();
  health.onChange(refresh);
  findings.onChange(refresh);

  const bus = new EventBus();
  // Retention runs, aggregate merges from the sink, and Clear Event Log all
  // touch the same files, so they share one queue and never interleave.
  let retentionQueue: Promise<void> = Promise.resolve();
  const enqueueStorageOp = (op: () => Promise<void>) => {
    retentionQueue = retentionQueue.then(op).catch((err) => console.error('snagboat: storage operation failed', err));
  };
  const sink = new EventSink(eventLog, aggregateStore, retentionPolicy, todayKey, enqueueStorageOp);

  bus.onEvent((event) => {
    contextLimits.observe(event);
    // An event older than all retention isn't stored, so it's left out of the
    // all-time totals and chart too; they'd otherwise drop on the next reload.
    if (sink.write(event)) {
      aggregate.apply(event);
      dailyHistory.apply(event);
    }
    todayAggregate.apply(event);
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

  // Long-lived windows cross midnight, so retention reruns hourly as well as
  // whenever its settings change. Runs are serialized so two never race over
  // the same files.
  const runRetention = () => {
    retentionQueue = retentionQueue
      .then(async () => {
        const result = await applyRetention(eventLog, aggregateStore, retentionPolicy(), todayKey());
        for (const daily of result.dropped) {
          aggregate.applyDaily(daily, -1);
          dailyHistory.removeDay(daily.date);
        }
        if (result.dropped.length > 0) refresh();
      })
      .catch((err) => console.error('snagboat: retention failed', err));
    return retentionQueue;
  };
  const retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(retentionTimer) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('snagboat.retention')) runRetention();
      if (e.affectsConfiguration('snagboat.captureContent')) detailPanel.scheduleUpdate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat.showBreakdown', () => {
      outputChannel.clear();
      outputChannel.appendLine(buildBreakdownLines(aggregate.snapshot(), health.list(), findings.visible(), todayAggregate.snapshot()).join('\n'));
      const limits = Object.entries(contextLimits.all()).sort(([a], [b]) => a.localeCompare(b));
      if (limits.length > 0) {
        outputChannel.appendLine('\nContext by model (all workspaces):');
        for (const [model, marks] of limits) {
          const parts = [marks.largestSeen !== undefined ? `largest seen ${marks.largestSeen.toLocaleString()}` : undefined, marks.limit !== undefined ? `limit ${marks.limit.toLocaleString()} (auto-compaction)` : undefined].filter(Boolean);
          outputChannel.appendLine(`  ${model}: ${parts.join(', ')}`);
        }
      }
      outputChannel.show();
    }),
    vscode.commands.registerCommand('snagboat.openDetail', () => detailPanel.show())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat.clearLog', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Delete all Snagboat event logs and daily aggregates for this workspace? This cannot be undone.',
        { modal: true, detail: 'Adapter checkpoints are kept, so already-seen transcript and log history is not re-imported.' },
        'Delete'
      );
      if (choice !== 'Delete') return;
      // Queued behind any in-flight retention run so the two never touch the same files at once.
      // In-memory state is reset in the same continuation as the last file
      // delete, so no event can land between the wipe and the reset.
      const clearOp = retentionQueue.then(async () => {
        await aggregateStore.clear();
        await eventLog.clear();
        aggregate.reset();
        todayAggregate.reset();
        dailyHistory.reset();
        eventStore.reset();
      });
      retentionQueue = clearOp.catch(() => undefined);
      try {
        await clearOp;
      } catch (err) {
        vscode.window.showErrorMessage(`Snagboat: failed to clear event log: ${String(err)}`);
        return;
      }
      runHeuristics();
      refresh();
      vscode.window.showInformationMessage('Snagboat: event log cleared.');
    })
  );

  const adapters: AgentAdapter[] = [new EditTrackerAdapter(), new ClaudeCodeAdapter(), new CopilotAdapter()];
  for (const adapter of adapters) {
    const adapterCtx = makeAdapterContext(adapter.agentId, bus, checkpoints, health, captureContentEnabled);
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

  // Dev/test-only: emits a synthetic Claude Code turn (35 tokens) through the full
  // bus -> log -> aggregate -> status bar pipeline; the integration suite relies on
  // it. Hidden from the command palette (package.json menus.commandPalette) since it
  // writes a fake event into the user's real log; still callable via executeCommand.
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
    getTodaySnapshot: () => todayAggregate.snapshot(),
    getEventStore: () => eventStore,
    getFindings: () => findings.list(),
    getContextLimits: () => contextLimits.all(),
  };
}

export function deactivate() {}
