import * as fs from 'fs';
import * as path from 'path';
import { RuleSource } from './rule';

/** Where a saved rule or category came from, and how it scored when it was accepted. */
export interface Provenance {
  proposedBy: 'you' | 'discovery' | 'advisor' | 'import';
  addedAt: string;
  /** The workspace whose history it was discovered in or scored against; discovery reads only the current workspace's. */
  workspace?: string;
  /** Replay over your history at acceptance: episodes it would have raised, in how many sessions. */
  replay?: { episodes: number; sessions: number };
}

/** Kept as written, not parsed, so a rule that a later version rejects is reported rather than lost. */
export interface SavedDoc {
  doc: Record<string, unknown> & { id: string };
  provenance: Provenance;
}

interface StoredRules {
  version: 1;
  rules: SavedDoc[];
  categories: SavedDoc[];
}

type Section = 'rules' | 'categories';

/**
 * Accepted rules and shell sub-categories, in the extension's global storage
 * so every workspace shares them. Each change re-reads the file first, so
 * windows saving at once don't drop each other's additions.
 */
export class RuleStore {
  private readonly file: string;
  private data: StoredRules = { version: 1, rules: [], categories: [] };

  constructor(globalStorageDir: string) {
    this.file = path.join(globalStorageDir, 'rules.json');
  }

  /** Loads saved rules; an unreadable file loads as empty and throws, so the caller can say so. */
  async load(): Promise<void> {
    try {
      this.data = await this.readFile();
    } catch (err) {
      this.data = { version: 1, rules: [], categories: [] };
      throw err;
    }
  }

  source(): RuleSource {
    return { origin: 'saved', rules: this.data.rules.map((r) => r.doc), categories: this.data.categories.map((c) => c.doc) };
  }

  list(section: Section): SavedDoc[] {
    return this.data[section].map((s) => ({ doc: { ...s.doc }, provenance: { ...s.provenance } }));
  }

  /** Adds a document, or replaces the one with the same id. */
  save(section: Section, doc: SavedDoc['doc'], provenance: Provenance): Promise<void> {
    return this.update((data) => {
      data[section] = [...data[section].filter((s) => s.doc.id !== doc.id), { doc, provenance }];
    });
  }

  remove(section: Section, id: string): Promise<void> {
    return this.update((data) => {
      data[section] = data[section].filter((s) => s.doc.id !== id);
    });
  }

  private async update(change: (data: StoredRules) => void): Promise<void> {
    const data = await this.readFile();
    change(data);
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.promises.rename(tmp, this.file);
    this.data = data;
  }

  /** Missing reads as empty; a file that's there but unreadable throws, so a save never overwrites rules it couldn't read. */
  private async readFile(): Promise<StoredRules> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rules: [], categories: [] };
      throw err;
    }
    const parsed = JSON.parse(text) as StoredRules;
    if (parsed?.version !== 1 || !Array.isArray(parsed.rules) || !Array.isArray(parsed.categories)) throw new Error(`${this.file} isn't a version 1 rules file`);
    return parsed;
  }
}
