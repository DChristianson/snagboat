import { AgentAdapter, AdapterContext } from '../../core/types';
import { TranscriptTailer } from './transcriptTail';
import { HooksReceiver } from './hooksReceiver';
import { ensureHooksConfigured } from './hooksConfig';
import { resolveProjectDir } from './workspace';

const DEFAULT_HOOKS_PORT = 45679;

function resolveHooksPort(): number {
  const fromEnv = process.env.SNAGBOAT_CLAUDE_HOOKS_PORT;
  return fromEnv ? Number(fromEnv) : DEFAULT_HOOKS_PORT;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId = 'claude-code' as const;

  private ctx?: AdapterContext;
  private offsets = new Map<string, number>();
  private transcriptTailer?: TranscriptTailer;
  private hooksReceiver?: HooksReceiver;

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const checkpoint = await ctx.readCheckpoint();
    const state = (checkpoint?.state as Record<string, number> | undefined) ?? {};
    for (const [file, offset] of Object.entries(state)) {
      this.offsets.set(file, offset);
    }
  }

  async start(): Promise<void> {
    if (!this.ctx) throw new Error('ClaudeCodeAdapter.start() called before init()');

    this.transcriptTailer = new TranscriptTailer(this.ctx, this.offsets, () => this.persistCheckpoint());
    this.transcriptTailer.start();

    const port = resolveHooksPort();
    this.hooksReceiver = new HooksReceiver(this.ctx, port);
    this.hooksReceiver.start();

    const projectDir = resolveProjectDir();
    if (projectDir) {
      await ensureHooksConfigured(projectDir, port);
      this.ctx.reportHealth('hooks', undefined);
    } else {
      this.ctx.reportHealth('hooks', 'no workspace folder open, hooks were not configured');
    }
  }

  async stop(): Promise<void> {
    this.transcriptTailer?.stop();
    this.hooksReceiver?.stop();
  }

  private persistCheckpoint(): void {
    void this.ctx?.writeCheckpoint({
      updatedAt: new Date().toISOString(),
      state: Object.fromEntries(this.offsets),
    });
  }
}
