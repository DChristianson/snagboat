import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AgentAdapter, AdapterContext } from '../../core/types';

export class EditTrackerAdapter implements AgentAdapter {
  readonly agentId = 'generic-fs' as const;

  private ctx?: AdapterContext;
  private disposable?: vscode.Disposable;

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    this.disposable = vscode.workspace.onDidSaveTextDocument((document) => {
      this.ctx?.publish({
        eventId: crypto.randomUUID(),
        sessionId: vscode.env.sessionId,
        agent: this.agentId,
        ts: new Date().toISOString(),
        kind: 'edit',
        target: document.uri.fsPath,
        status: 'unknown',
        raw: { adapter: this.agentId, ref: document.uri.toString() },
      });
    });
  }

  async stop(): Promise<void> {
    this.disposable?.dispose();
    this.disposable = undefined;
  }
}
