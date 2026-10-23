import * as vscode from 'vscode';
import { AgentAdapter, AdapterContext } from '../../core/types';
import { OtelReceiver } from './otelReceiver';
import { StructureCapture } from './structureCapture';

const DEFAULT_OTLP_PORT = 4318;

export class CopilotAdapter implements AgentAdapter {
  readonly agentId = 'copilot' as const;

  private ctx?: AdapterContext;
  private otelReceiver?: OtelReceiver;

  /** @param captureDir where snagboat.copilot.captureStructure writes, if turned on. */
  constructor(private readonly captureDir?: string) {}

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    if (!this.ctx) throw new Error('CopilotAdapter.start() called before init()');
    // Test/CI seam: override the port instead of relying on the vscode setting.
    const port = process.env.SNAGBOAT_COPILOT_OTLP_PORT
      ? Number(process.env.SNAGBOAT_COPILOT_OTLP_PORT)
      : vscode.workspace.getConfiguration('snagboat').get<number>('copilot.otlpPort', DEFAULT_OTLP_PORT);
    const capture = this.captureDir ? new StructureCapture(this.captureDir) : undefined;
    this.otelReceiver = new OtelReceiver(this.ctx, port, () =>
      capture && vscode.workspace.getConfiguration('snagboat').get<boolean>('copilot.captureStructure', false)
        ? (url, payload) => capture.record(url, payload)
        : undefined
    );
    this.otelReceiver.start();
  }

  async stop(): Promise<void> {
    this.otelReceiver?.stop();
  }
}
