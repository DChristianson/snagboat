import { AgentAdapter, AdapterContext } from '../../core/types';
import { TranscriptTailer } from './transcriptTail';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId = 'claude-code' as const;

  private ctx?: AdapterContext;
  private offsets = new Map<string, number>();
  private transcriptTailer?: TranscriptTailer;

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
  }

  async stop(): Promise<void> {
    this.transcriptTailer?.stop();
  }

  private persistCheckpoint(): void {
    void this.ctx?.writeCheckpoint({
      updatedAt: new Date().toISOString(),
      state: Object.fromEntries(this.offsets),
    });
  }
}
