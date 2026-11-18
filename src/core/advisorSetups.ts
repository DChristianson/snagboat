import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SetupConversation, SetupEvent, SetupModel, SetupTurn } from '@snagboat/schema';

/**
 * Setup conversations (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.15): setting up an advisor
 * by talking it through with a model. Each is an append-only log of lines (SetupEvent): started (the
 * model you picked), said (your turn, with the model you switched to if you did), answered (the model's
 * reply and maybe a proposed advisor, with the model that answered), revised (your note on its proposal),
 * then accepted or discarded. A draft lives in ~/.snagboat/advisor-drafts/<id>/setup.jsonl. Accepting
 * moves the file to ~/.snagboat/advisors/<advisor id>/setup.jsonl, kept with the advisor it made, as its
 * setup conversation; a discarded draft stays where it was.
 */

const ID = /^s-\d{8}-[0-9a-f]{6}$/;
const FILE = 'setup.jsonl';

export class AdvisorSetupStore {
  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private get draftsDir(): string {
    return path.join(this.home, 'advisor-drafts');
  }

  private get advisorsDir(): string {
    return path.join(this.home, 'advisors');
  }

  static isId(id: string): boolean {
    return ID.test(id);
  }

  /** Where a conversation's lines are: its draft, or the advisor it made. */
  private fileOf(id: string): string | undefined {
    if (!ID.test(id)) return undefined;
    const draft = path.join(this.draftsDir, id, FILE);
    if (fs.existsSync(draft)) return draft;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.advisorsDir);
    } catch {
      return undefined;
    }
    for (const d of dirs) {
      const f = path.join(this.advisorsDir, d, FILE);
      if (this.read(f)[0]?.setup === id) return f;
    }
    return undefined;
  }

  private read(file: string): SetupEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: SetupEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SetupEvent;
        if (e && e.version === 1 && typeof e.setup === 'string' && typeof e.type === 'string') out.push(e);
      } catch {
        // a torn last line from a crash: skipped
      }
    }
    return out;
  }

  /** Every line of a conversation, oldest first. */
  events(id: string): SetupEvent[] {
    const f = this.fileOf(id);
    return f ? this.read(f) : [];
  }

  get(id: string): SetupConversation | undefined {
    return fold(this.events(id));
  }

  /** The setup conversation an advisor was made from, if it was made by one. */
  forAdvisor(advisor: string): SetupConversation | undefined {
    if (!/^[a-z][a-z0-9-]*$/.test(advisor)) return undefined;
    return fold(this.read(path.join(this.advisorsDir, advisor, FILE)));
  }

  /** Drafts, open and discarded, newest first. */
  drafts(): SetupConversation[] {
    let ids: string[];
    try {
      ids = fs.readdirSync(this.draftsDir).filter((d) => ID.test(d));
    } catch {
      return [];
    }
    return ids
      .map((id) => fold(this.read(path.join(this.draftsDir, id, FILE))))
      .filter((c): c is SetupConversation => !!c)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** A new draft with the model you picked. */
  start(model: SetupModel): SetupConversation {
    const at = this.now();
    const day = at.toISOString().slice(0, 10).replace(/-/g, '');
    const id = `s-${day}-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(path.join(this.draftsDir, id), { recursive: true, mode: 0o700 });
    this.append(id, { type: 'started', model });
    return this.get(id)!;
  }

  /** Adds a line; the conversation must exist. */
  append(id: string, line: Omit<SetupEvent, 'version' | 'at' | 'setup'>): SetupConversation {
    const file = this.fileOf(id) ?? (ID.test(id) && fs.existsSync(path.join(this.draftsDir, id)) ? path.join(this.draftsDir, id, FILE) : undefined);
    if (!file) throw new Error(`no setup conversation ${id}`);
    const event: SetupEvent = { version: 1, at: this.now().toISOString(), setup: id, ...line };
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
    return this.get(id)!;
  }

  /**
   * Records that the draft made an advisor and moves it to that advisor's folder (written already, by
   * writeNewAdvisor) as its setup conversation.
   */
  accept(id: string, advisor: string): SetupConversation {
    const draft = path.join(this.draftsDir, id, FILE);
    if (!ID.test(id) || !fs.existsSync(draft)) throw new Error(`no draft ${id}`);
    const target = path.join(this.advisorsDir, advisor, FILE);
    if (fs.existsSync(target)) throw new Error(`${advisor} already has a setup conversation`);
    this.append(id, { type: 'accepted', advisor });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(draft, target);
    fs.rmSync(path.join(this.draftsDir, id), { recursive: true, force: true });
    return this.get(id)!;
  }
}

/** A conversation from its lines; undefined without a started line first. */
export function fold(events: SetupEvent[]): SetupConversation | undefined {
  const first = events[0];
  if (!first || first.type !== 'started' || !first.model) return undefined;
  const c: SetupConversation = { id: first.setup, status: 'open', model: first.model, turns: [], startedAt: first.at, updatedAt: first.at };
  for (const e of events.slice(1)) {
    c.updatedAt = e.at;
    if (e.type === 'said' || e.type === 'revised') {
      if (e.model) c.model = e.model;
      const t: SetupTurn = { at: e.at, from: 'you', text: e.text ?? '', ...(e.model ? { model: e.model } : {}), ...(e.type === 'revised' ? { revise: true } : {}) };
      c.turns.push(t);
    } else if (e.type === 'answered') {
      c.turns.push({ at: e.at, from: 'model', text: e.text ?? '', ...(e.model ? { model: e.model } : {}), ...(e.proposal ? { proposal: e.proposal } : {}), ...(e.problems?.length ? { problems: e.problems } : {}) });
    } else if (e.type === 'accepted') {
      c.status = 'accepted';
      if (e.advisor) c.advisor = e.advisor;
    } else if (e.type === 'discarded') {
      c.status = 'discarded';
    }
  }
  const last = c.turns[c.turns.length - 1];
  if (last?.from === 'model' && last.proposal && c.status !== 'discarded') c.proposal = { turn: c.turns.length - 1, spec: last.proposal };
  return c;
}
