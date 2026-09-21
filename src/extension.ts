import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EventBus } from './core/eventBus';
import { EventLog } from './core/eventLog';
import { Aggregate, AggregateSnapshot } from './core/aggregate';
import { CheckpointStore } from './core/checkpointStore';
import { HealthRegistry } from './core/health';
import { makeAdapterContext } from './core/adapterContext';
import { AgentAdapter } from './core/types';
import { renderStatusBar } from './ui/statusBar';
import { buildBreakdownLines } from './ui/format';
import { EditTrackerAdapter } from './adapters/edit-tracker';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { CopilotAdapter } from './adapters/copilot';

export interface SnagboatTestApi {
  getAggregateSnapshot(): AggregateSnapshot;
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

  const health = new HealthRegistry();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snagboat.showBreakdown';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const outputChannel = vscode.window.createOutputChannel('Snagboat');
  context.subscriptions.push(outputChannel);

  const refresh = () => renderStatusBar(statusBarItem, aggregate.snapshot(), health.list());
  refresh();
  health.onChange(refresh);

  const bus = new EventBus();
  bus.onEvent((event) => {
    eventLog.append(event);
    aggregate.apply(event);
    refresh();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat.showBreakdown', () => {
      outputChannel.clear();
      outputChannel.appendLine(buildBreakdownLines(aggregate.snapshot(), health.list()).join('\n'));
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
  };
}

export function deactivate() {}
