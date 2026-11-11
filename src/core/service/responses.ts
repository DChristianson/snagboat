import * as fs from 'fs';
import * as path from 'path';
import { Finding } from '../../heuristics/types';
import { ResponseEpisode, ResponseLog, ResponseTracker } from '../../heuristics/responses';

/**
 * How you met a workspace's findings, kept by the core (RFC step 5a): what you
 * marked useful or acknowledged in this episode of a heuristic, and what you
 * muted. Any front door responds through the core (the advisor UI, a VS Code
 * window that's its client, the Claude Code plugin), so none depends on
 * another. Each episode is written to the workspace's finding-responses.jsonl
 * when it ends, and reported to onEnded for its outcome, as a VS Code window
 * writing its own folder does. Mutes last until unmuted, in
 * finding-state.json beside it.
 */

export type Response = 'useful' | 'acknowledge' | 'mute' | 'unmute';

export interface FindingState {
  acknowledged: boolean;
  useful: boolean;
  muted: boolean;
}

const STATE_FILE = 'finding-state.json';

export class ResponseBook {
  private readonly tracker: ResponseTracker;
  private readonly log: ResponseLog;
  private readonly acknowledged = new Set<string>();
  private readonly useful = new Set<string>();
  private readonly muted = new Set<string>();
  /** Heuristics with findings now. */
  private active = new Set<string>();

  constructor(private readonly storeDir: string, onEnded: (episode: ResponseEpisode, refs: string[]) => void) {
    this.log = new ResponseLog(storeDir);
    this.tracker = new ResponseTracker((episode, refs) => {
      this.log.append(episode);
      onEnded(episode, refs);
    });
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(storeDir, STATE_FILE), 'utf8')) as { muted?: unknown };
      if (Array.isArray(saved.muted)) for (const id of saved.muted) if (typeof id === 'string') this.muted.add(id);
    } catch {
      // nothing muted yet
    }
  }

  /** This evaluation's findings: episodes start and end, and an episode's acknowledgement ends with it. */
  update(findings: Finding[]): void {
    const byId = new Map<string, Finding[]>();
    for (const f of findings) byId.set(f.heuristicId, [...(byId.get(f.heuristicId) ?? []), f]);
    for (const id of new Set([...this.active, ...byId.keys()])) {
      const list = byId.get(id) ?? [];
      this.tracker.reported(id, list);
      // A muted heuristic's episode is never seen: muted from the start, not left to pass.
      if (list.length > 0 && this.muted.has(id)) this.tracker.muted(id, true);
      if (list.length === 0) {
        this.acknowledged.delete(id);
        this.useful.delete(id);
      }
    }
    this.active = new Set(byId.keys());
  }

  /** A response from any front door. Useful also acknowledges; acknowledging needs an active finding. */
  respond(heuristicId: string, response: Response): FindingState {
    if (response === 'useful' && this.active.has(heuristicId)) {
      this.useful.add(heuristicId);
      this.tracker.useful(heuristicId);
      this.acknowledged.add(heuristicId);
      this.tracker.acknowledged(heuristicId);
    } else if (response === 'acknowledge' && this.active.has(heuristicId)) {
      this.acknowledged.add(heuristicId);
      this.tracker.acknowledged(heuristicId);
    } else if (response === 'mute' || response === 'unmute') {
      const muted = response === 'mute';
      if (muted) this.muted.add(heuristicId);
      else this.muted.delete(heuristicId);
      this.tracker.muted(heuristicId, muted);
      this.saveMuted();
    }
    return this.state(heuristicId);
  }

  state(heuristicId: string): FindingState {
    return { acknowledged: this.acknowledged.has(heuristicId), useful: this.useful.has(heuristicId), muted: this.muted.has(heuristicId) };
  }

  /** States for the heuristics with findings now, and every muted one. */
  states(): Record<string, FindingState> {
    const out: Record<string, FindingState> = {};
    for (const id of new Set([...this.active, ...this.muted])) out[id] = this.state(id);
    return out;
  }

  mutedHeuristics(): string[] {
    return [...this.muted].sort();
  }

  /** The episodes written so far (after any still being written). */
  episodes(): Promise<ResponseEpisode[]> {
    return this.log.readAll();
  }

  /** Writes the episodes still open (the core is stopping), without ending them. */
  close(): void {
    const open = this.tracker.drain();
    if (open.length > 0) this.log.appendNow(open);
  }

  private saveMuted(): void {
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });
      const file = path.join(this.storeDir, STATE_FILE);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ muted: this.mutedHeuristics() }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {
      // kept in memory; written again with the next change
    }
  }
}
