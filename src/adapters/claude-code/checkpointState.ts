import { SeenMessages } from './normalize';

/**
 * Checkpoint state. Version 1 (unversioned) was a flat { [transcriptPath]: offset }
 * map; version 2 adds the recent message ids per file that keep split messages
 * from being counted twice across a restart.
 */
export interface CheckpointStateV2 {
  version: 2;
  offsets: Record<string, number>;
  recentMessageIds: Record<string, string[]>;
}

export function readCheckpointState(state: Record<string, unknown> | undefined): { offsets: Map<string, number>; seen: SeenMessages } {
  const offsets = new Map<string, number>();
  if (state?.version === 2) {
    const v2 = state as unknown as CheckpointStateV2;
    for (const [file, offset] of Object.entries(v2.offsets ?? {})) {
      if (typeof offset === 'number') offsets.set(file, offset);
    }
    return { offsets, seen: new SeenMessages(v2.recentMessageIds ?? {}) };
  }
  for (const [file, offset] of Object.entries(state ?? {})) {
    if (typeof offset === 'number') offsets.set(file, offset);
  }
  return { offsets, seen: new SeenMessages() };
}
