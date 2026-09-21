import * as vscode from 'vscode';
import { AgentAdapter, AdapterContext } from '../../core/types';
import { OtelReceiver } from './otelReceiver';

const DEFAULT_OTLP_PORT = 4318;

export class CopilotAdapter implements AgentAdapter {
  readonly agentId = 'copilot' as const;

  private ctx?: AdapterContext;
  private otelReceiver?: OtelReceiver;

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    if (!this.ctx) throw new Error('CopilotAdapter.start() called before init()');
    // Test/CI seam: override the port instead of relying on the vscode setting.
    const port = process.env.SNAGBOAT_COPILOT_OTLP_PORT
      ? Number(process.env.SNAGBOAT_COPILOT_OTLP_PORT)
      : vscode.workspace.getConfiguration('snagboat').get<number>('copilot.otlpPort', DEFAULT_OTLP_PORT);
    this.otelReceiver = new OtelReceiver(this.ctx, port);
    this.otelReceiver.start();
  }

  async stop(): Promise<void> {
    this.otelReceiver?.stop();
  }
}
