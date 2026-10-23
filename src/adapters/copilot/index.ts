import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentAdapter, AdapterContext } from '../../core/types';
import { withRealPaths } from '../../core/paths';
import { resolveWorkspaceFolders } from '../claude-code/workspace';
import { CopilotCliTailer, readCliCheckpoint } from './cliTailer';
import { OtelReceiver } from './otelReceiver';
import { StructureCapture } from './structureCapture';

const DEFAULT_OTLP_PORT = 4318;

/** Test/CI seam: override where Copilot CLI sessions are read from. */
function resolveSessionsDir(): string {
  return process.env.SNAGBOAT_COPILOT_SESSIONS_DIR ?? path.join(os.homedir(), '.copilot', 'session-state');
}

export class CopilotAdapter implements AgentAdapter {
  readonly agentId = 'copilot' as const;

  private ctx?: AdapterContext;
  private otelReceiver?: OtelReceiver;
  private cliTailer?: CopilotCliTailer;

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

    // Agent mode: the Copilot CLI's session logs (it exports no telemetry).
    const { offsets, lastTurns } = readCliCheckpoint((await this.ctx.readCheckpoint())?.state);
    const folders = withRealPaths(resolveWorkspaceFolders());
    if (folders.length > 0) {
      const ctx = this.ctx;
      // Test/CI seam: discover new sessions faster than the 60-second default.
      const discoveryIntervalMs = process.env.SNAGBOAT_COPILOT_DISCOVERY_MS ? Number(process.env.SNAGBOAT_COPILOT_DISCOVERY_MS) : undefined;
      this.cliTailer = new CopilotCliTailer(
        ctx,
        resolveSessionsDir(),
        folders,
        offsets,
        lastTurns,
        () => void ctx.writeCheckpoint({ updatedAt: new Date().toISOString(), state: { ...this.cliTailer!.checkpoint() } }),
        { discoveryIntervalMs }
      );
      this.cliTailer.start();
    }
  }

  async stop(): Promise<void> {
    this.otelReceiver?.stop();
    this.cliTailer?.stop();
  }
}
