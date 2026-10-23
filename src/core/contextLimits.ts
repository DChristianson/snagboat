import * as fs from 'fs';
import * as path from 'path';
import { NormalizedEvent } from './types';

/**
 * Two live marks per model (see docs/design/conversation-view.md):
 * - largestSeen: the biggest context any call to the model has sent;
 * - limit: set only when a limit is actually encountered, i.e. an automatic
 *   compaction (its preTokens). The lowest value encountered wins. Manual
 *   compactions don't count: you chose when they happened.
 */
export interface ModelContextMarks {
  largestSeen?: number;
  largestSeenAt?: string;
  limit?: number;
  limitAt?: string;
  limitSource?: 'auto-compaction';
}

interface StoredLimits {
  version: 1;
  models: Record<string, ModelContextMarks>;
}

/** Context sent by a model call: everything it read, cached or fresh. */
export function contextSize(event: NormalizedEvent): number | undefined {
  const t = event.tokens;
  if (!t) return undefined;
  const size = (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreation ?? 0);
  return size > 0 ? size : undefined;
}

/** Folds b into a: keeps the larger largestSeen and the smaller limit. */
function mergeMarks(a: ModelContextMarks, b: ModelContextMarks): ModelContextMarks {
  const out: ModelContextMarks = { ...a };
  if (b.largestSeen !== undefined && (out.largestSeen === undefined || b.largestSeen > out.largestSeen)) {
    out.largestSeen = b.largestSeen;
    out.largestSeenAt = b.largestSeenAt;
  }
  if (b.limit !== undefined && (out.limit === undefined || b.limit < out.limit)) {
    out.limit = b.limit;
    out.limitAt = b.limitAt;
    out.limitSource = b.limitSource;
  }
  return out;
}

/**
 * Per-model context marks, kept in the extension's global storage so every
 * workspace shares them. Writes are debounced and merge with what's on disk,
 * so windows updating concurrently never lose each other's values.
 */
export class ContextLimits {
  private readonly file: string;
  private models = new Map<string, ModelContextMarks>();
  private dirty = new Set<string>();
  private saveTimer?: NodeJS.Timeout;

  constructor(globalStorageDir: string, private readonly saveDelayMs = 5_000) {
    this.file = path.join(globalStorageDir, 'context-limits.json');
  }

  async load(): Promise<void> {
    for (const [model, marks] of Object.entries((await this.readFile()).models)) this.models.set(model, marks);
  }

  /** Updates the marks from a model call or a compaction; returns true if anything changed. */
  observe(event: NormalizedEvent): boolean {
    const model = event.model;
    if (!model || model === '<synthetic>') return false;
    let update: ModelContextMarks | undefined;
    if (event.kind === 'turn_stop') {
      const size = contextSize(event);
      if (size !== undefined) update = { largestSeen: size, largestSeenAt: event.ts };
    } else if (event.kind === 'compaction' && event.compaction?.trigger === 'auto' && event.compaction.preTokens) {
      update = { limit: event.compaction.preTokens, limitAt: event.ts, limitSource: 'auto-compaction' };
    }
    if (!update) return false;
    const before = this.models.get(model) ?? {};
    const after = mergeMarks(before, update);
    if (after.largestSeen === before.largestSeen && after.limit === before.limit) return false;
    this.models.set(model, after);
    this.dirty.add(model);
    this.scheduleSave();
    return true;
  }

  get(model: string): ModelContextMarks | undefined {
    const marks = this.models.get(model);
    return marks ? { ...marks } : undefined;
  }

  all(): Record<string, ModelContextMarks> {
    return Object.fromEntries([...this.models].map(([m, marks]) => [m, { ...marks }]));
  }

  /** Writes pending changes now, merged with whatever other windows have written. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.dirty.size === 0) return;
    const onDisk = await this.readFile();
    for (const model of this.dirty) onDisk.models[model] = mergeMarks(onDisk.models[model] ?? {}, this.models.get(model) ?? {});
    this.dirty.clear();
    // Pick up other windows' values for models this window also knows.
    for (const [model, marks] of Object.entries(onDisk.models)) this.models.set(model, mergeMarks(this.models.get(model) ?? {}, marks));
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(onDisk, null, 2));
    await fs.promises.rename(tmp, this.file);
  }

  dispose(): Promise<void> {
    return this.flush();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush().catch((err) => console.error('snagboat: failed to save context limits', err));
    }, this.saveDelayMs);
  }

  private async readFile(): Promise<StoredLimits> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as StoredLimits;
      if (parsed?.version === 1 && parsed.models && typeof parsed.models === 'object') return parsed;
    } catch {
      // missing or unreadable: start fresh
    }
    return { version: 1, models: {} };
  }
}
