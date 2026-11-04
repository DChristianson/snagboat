import * as fs from 'fs';
import * as path from 'path';
import { marksFromEvent, mergeMarks, ModelContextMarks } from './contextMarks';
import { NormalizedEvent } from './types';

// The marks and their rules live in contextMarks.ts (no fs, so the web demo
// bundles them); they're still available from here.
export { contextSize } from './contextMarks';
export type { ModelContextMarks } from './contextMarks';

interface StoredLimits {
  version: 1;
  models: Record<string, ModelContextMarks>;
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
    const found = marksFromEvent(event);
    if (!found) return false;
    const { model, marks: update } = found;
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
