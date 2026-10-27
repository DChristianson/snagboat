import { SeenMessages, TurnTracker } from './normalize';

/**
 * Checkpoint state. Version 1 (unversioned) was a flat { [transcriptPath]: offset }
 * map; version 2 adds the recent message ids per file that keep split messages
 * from being counted twice across a restart.
 */
export interface CheckpointStateV2 {
  version: 2;
  offsets: Record<string, number>;
  recentMessageIds: Record<string, string[]>;
  /** Each transcript file's most recent turn, so attribution survives a restart. Added later in v2; optional. */
  lastTurnByFile?: Record<string, string>;
}

/** keep drops entries for files that no longer exist (see keepCheckpointEntry); by default everything is kept. */
export function readCheckpointState(
  state: Record<string, unknown> | undefined,
  keep: (file: string) => boolean = () => true
): { offsets: Map<string, number>; seen: SeenMessages; turns: TurnTracker } {
  const offsets = new Map<string, number>();
  const kept = <T>(record: Record<string, T> | undefined) => Object.fromEntries(Object.entries(record ?? {}).filter(([file]) => keep(file)));
  if (state?.version === 2) {
    const v2 = state as unknown as CheckpointStateV2;
    for (const [file, offset] of Object.entries(kept(v2.offsets))) {
      if (typeof offset === 'number') offsets.set(file, offset);
    }
    return { offsets, seen: new SeenMessages(kept(v2.recentMessageIds)), turns: new TurnTracker(kept(v2.lastTurnByFile)) };
  }
  for (const [file, offset] of Object.entries(kept(state as Record<string, unknown> | undefined))) {
    if (typeof offset === 'number') offsets.set(file, offset);
  }
  return { offsets, seen: new SeenMessages(), turns: new TurnTracker() };
}
